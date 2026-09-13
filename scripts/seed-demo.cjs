#!/usr/bin/env node
// Fill a day with fake activity so the digest UI has something to show.
//
// Waiting a real day to demo the end-of-day summary is not practical, so this
// writes one placed, one declined and one missed meal into the day log using
// your own plan's meals and times, and can write the digest straight away.
//
//   node scripts/seed-demo.cjs                 # today, no digest yet
//   node scripts/seed-demo.cjs --digest        # today, digest written now
//   node scripts/seed-demo.cjs --date 2026-09-10 --digest
//
// It writes to the same gitignored files the app uses. Delete them to reset.
const fs = require('fs');
const path = require('path');
const { instantAt } = require('../tz.cjs');
const queue = require('../order-queue.cjs');
const dayLog = require('../day-log.cjs');
const digests = require('../digest.cjs');

const CONFIG_PATH = process.env.MACROME_CONFIG || path.join(__dirname, '..', 'macrome-config.json');
const flag = (name) => process.argv.indexOf(name);
const value = (name) => (flag(name) < 0 ? null : process.argv[flag(name) + 1]);

const DISHES = [
  { item: 'Hot Honey Chicken Bowl', restaurant: 'Sweetgreen' },
  { item: 'Chicken Shawarma Plate', restaurant: 'Paramount Fine Foods' },
  { item: 'Salmon Poke Bowl', restaurant: 'Poke Guys' },
  { item: 'Steel-cut Oats & Berries', restaurant: 'Fresh Kitchen' },
];
const PATTERN = ['placed', 'declined', 'missed'];

function plan() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(err.code === 'ENOENT'
      ? `No plan at ${CONFIG_PATH}. Run \`npm run dev\` and finish the onboarding first.`
      : `Could not read ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
}

const saved = plan();
const timezone = saved.timezone || 'UTC';
const date = value('--date') || digests.today(saved);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('--date wants YYYY-MM-DD');
  process.exit(1);
}

const target = saved.derived?.perMealMacros || { calories: 800, protein: 40, carbs: 80, fat: 20 };
const budget = saved.derived?.perOrderBudget || 30;
const written = [];

saved.meals.forEach((meal, index) => {
  const status = PATTERN[index % PATTERN.length];
  const dish = DISHES[index % DISHES.length];
  const eatAt = instantAt(date, meal.time, timezone);
  if (!eatAt) return;
  // A real run would have marked this occurrence, so mirror that: otherwise the
  // next reconciliation would file the same slot as missed all over again.
  const id = JSON.stringify([eatAt.toISOString(), meal.name, saved.schedule[0]?.addressId || saved.addresses[0].id]);
  queue[status === 'placed' ? 'markCompleted' : status === 'missed' ? 'markMissed' : 'markAttempted'](id);

  const wobble = 0.85 + (index % 3) * 0.12;
  written.push(dayLog.appendEntry({
    id, meal: meal.name, status, timezone, eatAt: eatAt.toISOString(),
    pick: status === 'missed' ? null : {
      ...dish,
      price: Math.round(budget * 0.62 * 100) / 100,
      macros: Object.fromEntries(Object.entries(target).map(([key, amount]) => [key, Math.round(amount * wobble)])),
      source: index % 2 ? 'usda' : 'estimated',
      reasoning: 'Seeded demo pick — closest to this meal\'s macro target within budget.',
    },
    cartItems: status === 'placed' ? [{ name: dish.item, quantity: 1, linePrice: `$${(budget * 0.62).toFixed(2)}`, modifiers: [] }] : null,
    checkoutTotal: status === 'placed' ? `$${(budget * 0.86).toFixed(2)}` : null,
    note: status === 'missed'
      ? "MacroMe wasn't running at the order time, so this meal was skipped. It is recorded, not ordered late."
      : status === 'declined' ? 'Order not placed. The items are still in your DoorDash cart.' : 'Order placed! Check DoorDash for confirmation.',
  }));
});

console.log(`Seeded ${written.length} meal(s) for ${date}:`);
for (const entry of written) console.log(`  ${entry.meal.padEnd(10)} ${entry.status}`);
console.log(`  → ${dayLog.LOG_PATH}`);

if (flag('--digest') >= 0) {
  const digest = digests.generateDigest(saved, date);
  console.log(`Digest for ${date}: ${digest.summary}`);
  console.log(`  → ${digests.DIGEST_PATH}`);
} else {
  console.log(`Open the dashboard and press "Summarise today", or re-run with --digest.`);
}
