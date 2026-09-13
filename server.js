// MacroMe web server.
//
// Three jobs:
//   1. Onboarding — serve the setup wizard and save the plan to macrome-config.json.
//   2. Dashboard  — once a plan exists, run the DoorDash agent on demand, stream
//      its progress, embed its live browser view, and collect the order approval.
//   3. The clock  — run the minute cron in this process, so leaving this page
//      open is all it takes for scheduled meals to fire, missed slots to be
//      recorded and the end-of-day digest to be written.
//
// Run: npm run dev  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: [path.join(__dirname, '.env'), path.join(__dirname, 'doordash-macro-agent/.env')], quiet: true });
const { spawn } = require('child_process');
const { upcomingOrders, markCompleted, markAttempted } = require('./order-queue.cjs');
const dayLog = require('./day-log.cjs');
const digests = require('./digest.cjs');
const { startTicker } = require('./scheduler-core.cjs');
const { sendDigest, configured: emailConfigured } = require('./digest-email.cjs');

const PORT = process.env.PORT || 3000;
const UI_DIR = path.join(__dirname, 'ui');
const CONFIG_PATH = process.env.MACROME_CONFIG || path.join(__dirname, 'macrome-config.json');
const AGENT_DIR = path.join(__dirname, 'doordash-macro-agent');
const EVENT_PREFIX = '@@MACROME ';
const MAX_LOG_LINES = 300;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const hasPlan = () => fs.existsSync(CONFIG_PATH);
const readPlan = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- notifications ----------
// Small, in-memory and deliberately not persisted: these are "something just
// happened" nudges for an open dashboard. Anything worth keeping is already in
// the day log or a digest. The boot id lets a reconnecting page tell a restarted
// server's numbering apart from its own backlog.
const BOOT_ID = Date.now().toString(36);
const NOTIFICATION_LIMIT = 50;
const notifications = [];
let notificationCount = 0;

function notify(kind, title, body = null) {
  const note = { id: `${BOOT_ID}-${++notificationCount}`, at: new Date().toISOString(), kind, title, body };
  notifications.push(note);
  if (notifications.length > NOTIFICATION_LIMIT) notifications.shift();
  console.log(`[notify] ${title}${body ? ` — ${body}` : ''}`);
  return note;
}

// ---------- agent run state ----------
// One run at a time: each run drives a real browser and a real cart, so
// overlapping runs would fight over the same DoorDash session.
let run = null;
let child = null;

function newRun(meal) {
  return {
    id: Date.now().toString(36),
    meal,
    status: 'starting', // starting | running | awaiting-approval | placing | done | error | cancelled
    statusMessage: 'Starting the agent…',
    liveViewUrl: null,
    dashboardUrl: null,
    sessionId: null,
    picks: [],
    approval: null,   // the order awaiting a decision
    result: null,     // { placed, message }
    error: null,
    log: [],
    startedAt: new Date().toISOString(),
  };
}

function log(line) {
  if (!run || !line.trim()) return;
  run.log.push({ at: new Date().toISOString(), line: line.replace(/\s+$/, '') });
  if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
}

function handleEvent(event) {
  if (!run) return;
  switch (event.type) {
    case 'status':
      run.status = 'running';
      run.statusMessage = event.message;
      log(event.message);
      break;
    case 'live-view':
      run.liveViewUrl = event.url;
      run.dashboardUrl = event.dashboardUrl || null;
      run.sessionId = event.sessionId;
      run.status = 'running';
      break;
    case 'picked':
      run.picks.push(event);
      break;
    case 'approval-request':
      run.approval = event;
      run.status = 'awaiting-approval';
      break;
    case 'result':
      run.result = { placed: event.placed, message: event.message };
      run.approval = null;
      run.status = 'done';
      if (event.placed && run.scheduledOrder) {
        try {
          markCompleted(run.scheduledOrder.id);
        } catch (err) {
          run.error = `Order was placed, but saving queue completion failed: ${err.message}. Do not retry this order.`;
          log(run.error);
        }
      }
      if (event.placed && hasPlan()) {
        try {
          for (const digest of digests.ensureDigests(readPlan())) {
            notify('digest', `Your ${digest.date} digest is ready`, digest.summary);
            mailDigest(digest);
          }
        } catch (err) {
          log(`Digest check after place failed: ${err.message}`);
        }
      }
      notify(event.placed ? 'order-placed' : 'order-skipped',
        `${run.meal}: ${event.placed ? 'order placed' : 'no order placed'}`, event.message);
      break;
    case 'error':
      run.error = event.message;
      run.status = 'error';
      notify('run-error', `${run.meal}: the run stopped`, event.message);
      break;
  }
}

function startRun(scheduledOrder) {
  if (scheduledOrder.id) markAttempted(scheduledOrder.id);
  run = newRun(scheduledOrder.meal);
  run.scheduledOrder = scheduledOrder;
  const tsx = path.join(AGENT_DIR, 'node_modules', '.bin', 'tsx');
  const args = ['src/agent.ts', '--web'];
  args.push('--meal', scheduledOrder.meal, '--scheduled-for', scheduledOrder.eatAt);
  // The agent writes its own day-log row, so it needs to know which queue
  // occurrence this run belongs to.
  if (scheduledOrder.id) args.push('--occurrence', scheduledOrder.id);
  if (process.env.MACROME_DRY_RUN) args.push('--dry-run');

  child = spawn(fs.existsSync(tsx) ? tsx : 'npx', fs.existsSync(tsx) ? args : ['tsx', ...args], {
    cwd: AGENT_DIR,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Events and human-readable logs share stdout, so split on lines and pick out
  // the prefixed ones.
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith(EVENT_PREFIX)) {
        try { handleEvent(JSON.parse(line.slice(EVENT_PREFIX.length))); }
        catch { log(line); }
      } else {
        log(line);
      }
    }
  });
  child.stderr.on('data', (chunk) => chunk.toString().split('\n').forEach(log));

  child.on('error', (err) => {
    if (!run) return;
    run.status = 'error';
    run.error = `Could not start the agent: ${err.message}`;
  });

  child.on('close', (code) => {
    child = null;
    if (!run) return;
    if (run.status === 'placing' || run.status === 'awaiting-approval' || run.status === 'running' || run.status === 'starting') {
      // The process ended without reporting an outcome — surface that rather
      // than leaving the dashboard spinning forever.
      run.status = code === 0 ? 'done' : 'error';
      if (code !== 0 && !run.error) run.error = `The agent exited with code ${code}. Check the log below.`;
      run.approval = null;
    }
  });

  return run;
}

// ---------- the clock ----------
function mailDigest(digest) {
  sendDigest(digest).then((result) => {
    if (result.sent) return notify('digest-email', `Digest for ${digest.date} emailed`, process.env.DIGEST_EMAIL);
    if (emailConfigured()) notify('digest-email', `Could not email the ${digest.date} digest`, result.reason);
  });
}

/**
 * Fire scheduled meals from this process.
 *
 * The scheduler lock means running `npm run schedule` as well is harmless —
 * whichever starts first owns the queue — and MACROME_NO_CRON=1 opts this
 * process out entirely.
 */
function startClock() {
  if (process.env.MACROME_NO_CRON) {
    console.log('MACROME_NO_CRON is set — this process will not fire scheduled meals. Run `npm run schedule` for that.');
    return null;
  }
  return startTicker({
    owner: 'npm run dev',
    loadPlan: () => (hasPlan() ? readPlan() : null),
    // One run at a time: a second one would fight the first over the same cart.
    canRun: () => !child,
    runOrder: (occurrence) => {
      console.log(`[scheduler] Firing ${occurrence.meal} for ${occurrence.eatAt}`);
      startRun(occurrence);
      notify('run-started', `Ordering ${occurrence.meal}`, 'Approve the cart in the dashboard before anything is charged.');
    },
    onTick: (result) => {
      if (result.missed.length) {
        notify('missed', `${result.missed.length} meal${result.missed.length === 1 ? '' : 's'} missed`,
          result.missed.map((entry) => `${entry.meal} on ${entry.date}`).join(', '));
      }
      for (const digest of result.digests) {
        notify('digest', `Your ${digest.date} digest is ready`, digest.summary);
        mailDigest(digest);
      }
    },
    onError: (err) => console.error('[scheduler]', err && err.message ? err.message : err),
  });
}

// ---------- routes ----------
const routes = {
  'GET /api/config': (req, res) => {
    if (!hasPlan()) return sendJson(res, 404, { error: 'No plan saved yet' });
    sendJson(res, 200, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  },

  'POST /api/config': async (req, res) => {
    const config = await readBody(req);
    const required = ['macros', 'meals', 'budget', 'days', 'addresses', 'schedule', 'preferences'];
    const missing = required.filter((k) => !config[k]);
    if (missing.length) return sendJson(res, 400, { error: `Config is missing: ${missing.join(', ')}` });
    if (!Array.isArray(config.meals) || !config.meals.length) return sendJson(res, 400, { error: 'Config needs at least one meal' });
    if (!Array.isArray(config.addresses) || !config.addresses.length) return sendJson(res, 400, { error: 'Config needs at least one address' });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`Saved plan → ${CONFIG_PATH}`);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/run': async (req, res) => {
    if (!hasPlan()) return sendJson(res, 400, { error: 'Finish the setup first.' });
    if (child) return sendJson(res, 409, { error: 'A run is already in progress.' });
    await readBody(req);
    if (child) return sendJson(res, 409, { error: 'A run is already in progress.' });
    const next = upcomingOrders(readPlan())[0];
    if (!next) return sendJson(res, 409, { error: 'No upcoming orders in the next two weeks.' });
    sendJson(res, 200, startRun(next));
  },

  'GET /api/run': (req, res) => sendJson(res, 200, {
    ...(run || { status: 'idle' }),
    upcoming: hasPlan() ? upcomingOrders(readPlan()) : [],
    boot: BOOT_ID,
    notifications,
  }),

  // Today plus every saved end-of-day summary. Before the digest is due, today
  // is built on the fly from the day log so the page isn't blank all day; once
  // it is written, `final` flips and the saved copy is served instead.
  'GET /api/digests': (req, res) => {
    if (!hasPlan()) return sendJson(res, 404, { error: 'No plan saved yet' });
    const plan = readPlan();
    const date = digests.today(plan);
    const saved = digests.getDigest(date);
    const dueAt = digests.digestDueAt(plan, date);
    sendJson(res, 200, {
      date,
      timezone: plan.timezone || 'UTC',
      digestTime: digests.digestTime(plan, date),
      dueAt: dueAt ? dueAt.toISOString() : null,
      final: Boolean(saved),
      today: saved || digests.buildDigest(plan, date, dayLog.entriesForDate(date)),
      history: digests.listDigests().filter((digest) => digest.date !== date),
      emailConfigured: emailConfigured(),
    });
  },

  // Write a date's digest now instead of waiting for its end-of-day time —
  // optional early finalization; ordinary summary reads never save a Final.
  'POST /api/digests': async (req, res) => {
    if (!hasPlan()) return sendJson(res, 400, { error: 'Finish the setup first.' });
    const body = await readBody(req);
    const plan = readPlan();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : digests.today(plan);
    const saved = digests.getDigest(date);
    let digest;
    try {
      digest = saved || digests.generateDigest(plan, date);
    } catch (err) {
      if (err.code === 'EMPTY_DAY_LOG') return sendJson(res, 422, { error: err.message });
      throw err;
    }
    if (!saved) notify('digest', `Final digest ready for ${digest.date}`, digest.summary);
    if (body.email) mailDigest(digest);
    sendJson(res, 200, digest);
  },

  'POST /api/run/approve': async (req, res) => {
    if (!run || run.status !== 'awaiting-approval' || !child) {
      return sendJson(res, 409, { error: 'Nothing is waiting for approval.' });
    }
    const approvingRun = run;
    const approvingChild = child;
    const { approve } = await readBody(req);
    if (run !== approvingRun || child !== approvingChild || !child || run.status !== 'awaiting-approval') {
      return sendJson(res, 409, { error: 'This approval is no longer pending.' });
    }
    if (typeof approve !== 'boolean') return sendJson(res, 400, { error: '`approve` must be true or false' });
    if (approve && (!run.approval?.cartItems?.length || !run.approval.checkoutTotal)) {
      return sendJson(res, 409, { error: 'Full cart details are missing. Start a new run before approving.' });
    }
    run.status = approve ? 'placing' : 'running';
    child.stdin.write(JSON.stringify({ approve }) + '\n');
    sendJson(res, 200, { ok: true });
  },

  'POST /api/run/stop': (req, res) => {
    if (!child) return sendJson(res, 409, { error: 'Nothing is running.' });
    child.kill('SIGTERM');
    if (run) run.status = 'cancelled';
    sendJson(res, 200, { ok: true });
  },
};

http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { return sendJson(res, 400, { error: 'Invalid URL' }); }
  const route = routes[`${req.method} ${urlPath}`];

  if (route) {
    try {
      await route(req, res);
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Request failed' });
    }
    return;
  }
  if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

  // Once onboarding is done the entry point is the dashboard; /setup always
  // reopens the wizard so a saved plan can still be edited.
  let filename;
  if (urlPath === '/') filename = hasPlan() ? 'dashboard.html' : 'index.html';
  else if (urlPath === '/setup') filename = 'index.html';
  else filename = urlPath.slice(1);

  const file = path.normalize(path.join(UI_DIR, filename));
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // The UI is edited while the server runs; without this the browser serves
      // a stale app.js/dashboard.js from cache after a change.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`MacroMe running at http://localhost:${PORT}`);
  console.log(hasPlan() ? 'Plan found — opening the dashboard.' : 'No plan yet — opening the setup wizard.');
  startClock();
});
