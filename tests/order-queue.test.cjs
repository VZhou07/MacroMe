const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const queue = require('../order-queue.cjs');

const plan = {
  timezone: 'America/Toronto', days: ['sat', 'sun'], orderLeadMinutes: 45,
  schedule: [
    { day: 'sat', meal: 'Dinner', time: '19:00', addressId: 'home' },
    { day: 'sat', meal: 'Breakfast', time: '08:00', addressId: 'home' },
    { day: 'sun', meal: 'Lunch', time: '12:00', addressId: 'office' },
  ],
};

test('sorts dated occurrences and consumes only the completed occurrence', () => {
  const now = new Date('2026-09-12T10:00:00Z');
  const orders = queue.upcomingOrders(plan, new Set(), now);
  assert.equal(orders[0].meal, 'Breakfast');
  assert.equal(orders[0].orderAt, '2026-09-12T11:15:00.000Z');
  const pending = queue.upcomingOrders(plan, new Set([orders[0].id]), now);
  assert.equal(pending[0].meal, 'Dinner');
  assert.ok(pending.some((order) => order.meal === 'Breakfast' && order.eatAt.startsWith('2026-09-19')));
});

test('honors timezone, DST and lead times crossing midnight', () => {
  const midnight = { ...plan, days: ['sun'], schedule: [{ day: 'sun', meal: 'Late meal', time: '00:15', orderAt: '23:30', addressId: 'home' }] };
  const order = queue.upcomingOrders(midnight, new Set(), new Date('2026-09-13T02:00:00Z'))[0];
  assert.equal(order.orderAt, '2026-09-13T03:30:00.000Z');
  assert.equal(order.eatAt, '2026-09-13T04:15:00.000Z');
  const winter = queue.upcomingOrders(plan, new Set(), new Date('2026-11-07T10:00:00Z'))[0];
  assert.equal(winter.orderAt, '2026-11-07T12:15:00.000Z');
  assert.deepEqual(queue.upcomingOrders({ ...plan, schedule: [] }, new Set()), []);
});

test('Run now uses the queue; failures stay queued; success persists across server restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macrome-queue-test-'));
  const configFile = path.join(dir, 'plan.json');
  const stateFile = path.join(dir, 'queue.json');
  const config = { ...plan, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], schedule: [] };
  for (const day of config.days) config.schedule.push({ day, meal: 'Lunch', time: '12:00', addressId: 'home' });
  fs.writeFileSync(configFile, JSON.stringify(config));
  function server() {
    let child;
    let args;
    const sandbox = {
      __dirname: path.resolve(__dirname, '..'), console: { log() {} },
      process: { env: { MACROME_CONFIG: configFile } },
      require(name) {
        if (name === 'http') return { createServer: () => ({ listen() {} }) };
        if (name === 'child_process') return { spawn(command, argv) {
          args = argv;
          child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = { write() {} }; return child;
        } };
        if (name === './order-queue.cjs') return {
          upcomingOrders: (p) => queue.upcomingOrders(p, queue.readCompleted(stateFile)),
          markCompleted: (id) => queue.markCompleted(id, stateFile),
        };
        return require(name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8') + '\nglobalThis.api = { routes, handleEvent };', sandbox);
    return {
      async request(route, body = {}) {
        const req = new EventEmitter();
        let result;
        const res = { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, body: JSON.parse(text) }; } };
        const pending = sandbox.api.routes[route](req, res);
        req.emit('data', JSON.stringify(body)); req.emit('end');
        await pending;
        return result;
      },
      finish(placed) { sandbox.api.handleEvent({ type: 'result', placed, message: 'test' }); child.emit('close', 0); },
      get args() { return args; },
    };
  }
  try {
    const app = server();
    const original = (await app.request('GET /api/run')).body.upcoming[0];
    const started = await app.request('POST /api/run', { meal: 'Dinner' });
    assert.equal(started.body.scheduledOrder.id, original.id);
    assert.equal(started.body.meal, 'Lunch');
    assert.ok(app.args.includes('--scheduled-for'));
    assert.equal((await app.request('POST /api/run')).status, 409);
    app.finish(false);
    assert.equal((await app.request('GET /api/run')).body.upcoming[0].id, original.id);
    await app.request('POST /api/run');
    app.finish(true);
    assert.notEqual((await app.request('GET /api/run')).body.upcoming[0].id, original.id);
    const restarted = server();
    assert.notEqual((await restarted.request('GET /api/run')).body.upcoming[0].id, original.id);
    assert.equal(queue.readCompleted(stateFile).size, 1);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
