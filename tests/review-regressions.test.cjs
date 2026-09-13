const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../order-queue.cjs');
const digest = require('../digest.cjs');
const dayLog = require('../day-log.cjs');
const email = require('../digest-email.cjs');
const { tick } = require('../scheduler-core.cjs');

const plan = {
  timezone: 'America/Toronto', days: ['mon'],
  meals: [{ time: '18:30' }],
  schedule: [{ day: 'mon', meal: 'Dinner', time: '18:30', orderAt: '17:45', addressId: 'home' }],
};
function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macrome-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { queueFile: path.join(dir, 'queue.json'), dayLogFile: path.join(dir, 'log.json'), file: path.join(dir, 'digests.json') };
}

test('restart in the trigger minute cannot repeat an attempted or missed meal', async (t) => {
  const options = files(t);
  let fired = 0;
  const args = { ...options, plan, now: new Date('2026-09-14T21:45:30Z'), runOrder: () => fired++ };
  await tick(args);
  await tick(args);
  assert.equal(fired, 1);
  const state = queue.readState(options.queueFile);
  state.missed = new Set(state.attempted);
  state.attempted.clear();
  queue.writeState(state, options.queueFile);
  await tick(args);
  assert.equal(fired, 1);
});

test('first boot records elapsed slots today without ordering them', async (t) => {
  const options = files(t);
  const result = await tick({ ...options, plan, now: new Date('2026-09-14T23:00:00Z'), runOrder: () => assert.fail('late order') });
  assert.equal(result.missed.length, 1);
  assert.equal(result.missed[0].date, '2026-09-14');
  assert.equal(queue.readState(options.queueFile).missed.size, 1);
});

test('digest uses the dated schedule and keeps the buffer across midnight', () => {
  const late = { ...plan, schedule: [{ ...plan.schedule[0], time: '23:30' }] };
  assert.equal(digest.digestDueAt(late, '2026-09-14').toISOString(), '2026-09-15T05:00:00.000Z');
  assert.equal(digest.digestTime(late, '2026-09-14'), '01:00');
});

test('repeated manual generation preserves the saved digest', (t) => {
  const options = files(t);
  dayLog.appendEntry({ date: '2026-09-14', meal: 'Lunch', status: 'placed' }, options.dayLogFile);
  const first = digest.generateDigest(plan, '2026-09-14', options);
  dayLog.appendEntry({ date: '2026-09-14', meal: 'Dinner', status: 'placed' }, options.dayLogFile);
  assert.deepEqual(digest.generateDigest(plan, '2026-09-14', options), first);
});

test('concurrent email calls and later restarts send a date only once', async (t) => {
  const options = files(t);
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ id: 'test' }) }; };
  const saved = digest.buildDigest(plan, '2026-09-14', [{ meal: 'Lunch', status: 'placed' }]);
  const sending = { file: options.file, to: 'test@example.com', apiKey: 'fake' };
  const results = await Promise.all([email.sendDigest(saved, sending), email.sendDigest(saved, sending)]);
  assert.equal(results.filter((r) => r.sent).length, 1);
  assert.equal((await email.sendDigest(saved, sending)).sent, false);
  assert.equal(calls, 1);
});

test('a live scheduler cannot lose its lock just because its heartbeat was delayed', (t) => {
  const options = files(t);
  const lock = require('../scheduler-lock.cjs');
  const file = `${options.file}.lock`;
  assert.equal(lock.acquire('test', file, Date.now() - 300000), true);
  assert.equal(lock.holder(file).pid, process.pid);
  lock.release(file);
});
