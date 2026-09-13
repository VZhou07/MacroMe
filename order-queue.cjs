const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.MACROME_QUEUE_STATE || path.join(__dirname, 'macrome-queue-state.json');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

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

function readCompleted(file = STATE_PATH) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(state.completed) || state.completed.some((id) => typeof id !== 'string')) {
      throw new Error('Invalid queue completion history');
    }
    return new Set(state.completed);
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

function markCompleted(id, file = STATE_PATH) {
  const completed = readCompleted(file);
  completed.add(id);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ completed: [...completed] }, null, 2));
  fs.renameSync(temporary, file);
}

function upcomingOrders(plan, completed = readCompleted(), now = new Date(), limit = 5) {
  const timezone = plan.timezone || 'UTC';
  const today = dateParts(now, timezone);
  const orders = [];
  for (let day = 0; day < 14; day++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + day));
    const dayKey = DAYS[date.getUTCDay()];
    for (const entry of plan.schedule) {
      if (entry.day !== dayKey || !plan.days.includes(dayKey)) continue;
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
      if (!orderAt || orderAt < now) continue;
      const id = JSON.stringify([eatAt.toISOString(), entry.meal, entry.addressId]);
      if (completed.has(id)) continue;
      orders.push({ id, meal: entry.meal, time: entry.time, eatAt: eatAt.toISOString(),
        orderAt: orderAt.toISOString(), addressId: entry.addressId });
    }
  }
  return orders.sort((a, b) => a.orderAt.localeCompare(b.orderAt) || a.id.localeCompare(b.id)).slice(0, limit);
}

module.exports = { upcomingOrders, readCompleted, markCompleted };
