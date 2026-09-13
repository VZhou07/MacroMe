// What actually happened, meal by meal.
//
// Every terminal outcome of a meal run lands here: an order placed, an order
// declined, a run that failed, or a slot MacroMe slept through. The agent writes
// its own outcomes (so terminal runs count too) and the scheduler writes the
// missed ones. The dashboard, the end-of-day digest and the MCP server all read
// this file rather than re-deriving history from logs.
const fs = require('fs');
const path = require('path');
const { localDate } = require('./tz.cjs');

const LOG_PATH = process.env.MACROME_DAY_LOG || path.join(__dirname, 'macrome-day-log.json');
const STATUSES = ['placed', 'declined', 'failed', 'missed'];
// Digests summarise a day permanently, so the raw per-meal rows can age out.
const RETAIN_DAYS = 90;

function readFile(file = LOG_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Every recorded meal outcome, oldest first. */
function readEntries(file = LOG_PATH) {
  return readFile(file);
}

function entriesForDate(date, file = LOG_PATH) {
  return readFile(file).filter((entry) => entry.date === date);
}

/** Dates that have any activity, oldest first — what the digest catch-up walks. */
function datesWithEntries(file = LOG_PATH) {
  return [...new Set(readFile(file).map((entry) => entry.date))].sort();
}

function normalize(entry, now = new Date()) {
  const timezone = entry.timezone || 'UTC';
  const at = entry.at || now.toISOString();
  const eatAt = entry.eatAt || null;
  const status = STATUSES.includes(entry.status) ? entry.status : 'failed';
  return {
    id: entry.id || null,
    // Dated by when the meal was meant to be eaten, so a late dinner run
    // doesn't leak into tomorrow's digest.
    date: entry.date || localDate(new Date(eatAt || at), timezone),
    timezone,
    meal: entry.meal || 'Meal',
    status,
    at,
    eatAt,
    pick: entry.pick || null,
    cartItems: entry.cartItems || null,
    checkoutTotal: entry.checkoutTotal || null,
    note: entry.note || null,
    dryRun: Boolean(entry.dryRun),
  };
}

/** Append one outcome. Atomic, so a crash mid-write can't truncate history. */
function appendEntry(entry, file = LOG_PATH, now = new Date()) {
  const stored = normalize(entry, now);
  const cutoff = localDate(new Date(now.getTime() - RETAIN_DAYS * 86400000), stored.timezone);
  const entries = readFile(file).filter((existing) => existing.date >= cutoff);
  entries.push(stored);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2));
  fs.renameSync(temporary, file);
  return stored;
}

module.exports = { LOG_PATH, STATUSES, appendEntry, readEntries, entriesForDate, datesWithEntries };
