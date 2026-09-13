const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../order-queue.cjs');
const dayLog = require('../day-log.cjs');
const digest = require('../digest.cjs');
const { tick, OFFLINE_NOTE, BUSY_NOTE } = require('../scheduler-core.cjs');

const MEALS = [
  { name: 'Breakfast', time: '08:00', orderAt: '07:15' },
  { name: 'Lunch', time: '12:30', orderAt: '11:45' },
  { name: 'Dinner', time: '18:30', orderAt: '17:45' },
];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const plan = {
  timezone: 'America/Toronto',
  days: WEEKDAYS,
  macros: { calories: 3000, protein: 150, carbs: 300, fat: 80 },
  meals: MEALS,
  schedule: WEEKDAYS.flatMap((day) => MEALS.map((meal) => ({ day, meal: meal.name, time: meal.time, orderAt: meal.orderAt, addressId: 'home' }))),
};

// Monday 14 September 2026, in EDT: breakfast orders at 11:15Z, lunch at 15:45Z.
const files = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macrome-tick-'));
  return {
    dir,
    queueFile: path.join(dir, 'queue.json'),
    dayLogFile: path.join(dir, 'day-log.json'),
    file: path.join(dir, 'digests.json'),
  };
};
const run = (opts, now, runOrder = () => {}, canRun) =>
  tick({ ...opts, plan, now: new Date(now), runOrder, canRun });

test('a gap while the machine was off becomes missed, not a late order', async (t) => {
  const opts = files();
  t.after(() => fs.rmSync(opts.dir, { recursive: true }));
  const fired = [];

  // First ever tick: nothing before it is known, so nothing is blamed on it.
  const first = await run(opts, '2026-09-14T11:00:00Z', (o) => fired.push(o));
  assert.deepEqual(first.missed, []);
  assert.equal(queue.readState(opts.queueFile).lastSeenAt, '2026-09-14T11:00:00.000Z');

  // Laptop shut between 11:00Z and 16:00Z — breakfast (11:15Z) and lunch (15:45Z) passed.
  const result = await run(opts, '2026-09-14T16:00:00Z', (o) => fired.push(o));
  assert.deepEqual(result.missed.map((entry) => entry.meal), ['Breakfast', 'Lunch']);
  assert.deepEqual(fired, [], 'missed slots are never ordered late');
  assert.equal(result.missed[0].note, OFFLINE_NOTE);
  assert.equal(result.missed[0].date, '2026-09-14');
  assert.equal(queue.readState(opts.queueFile).missed.size, 2);

  // They are recorded once, stay out of the upcoming list, and survive a restart.
  const again = await run(opts, '2026-09-14T16:01:00Z', (o) => fired.push(o));
  assert.deepEqual(again.missed, []);
  assert.equal(dayLog.readEntries(opts.dayLogFile).length, 2);
  const upcoming = queue.upcomingOrders(plan, queue.readCompleted(opts.queueFile), new Date('2026-09-14T16:01:00Z'));
  assert.equal(upcoming[0].meal, 'Dinner');
  assert.ok(!upcoming.some((order) => order.eatAt.startsWith('2026-09-14T12')), 'the missed lunch is gone');
});

test('a due minute fires once, and an attempted slot is never called missed', async (t) => {
  const opts = files();
  t.after(() => fs.rmSync(opts.dir, { recursive: true }));
  const fired = [];
  await run(opts, '2026-09-14T15:44:00Z', (o) => fired.push(o));

  const due = await run(opts, '2026-09-14T15:45:30Z', (o) => fired.push(o));
  assert.deepEqual(due.fired.map((o) => o.meal), ['Lunch']);
  assert.equal(fired.length, 1);
  assert.ok(queue.readState(opts.queueFile).attempted.has(fired[0].id));

  // The run is declined, so it is never completed — but it was attempted, and a
  // slot someone actually looked at must not turn into "missed" a minute later.
  const after = await run(opts, '2026-09-14T15:46:00Z', (o) => fired.push(o));
  assert.deepEqual(after.missed, []);
  assert.equal(fired.length, 1);
});

test('a slot that comes due while another order is running is recorded, not queued up', async (t) => {
  const opts = files();
  t.after(() => fs.rmSync(opts.dir, { recursive: true }));
  const fired = [];
  await run(opts, '2026-09-14T15:44:00Z', (o) => fired.push(o));
  const result = await run(opts, '2026-09-14T15:45:00Z', (o) => fired.push(o), () => false);
  assert.deepEqual(fired, []);
  assert.equal(result.missed[0].note, BUSY_NOTE);
  assert.equal(result.missed[0].meal, 'Lunch');
});

test('the digest is written once the day is over, and only once', async (t) => {
  const opts = files();
  t.after(() => fs.rmSync(opts.dir, { recursive: true }));
  dayLog.appendEntry({
    id: 'a', meal: 'Lunch', status: 'placed', eatAt: '2026-09-14T16:30:00Z', timezone: plan.timezone,
    pick: { item: 'Chicken bowl', restaurant: 'Kitchen', price: 14, macros: { calories: 900, protein: 60, carbs: 90, fat: 20 } },
    checkoutTotal: 'CA$21.40',
  }, opts.dayLogFile);

  // Digest time is the last meal (18:30) plus the buffer, so 20:00 local.
  assert.equal(digest.digestTime(plan), '20:00');
  const early = await run(opts, '2026-09-14T22:00:00Z');
  assert.deepEqual(early.digests, []);

  const late = await run(opts, '2026-09-15T00:30:00Z');
  const written = late.digests.find((entry) => entry.date === '2026-09-14');
  assert.ok(written, 'the digest lands after the end-of-day time');
  assert.equal(written.counts.placed, 1);
  assert.equal(written.totals.calories, 900);
  assert.equal(written.spend.amount, 21.4);
  assert.equal(written.spend.currency, 'CA$');
  assert.match(written.summary, /900 of 3,000 kcal/);

  const repeat = await run(opts, '2026-09-15T00:31:00Z');
  assert.ok(!repeat.digests.some((entry) => entry.date === '2026-09-14'), 'a written day is not rewritten');
  assert.equal(digest.getDigest('2026-09-14', opts.file).generatedAt, written.generatedAt);
  assert.equal(digest.listDigests(opts.file).length, Object.keys(digest.readDigests(opts.file)).length);
});
