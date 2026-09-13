// Standalone scheduler: the same minute tick the web server runs, without the
// website.
//
// `npm run dev` already fires scheduled meals on its own, so this is only for
// people who'd rather keep the clock in its own terminal. If both are running,
// the scheduler lock decides which one owns the queue and the other stands by.
import { loadPlan } from "./plan.js";
import { runMealOrder } from "./agent.js";
import { markCompleted } from "../../order-queue.cjs";
import { startTicker } from "../../scheduler-core.cjs";
import type { ScheduledOrder } from "../../order-queue.cjs";

startTicker({
  owner: "npm run schedule",
  loadPlan: () => loadPlan().raw,
  runOrder: async (occurrence: ScheduledOrder) => {
    const plan = loadPlan();
    const meal = plan.config.meals.find((entry) => entry.name === occurrence.meal);
    if (!meal) {
      console.error(`[scheduler] "${occurrence.meal}" is no longer in the plan — skipping.`);
      return;
    }
    console.log(`[scheduler] Firing ${occurrence.meal} for ${occurrence.eatAt}`);
    // Approval still happens in the terminal; nothing is charged without it.
    if (await runMealOrder(meal, new Date(occurrence.eatAt), { occurrenceId: occurrence.id })) {
      markCompleted(occurrence.id);
    }
  },
  onTick: (result) => {
    for (const entry of result.missed) console.log(`[scheduler] Missed ${entry.meal} on ${entry.date} — ${entry.note}`);
    for (const digest of result.digests) console.log(`[scheduler] Digest for ${digest.date}: ${digest.summary}`);
  },
  onError: (err: unknown) => console.error("[scheduler] Tick failed:", err),
});

console.log("[scheduler] Watching the scheduled order queue. Press Ctrl+C to stop.");
