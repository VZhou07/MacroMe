// Timezone maths shared by the order queue, the day log and the digests.
//
// Everything MacroMe calls "today", "end of day" or "past due" is resolved in
// the plan's timezone, not the machine's, so a laptop that travels doesn't
// silently reschedule the user's meals.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The wall-clock fields of an instant, as seen in `timezone`. */
function dateParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function wallTime(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

// Resolve schedule times in the saved timezone, including DST transitions.
function atTime(date, time, timezone) {
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const difference = target - wallTime(dateParts(new Date(instant), timezone));
    if (!difference) return new Date(instant);
    instant += difference;
  }
  return null; // Nonexistent local time during the spring DST jump.
}

/** The calendar date an instant falls on in `timezone`, as `YYYY-MM-DD`. */
function localDate(date, timezone) {
  const parts = dateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` back to a Date, so date keys can be walked day by day. */
function dateKeyToUtc(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The instant `HH:MM` on a local date. Falls forward an hour when that wall
 * clock time doesn't exist (spring DST), so an end-of-day job still runs.
 */
function instantAt(dateKey, time, timezone) {
  const date = dateKeyToUtc(dateKey);
  const exact = atTime(date, time, timezone);
  if (exact) return exact;
  const [hour, minute] = time.split(':').map(Number);
  return atTime(date, `${String((hour + 1) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, timezone);
}

/** `YYYY-MM-DD` shifted by whole days, still in calendar terms. */
function shiftDateKey(dateKey, days) {
  const date = dateKeyToUtc(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return localDate(date, 'UTC');
}

module.exports = { DAYS, dateParts, wallTime, atTime, localDate, dateKeyToUtc, instantAt, shiftDateKey };
