import cron from "node-cron";
import { loadConfig } from "./config.js";
import { runMealOrder } from "./agent.js";
import type { DayOfWeek, MealConfig } from "./types.js";

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
  const config = loadConfig();

  for (const meal of config.meals) {
    const expr = buildCronExpression(meal.time, config.days);
    console.log(`[scheduler] ${meal.name} scheduled: ${expr} (${config.days.join(", ")} at ${meal.time})`);

    cron.schedule(expr, async () => {
      console.log(`\n[scheduler] Firing meal: ${meal.name}`);
      try {
        await runMealOrder(meal);
      } catch (err) {
        console.error(`[scheduler] Error running ${meal.name}:`, err);
      }
    });
  }

  console.log("[scheduler] Running. Press Ctrl+C to stop.");
}

scheduleAll();
