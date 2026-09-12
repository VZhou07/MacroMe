import cron from "node-cron";
import { loadPlan } from "./plan.js";
import { runMealOrder } from "./agent.js";
import type { DayOfWeek } from "./types.js";

const DAY_TO_CRON: Record<DayOfWeek, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function buildCronExpression(time: string, days: DayOfWeek[]): string {
  const [hour, minute] = time.split(":");
  const dayNums = days.map((d) => DAY_TO_CRON[d]).join(",");
  return `${minute} ${hour} * * ${dayNums}`;
}

function scheduleAll(): void {
  // The plan's meal times are already the "place the order at" times — the
  // wizard subtracts the delivery lead from when the user wants to eat.
  const plan = loadPlan();
  const { meals, days } = plan.config;

  for (const meal of meals) {
    const expr = buildCronExpression(meal.time, days);
    console.log(`[scheduler] ${meal.name} scheduled: ${expr} (${days.join(", ")} at ${meal.time})`);

    cron.schedule(expr, async () => {
      console.log(`\n[scheduler] Firing meal: ${meal.name}`);
      try {
        await runMealOrder(meal);
      } catch (err) {
        console.error(`[scheduler] Error running ${meal.name}:`, err);
      }
    }, { timezone: plan.raw.timezone });
  }

  console.log(`[scheduler] Running in ${plan.raw.timezone}. Press Ctrl+C to stop.`);
}

try {
  scheduleAll();
} catch (err) {
  console.error(`[scheduler] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
