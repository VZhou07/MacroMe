// The minute tick that owns MacroMe's clock.
//
// One tick does three things, in this order:
//   1. records any slot whose order time passed while we weren't watching,
//   2. fires anything due this very minute,
//   3. writes any end-of-day digest that has come due.
//
// The web server runs this in-process so leaving http://localhost:3000 up is
// enough, and `npm run schedule` runs the same code standalone. Both go through
// the scheduler lock, so only one of them ever fires an order.
const queue = require('./order-queue.cjs');
const dayLog = require('./day-log.cjs');
const digests = require('./digest.cjs');
const lock = require('./scheduler-lock.cjs');

const OFFLINE_NOTE = "MacroMe wasn't running at the order time, so this meal was skipped. It is recorded, not ordered late.";
const BUSY_NOTE = 'Another order was still running at the order time, so this meal was skipped.';
// A single minute can legitimately hold several meals; this only guards against
// a corrupt plan generating thousands.
const MAX_DUE_PER_MINUTE = 100;

function recordMissed(occurrence, plan, note, options) {
  return dayLog.appendEntry({
    id: occurrence.id, meal: occurrence.meal, status: 'missed',
    eatAt: occurrence.eatAt, timezone: plan.timezone || 'UTC', note,
  }, options.dayLogFile, options.now);
}

/**
 * Reconcile, fire and summarise for one minute.
 *
 * Exported on its own so tests (and a demo) can drive any minute they like
 * without waiting for a real clock.
 */
async function tick(options) {
  const { plan, runOrder, canRun } = options;
  const now = options.now || new Date();
  // Align to the minute so an order time is matched exactly once, however late
  // the timer actually fires.
  const minute = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const result = { minute: minute.toISOString(), missed: [], fired: [], digests: [] };

  for (const occurrence of queue.reconcileMissed(plan, minute, options.queueFile)) {
    result.missed.push(recordMissed(occurrence, plan, OFFLINE_NOTE, { ...options, now: minute }));
  }

  const due = queue.upcomingOrders(plan, queue.readCompleted(options.queueFile), minute, MAX_DUE_PER_MINUTE)
    .filter((occurrence) => occurrence.orderAt === minute.toISOString());
  for (const occurrence of due) {
    // A run in progress owns the DoorDash cart; a second one would fight it.
    if (canRun && !canRun(occurrence)) {
      queue.markMissed(occurrence.id, options.queueFile);
      result.missed.push(recordMissed(occurrence, plan, BUSY_NOTE, { ...options, now: minute }));
      continue;
    }
    // Recorded before the run starts, so reconciliation can tell "declined" and
    // "still running" apart from "nobody was home".
    queue.markAttempted(occurrence.id, options.queueFile);
    result.fired.push(occurrence);
    await runOrder(occurrence);
  }

  result.digests = digests.ensureDigests(plan, minute, { ...options, now: minute });
  return result;
}

/**
 * Run `tick` every minute for as long as this process lives.
 *
 * `loadPlan` is called fresh each minute so editing the plan in the wizard takes
 * effect without a restart, and a plan that is temporarily unreadable only skips
 * a tick instead of killing the timer.
 */
function startTicker(options) {
  const owner = options.owner || 'macrome';
  const log = options.log || console.log;
  const onError = options.onError || ((err) => console.error('[scheduler]', err));
  let timer = null;
  let pulse = null;
  let stopped = false;
  let busy = false;
  let holding = false;
  let announced = null;

  function claim() {
    if (stopped) return false;
    const held = holding ? lock.heartbeat(owner) : lock.acquire(owner);
    if (held !== announced) {
      const other = held ? null : lock.holder();
      log(held
        ? '[scheduler] Watching the order queue in this process.'
        : `[scheduler] Another MacroMe scheduler${other ? ` (pid ${other.pid}, ${other.owner})` : ''} owns the clock; not firing orders here.`);
      announced = held;
    }
    holding = held;
    return held;
  }

  async function runTick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const plan = claim() ? options.loadPlan() : null;
      // No plan saved yet: onboarding hasn't finished, so there is nothing to
      // miss and nothing to summarise. Keep ticking and pick it up when it lands.
      if (plan) {
        const result = await tick({ ...options, plan, now: new Date() });
        if (options.onTick) options.onTick(result);
      }
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    // Chase the wall clock rather than counting 60s hops, so sleep and drift
    // can't slide the tick off the minute boundary orders are matched on.
    timer = setTimeout(async () => {
      await runTick();
      schedule();
    }, 60000 - (Date.now() % 60000) + 250);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (pulse) clearInterval(pulse);
    timer = pulse = null;
    if (holding) lock.release();
    holding = false;
  }

  process.once('exit', () => { if (holding) lock.release(); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { stop(); process.exit(0); });
  }

  // An order run can block a tick for ten minutes or more, so the claim is kept
  // alive on its own timer — otherwise it would go stale mid-run and the other
  // process would start firing the same meals.
  pulse = setInterval(claim, Math.floor(lock.STALE_MS / 5));

  // Catch up on the way in: boot is exactly when missed slots and an unwritten
  // digest need noticing.
  const ready = runTick().then(schedule);
  return { stop, ready, tick: runTick };
}

module.exports = { tick, startTicker, OFFLINE_NOTE, BUSY_NOTE };
