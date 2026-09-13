// End-of-day digests: one saved summary per day, built from the day log.
//
// The digest is what a non-developer reads. It answers "did I hit my macros,
// what did I spend, and what didn't happen" for a single plan-timezone day, and
// it is written exactly once per date so the dashboard, an email and the MCP
// server all report the same numbers.
const fs = require('fs');
const path = require('path');
const { localDate, instantAt, shiftDateKey, DAYS, dateKeyToUtc } = require('./tz.cjs');
const dayLog = require('./day-log.cjs');

const DIGEST_PATH = process.env.MACROME_DIGESTS || path.join(__dirname, 'macrome-digests.json');
// How long after the last meal of the day the digest is written, when the plan
// doesn't name an end-of-day time: long enough for a late delivery to land.
const BUFFER_MINUTES = 90;
// A restart only back-fills digests this far, matching the queue's own window.
const CATCHUP_DAYS = 30;
const MACROS = ['calories', 'protein', 'carbs', 'fat'];

function readDigests(file = DIGEST_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw.digests && typeof raw.digests === 'object' ? raw.digests : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function getDigest(date, file = DIGEST_PATH) {
  return readDigests(file)[date] || null;
}

/** Saved digests, newest first. */
function listDigests(file = DIGEST_PATH, limit = 30) {
  const digests = readDigests(file);
  return Object.keys(digests).sort().reverse().slice(0, limit).map((date) => digests[date]);
}

/** Upsert by date: regenerating a day replaces it rather than duplicating it. */
function writeDigest(digest, file = DIGEST_PATH) {
  const digests = readDigests(file);
  digests[digest.date] = digest;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, digests }, null, 2));
  fs.renameSync(temporary, file);
  return digest;
}

/**
 * DoorDash totals are scraped as displayed ("CA$53.32"), never re-derived from
 * menu prices, so the currency prefix comes along and has to be split off here.
 */
function parseMoney(total) {
  if (typeof total !== 'string') return null;
  const match = total.match(/(-?[\d][\d,]*\.?\d*)/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: total.slice(0, match.index).trim() || '$' };
}

/** When the day's digest becomes due, as `HH:MM` in the plan timezone. */
function digestOverride(plan) {
  const value = String(process.env.MACROME_DIGEST_TIME || plan.digestTime || '').trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function lastMealTime(plan, date) {
  const day = date ? DAYS[dateKeyToUtc(date).getUTCDay()] : null;
  const scheduled = (plan.schedule || []).filter((entry) => !day || entry.day === day);
  const times = (scheduled.length ? scheduled : plan.meals || [])
    .map((meal) => meal.time).filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)).sort();
  return times.at(-1) || '21:00';
}

function digestTime(plan, date) {
  const override = digestOverride(plan);
  if (override) return override;
  const [hour, minute] = lastMealTime(plan, date).split(':').map(Number);
  const total = (hour * 60 + minute + BUFFER_MINUTES) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function digestDueAt(plan, date) {
  const timezone = plan.timezone || 'UTC';
  const override = digestOverride(plan);
  if (override) return instantAt(date, override, timezone);
  const last = instantAt(date, lastMealTime(plan, date), timezone);
  return last ? new Date(last.getTime() + BUFFER_MINUTES * 60000) : null;
}

function sumMacros(entries) {
  const totals = Object.fromEntries(MACROS.map((key) => [key, 0]));
  for (const entry of entries) {
    for (const key of MACROS) totals[key] += Math.round(Number(entry.pick?.macros?.[key]) || 0);
  }
  return totals;
}

// Thousands separators here too: this string is the digest's headline in the
// dashboard, the toast, the email subject and the MCP reply.
const fmt = (value) => Number(value).toLocaleString('en-US');

function summarize(counts, totals, targets, spend) {
  const parts = [];
  const scheduled = counts.placed + counts.declined + counts.failed + counts.missed;
  parts.push(`${counts.placed} of ${scheduled} meal${scheduled === 1 ? '' : 's'} ordered`);
  parts.push(`${fmt(totals.calories)} of ${fmt(targets.calories)} kcal · ${fmt(totals.protein)}g of ${fmt(targets.protein)}g protein`);
  if (spend.orders) parts.push(`${spend.currency}${fmt(spend.amount.toFixed(2))} spent`);
  if (counts.missed) parts.push(`${counts.missed} missed`);
  if (counts.declined) parts.push(`${counts.declined} declined`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(' · ');
}

/**
 * A day's digest from that day's log entries. Pure: the same entries always
 * produce the same digest, which is what keeps regeneration idempotent.
 *
 * Macro totals come from the agent pick in each placed order — the dish the
 * plan was built around — not from every line in the cart.
 */
function buildDigest(plan, date, entries, now = new Date()) {
  const ordered = entries.filter((entry) => dayLog.STATUSES.includes(entry.status)).sort((a, b) => String(a.eatAt || a.at).localeCompare(String(b.eatAt || b.at)));
  const placed = ordered.filter((entry) => entry.status === 'placed');
  const targets = plan.macros || Object.fromEntries(MACROS.map((key) => [key, 0]));
  const totals = sumMacros(placed);

  const spend = { amount: 0, currency: '$', orders: 0 };
  for (const entry of placed) {
    const money = parseMoney(entry.checkoutTotal);
    if (!money) continue;
    if (!spend.orders) spend.currency = money.currency;
    spend.amount = Math.round((spend.amount + money.amount) * 100) / 100;
    spend.orders += 1;
  }

  const counts = Object.fromEntries(dayLog.STATUSES.map((status) => [status, 0]));
  for (const entry of ordered) counts[entry.status] = (counts[entry.status] || 0) + 1;

  return {
    date,
    timezone: plan.timezone || 'UTC',
    generatedAt: now.toISOString(),
    targets: Object.fromEntries(MACROS.map((key) => [key, Math.round(Number(targets[key]) || 0)])),
    totals,
    remaining: Object.fromEntries(MACROS.map((key) => [key, Math.round((Number(targets[key]) || 0) - totals[key])])),
    spend,
    counts,
    meals: ordered.map((entry) => ({
      meal: entry.meal,
      status: entry.status,
      at: entry.at,
      eatAt: entry.eatAt,
      item: entry.pick?.item || null,
      restaurant: entry.pick?.restaurant || null,
      macros: entry.pick?.macros || null,
      source: entry.pick?.source || null,
      checkoutTotal: entry.checkoutTotal || null,
      note: entry.note || null,
      dryRun: Boolean(entry.dryRun),
    })),
    summary: summarize(counts, totals, targets, spend),
  };
}

/** Activity means any recorded placed, declined, failed or missed meal. */
function hasActivity(entries) {
  return entries.some((entry) => dayLog.STATUSES.includes(entry.status));
}

/** Save a Final once, or return the existing Final. Empty days stay live. */
function generateDigest(plan, date, options = {}) {
  const saved = getDigest(date, options.file);
  if (saved) return saved;
  const entries = dayLog.entriesForDate(date, options.dayLogFile);
  if (!hasActivity(entries)) {
    const error = new Error(`Nothing logged for ${date} yet — no digest to save.`);
    error.code = 'EMPTY_DAY_LOG';
    throw error;
  }
  return writeDigest(buildDigest(plan, date, entries, options.now || new Date()), options.file);
}

/** True when enough meals are placed to lock the day before EOD (demo / full day). */
function dayMealsComplete(plan, date, options = {}) {
  const needed = Array.isArray(plan.meals) ? plan.meals.length : 0;
  if (needed <= 0) return false;
  const placed = dayLog.entriesForDate(date, options.dayLogFile)
    .filter((entry) => entry.status === 'placed').length;
  return placed >= needed;
}

/**
 * Write any digest whose end-of-day time has passed and that doesn't exist yet,
 * or whose planned meals are all already placed (hackathon: update Today → Final
 * after the last meal without waiting for evening).
 *
 * Called from the same minute tick as the order queue, so a machine that was
 * off all evening still writes yesterday's digest as soon as it comes back.
 */
function ensureDigests(plan, now = new Date(), options = {}) {
  const digests = readDigests(options.file);
  const oldest = shiftDateKey(localDate(now, plan.timezone || 'UTC'), -CATCHUP_DAYS);
  const written = [];
  for (const date of dayLog.datesWithEntries(options.dayLogFile)) {
    if (digests[date] || date < oldest) continue;
    const due = digestDueAt(plan, date);
    const early = dayMealsComplete(plan, date, options);
    if ((!due || due > now) && !early) continue;
    try {
      written.push(generateDigest(plan, date, { ...options, now }));
    } catch (err) {
      if (err.code !== 'EMPTY_DAY_LOG') throw err;
    }
  }
  return written;
}

/** The day the dashboard calls "today", in the plan's timezone. */
function today(plan, now = new Date()) {
  return localDate(now, plan.timezone || 'UTC');
}

module.exports = {
  DIGEST_PATH, hasActivity, buildDigest, generateDigest, ensureDigests, readDigests,
  getDigest, listDigests, writeDigest, digestTime, digestDueAt, parseMoney, today,
};
