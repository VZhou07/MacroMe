import cron from "node-cron";
import { loadPlan } from "./plan.js";
import { runMealOrder } from "./agent.js";
import { upcomingOrders, markCompleted } from "../../order-queue.cjs";

let running = false;

// Share Run now's dated queue, completion history and timezone conversion.
cron.schedule('* * * * *', async () => {
  if (running) return;
  running = true;
  try {
    const plan = loadPlan();
    const minute = new Date(Math.floor(Date.now() / 60000) * 60000);
    const due = upcomingOrders(plan.raw, undefined, minute, 100)
      .filter((order) => order.orderAt === minute.toISOString());
    for (const occurrence of due) {
      const meal = plan.config.meals.find((entry) => entry.name === occurrence.meal);
      if (!meal) continue;
      console.log(`[scheduler] Firing ${occurrence.meal} for ${occurrence.eatAt}`);
      if (await runMealOrder(meal, new Date(occurrence.eatAt))) markCompleted(occurrence.id);
    }
  } catch (err) {
    console.error('[scheduler] Order failed:', err);
  } finally {
    running = false;
  }
});

console.log('[scheduler] Watching the scheduled order queue. Press Ctrl+C to stop.');
