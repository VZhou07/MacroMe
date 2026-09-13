// The dated order queue: which meal occurrences are still coming up, which are
// already done, and which slipped past while MacroMe wasn't running.
//
// Pending orders are never a hand-maintained list. They are recomputed from the
// saved plan every time anyone asks, minus the occurrences this file records as
// completed, missed or already attempted. That is what makes a restart cheap:
// the schedule is derived, only the lifecycle is stored.
const fs = require('fs');
const path = require('path');
const { DAYS, dateParts, atTime } = require('./tz.cjs');

const STATE_PATH = process.env.MACROME_QUEUE_STATE || path.join(__dirname, 'macrome-queue-state.json');
// How far back a restart will look for slots it slept through. A laptop closed
// for a month shouldn't wake up and declare a hundred missed meals.
const RECONCILE_WINDOW_DAYS = 14;
// Lifecycle ids are read on every dashboard poll, so old ones are dropped.
const RETAIN_DAYS = 60;
const KINDS = ['completed', 'missed', 'attempted'];

function emptyState() {
  return { completed: new Set(), missed: new Set(), attempted: new Set(), lastSeenAt: null };
}

function idList(state, kind) {
  const ids = state[kind];
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error(`Invalid queue ${kind} history`);
  }
  return ids;
}

function readState(file = STATE_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  const state = emptyState();
  for (const kind of KINDS) state[kind] = new Set(idList(raw, kind));
  state.lastSeenAt = typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : null;
  return state;
}

// An occurrence id carries its own eat-at time, so history ages out without a
// second timestamp to keep in sync.
function keep(id, cutoff) {
  try {
    const eatAt = Date.parse(JSON.parse(id)[0]);
    return !Number.isFinite(eatAt) || eatAt >= cutoff;
  } catch {
    return true;
  }
}

function writeState(state, file = STATE_PATH, now = new Date()) {
  const cutoff = now.getTime() - RETAIN_DAYS * 86400000;
  const body = { version: 2, lastSeenAt: state.lastSeenAt };
  for (const kind of KINDS) body[kind] = [...state[kind]].filter((id) => keep(id, cutoff)).sort();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(body, null, 2));
  fs.renameSync(temporary, file);
}

/** Occurrences the queue should no longer offer up as pending. */
function readCompleted(file = STATE_PATH) {
  return readState(file).completed;
}

function mark(kind, id, file = STATE_PATH) {
  const state = readState(file);
  state[kind].add(id);
  writeState(state, file);
}

const markCompleted = (id, file = STATE_PATH) => mark('completed', id, file);
/** The order time passed without an order — recorded, never re-fired later. */
const markMissed = (id, file = STATE_PATH) => mark('missed', id, file);
/** A run started for this occurrence, so reconciliation must not call it missed. */
const markAttempted = (id, file = STATE_PATH) => mark('attempted', id, file);

/**
 * Every occurrence the plan produces whose *order* time falls in [from, to).
 * Local dates are walked either side of the window because an order time can
 * sit on the day before the meal.
 */
function occurrencesBetween(plan, from, to) {
  const timezone = plan.timezone || 'UTC';
  const planDays = plan.days || [];
  const start = dateParts(from, timezone);
  const span = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86400000)) + 2;
  const orders = [];
  for (let day = -1; day < span; day++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + day));
    const dayKey = DAYS[date.getUTCDay()];
    if (!planDays.includes(dayKey)) continue;
    for (const entry of plan.schedule) {
      if (entry.day !== dayKey) continue;
      const eatAt = atTime(date, entry.time, timezone);
      if (!eatAt) continue;
      let orderAt;
      if (entry.orderAt) {
        const orderDate = new Date(date);
        if (entry.orderAt > entry.time) orderDate.setUTCDate(orderDate.getUTCDate() - 1);
        orderAt = atTime(orderDate, entry.orderAt, timezone);
      } else {
        orderAt = new Date(eatAt.getTime() - (plan.orderLeadMinutes ?? 45) * 60000);
      }
      if (!orderAt || orderAt < from || orderAt >= to) continue;
      orders.push({
        id: JSON.stringify([eatAt.toISOString(), entry.meal, entry.addressId]),
        meal: entry.meal, time: entry.time, eatAt: eatAt.toISOString(),
        orderAt: orderAt.toISOString(), addressId: entry.addressId,
      });
    }
  }
  return orders.sort((a, b) => a.orderAt.localeCompare(b.orderAt) || a.id.localeCompare(b.id));
}

function upcomingOrders(plan, completed = readCompleted(), now = new Date(), limit = 5) {
  const horizon = new Date(now.getTime() + 14 * 86400000);
  return occurrencesBetween(plan, now, horizon).filter((order) => !completed.has(order.id)).slice(0, limit);
}

/**
 * Slots whose order time passed while nobody was watching.
 *
 * Called on boot and on every tick. Anything between the last tick and now that
 * was never completed or attempted is recorded as missed — it is deliberately
 * not ordered late, it just stops being "next". The tick timestamp is persisted
 * either way, so the next restart knows how long the gap was.
 */
function reconcileMissed(plan, now = new Date(), file = STATE_PATH) {
  const state = readState(file);
  const seen = state.lastSeenAt ? new Date(state.lastSeenAt) : null;
  const floor = new Date(now.getTime() - RECONCILE_WINDOW_DAYS * 86400000);
  const from = !seen || !Number.isFinite(seen.getTime()) || seen >= now ? null
    : seen < floor ? floor : seen;
  const newly = from === null ? [] : occurrencesBetween(plan, from, now)
    .filter((order) => !KINDS.some((kind) => state[kind].has(order.id)));
  for (const order of newly) state.missed.add(order.id);
  state.lastSeenAt = now.toISOString();
  writeState(state, file, now);
  return newly;
}

module.exports = {
  STATE_PATH, upcomingOrders, occurrencesBetween, readState, writeState,
  readCompleted, markCompleted, markMissed, markAttempted, reconcileMissed,
};
