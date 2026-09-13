const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const digests = require('../digest.cjs');
const dayLog = require('../day-log.cjs');
const { tick } = require('../scheduler-core.cjs');
const root = path.resolve(__dirname, '..');
const date = '2026-09-14';
const plan = { timezone: 'UTC', days: [], schedule: [], meals: [{ time: '18:30' }], macros: { calories: 2000, protein: 150, carbs: 200, fat: 60 } };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macrome-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { file: path.join(dir, 'digests.json'), dayLogFile: path.join(dir, 'log.json'), queueFile: path.join(dir, 'queue.json'), now: new Date(`${date}T21:00:00Z`) };
  const config = path.join(dir, 'plan.json');
  fs.writeFileSync(config, JSON.stringify(plan));
  let mails = 0;
  const bound = {
    ...digests,
    today: () => date,
    getDigest: (day) => digests.getDigest(day, options.file),
    listDigests: (_, limit) => digests.listDigests(options.file, limit),
    generateDigest: (p, day) => digests.generateDigest(p, day, options),
  };
  const sandbox = {
    __dirname: root,
    console: { log() {}, error() {} },
    process: { env: { MACROME_CONFIG: config, MACROME_NO_CRON: '1' }, pid: process.pid },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './digest.cjs') return bound;
      if (name === './day-log.cjs') return { ...dayLog, entriesForDate: (day) => dayLog.entriesForDate(day, options.dayLogFile) };
      if (name === './digest-email.cjs') return { ...require('../digest-email.cjs'), configured: () => false, sendDigest: async () => { mails++; return { sent: false, reason: 'Email unset' }; } };
      return require(name.startsWith('./') ? path.join(root, name) : name);
    },
  };
  return { options, sandbox, add: (status) => dayLog.appendEntry({ date, status, meal: 'Lunch' }, options.dayLogFile, options.now), get mails() { return mails; } };
}

function web(f) {
  let handler;
  const base = f.sandbox.require;
  const sandbox = { ...f.sandbox, require: (name) => name === 'http' ? { createServer: (callback) => { handler = callback; return { listen() {} }; } } : base(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return async (method, url, body = {}) => {
    const req = new EventEmitter();
    Object.assign(req, { method, url });
    let status, result;
    const res = { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } };
    const pending = handler(req, res);
    req.emit('data', JSON.stringify(body)); req.emit('end');
    await pending;
    return { status, body: result };
  };
}

function mcp(f) {
  const handlers = {};
  const base = f.sandbox.require;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mcp-server.cjs'), 'utf8'), {
    ...f.sandbox,
    require(name) {
      if (name === '@modelcontextprotocol/sdk/server/mcp.js') return { McpServer: class {
        registerTool(name, definition, handler) { handlers[name] = handler; }
        async connect() {}
      } };
      if (name === '@modelcontextprotocol/sdk/server/stdio.js') return { StdioServerTransport: class {} };
      return base(name);
    },
  });
  return handlers;
}

test('empty or non-outcome days cannot be finalized or caught up', (t) => {
  const f = fixture(t);
  for (const entries of [[], [{ date, status: 'pending' }]]) {
    fs.writeFileSync(f.options.dayLogFile, JSON.stringify({ entries }));
    assert.throws(() => digests.generateDigest(plan, date, f.options), { code: 'EMPTY_DAY_LOG', message: `Nothing logged for ${date} yet — no digest to save.` });
    assert.deepEqual(digests.ensureDigests(plan, f.options.now, f.options), []);
    assert.equal(fs.existsSync(f.options.file), false);
  }
});

for (const status of dayLog.STATUSES) {
  test(`${status} counts as activity; Final is saved once and survives log removal`, (t) => {
    const f = fixture(t);
    f.add(status);
    const first = digests.generateDigest(plan, date, f.options);
    assert.equal(first.counts[status], 1);
    const bytes = fs.readFileSync(f.options.file, 'utf8');
    fs.unlinkSync(f.options.dayLogFile);
    assert.deepEqual(digests.generateDigest(plan, date, f.options), first);
    assert.equal(fs.readFileSync(f.options.file, 'utf8'), bytes);
  });
}

test('API empty read stays live; empty finalize is 422 with no file, email or toast', async (t) => {
  const f = fixture(t);
  const request = web(f);
  const live = await request('GET', '/api/digests');
  assert.equal(live.body.final, false);
  assert.equal(live.body.today.meals.length, 0);
  assert.equal(live.body.today.totals.calories, 0);
  const result = await request('POST', '/api/digests', { email: true });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /Nothing logged for 2026-09-14 yet/);
  assert.equal(fs.existsSync(f.options.file), false);
  assert.equal(f.mails, 0);
  const run = await request('GET', '/api/run');
  assert.equal(run.body.notifications.length, 0);
});

test('API finalizes once and does not repeat its ready toast', async (t) => {
  const f = fixture(t);
  const request = web(f);
  f.add('placed');
  const first = await request('POST', '/api/digests');
  assert.equal(first.status, 200);
  assert.deepEqual((await request('POST', '/api/digests')).body, first.body);
  assert.equal((await request('GET', '/api/digests')).body.final, true);
  assert.equal((await request('GET', '/api/run')).body.notifications.length, 1);
  assert.equal(f.mails, 0);
});

test('automatic EOD saves an active day without POST, MCP or email', async (t) => {
  const f = fixture(t);
  const request = web(f);
  const args = { ...f.options, plan, runOrder: () => assert.fail('No order due') };
  assert.deepEqual((await tick(args)).digests, []);
  f.add('missed');
  assert.equal((await tick(args)).digests.length, 1);
  assert.equal((await web(f)('GET', '/api/digests')).body.final, true, 'Final survives server restart');
  assert.deepEqual((await tick(args)).digests, []);
  assert.equal((await request('GET', '/api/digests')).body.today.counts.missed, 1);
  assert.equal(f.mails, 0);
});

test('MCP empty summary is live and read-only; empty send errors without sending', async (t) => {
  const f = fixture(t);
  const tools = mcp(f);
  const summary = await tools.get_today_summary({});
  assert.ok(!summary.isError);
  assert.match(summary.content[0].text, /Live summary, still in progress — not Final/);
  assert.match(summary.content[0].text, /0 of 0 meals ordered/);
  const send = await tools.send_eod_digest({});
  assert.equal(send.isError, true);
  assert.match(send.content[0].text, /Nothing logged for 2026-09-14 yet/);
  assert.equal(fs.existsSync(f.options.file), false);
  assert.equal(f.mails, 0);
});

test('MCP send saves an active day and later reads and sends reuse the saved Final', async (t) => {
  const f = fixture(t);
  const tools = mcp(f);
  f.add('declined');
  assert.ok(!(await tools.send_eod_digest({})).isError);
  const bytes = fs.readFileSync(f.options.file, 'utf8');
  fs.unlinkSync(f.options.dayLogFile);
  assert.match((await tools.get_today_summary({})).content[0].text, /saved Final end-of-day digest/);
  assert.ok(!(await tools.send_eod_digest({})).isError);
  assert.equal(fs.readFileSync(f.options.file, 'utf8'), bytes);
  assert.equal(f.mails, 2, 'existing receipt logic remains responsible for deduplicating email');
  assert.match((await tools.list_digests({})).content[0].text, /2026-09-14/);
});

test('dashboard only enables early finalization for a live day with activity', (t) => {
  const elements = new Map();
  const sandbox = { document: { querySelector: (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        addEventListener() {},
        setAttribute() {},
        textContent: '',
        disabled: false,
        hidden: false,
        title: '',
        className: '',
      });
    }
    return elements.get(selector);
  } } };
  const source = fs.readFileSync(path.join(root, 'ui/dashboard.js'), 'utf8').split('(async function init()')[0];
  vm.runInNewContext(source, sandbox);
  const payload = { date, digestTime: '20:00', final: false, history: [], today: digests.buildDigest(plan, date, []) };
  sandbox.renderDigests(payload);
  assert.equal(elements.get('#summarise').disabled, true);
  assert.equal(elements.get('#summarise').hidden, false);
  assert.match(elements.get('#todayTag').textContent, /^Live/);
  assert.match(elements.get('#finalizeHelp').textContent, /nothing logged/i);
  payload.today = digests.buildDigest(plan, date, [{ status: 'failed', meal: 'Lunch' }]);
  sandbox.renderDigests(payload);
  assert.equal(elements.get('#summarise').disabled, false);
  assert.equal(elements.get('#summarise').hidden, false);
  payload.final = true;
  sandbox.renderDigests(payload);
  assert.equal(elements.get('#summarise').disabled, true);
  assert.equal(elements.get('#summarise').hidden, true);
  assert.equal(elements.get('#todayTag').textContent, 'Final');
});
