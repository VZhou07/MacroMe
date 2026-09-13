import { createInterface } from "readline";
import { eventsEnabled } from "./events.js";
import type { CheckoutSummary, PickedMeal, MealConfig } from "./types.js";

export function printOrderSummary(meal: MealConfig, picked: PickedMeal): void {
  console.log("\n" + "=".repeat(55));
  console.log(`  MEAL ORDER READY — ${meal.name.toUpperCase()}`);
  console.log("=".repeat(55));
  console.log(`  Agent pick: ${picked.item}`);
  console.log(`  Restaurant: ${picked.restaurant}`);
  console.log(`  Price:      $${picked.price.toFixed(2)}`);
  const sourceLabel = picked.source === "usda" ? "USDA verified" : "LLM estimate";
  console.log(`  Macros:     ${picked.estimatedMacros.calories} kcal | ${picked.estimatedMacros.protein}g protein | ${picked.estimatedMacros.carbs}g carbs | ${picked.estimatedMacros.fat}g fat  (${sourceLabel})`);
  if (!picked.macroConsistent) {
    console.log("  WARNING:    these macros don't add up to the stated calories — treat as rough");
  }
  console.log(`  Why:        ${picked.reasoning}`);
  console.log("=".repeat(55));
}

export function printCartSummary(checkout: CheckoutSummary): void {
  const count = checkout.cartItems.reduce((sum, item) => sum + item.quantity, 0);
  console.log(`\n[cart] ${count} item(s) across ${checkout.cartItems.length} cart line(s):`);
  for (const item of checkout.cartItems) {
    console.log(`[cart] ${item.quantity} × ${item.name} — ${item.linePrice}${item.modifiers.length ? ` (${item.modifiers.join("; ")})` : ""}`);
  }
  console.log(`[cart] Checkout total: ${checkout.checkoutTotal}. Place order charges the entire cart, including fees and tip shown by DoorDash.`);
  console.log("[cart] The agent pick's macros describe that dish only, not the whole cart.");
}

/**
 * Waits for a human to approve the order.
 *
 * Under `--web` the decision arrives from the server as a JSON line on stdin
 * ({"approve":true}); otherwise it's the usual terminal yes/no. Either way the
 * agent blocks here until a person answers, so nothing is ever charged without
 * an explicit approval.
 */
export async function promptApproval(): Promise<boolean> {
  return eventsEnabled() ? awaitWebApproval() : awaitTerminalApproval();
}

function awaitTerminalApproval(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Place the entire cart at the checkout total above? (yes/no): ", (answer) => {
      rl.close();
      releaseStdin();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// Reading stdin puts it into flowing mode, and closing the readline interface
// doesn't undo that — the open pipe keeps the event loop alive and the agent
// would never exit after approving. Pausing and unreffing releases it.
function releaseStdin(): void {
  process.stdin.pause();
  process.stdin.unref();
}

function awaitWebApproval(): Promise<boolean> {
  console.log("  Waiting for approval in the MacroMe dashboard...");
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    // rl.close() emits "close" synchronously, so the decline fallback below
    // would otherwise beat a real decision to the resolve.
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      releaseStdin();
      resolve(approved);
    };

    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      try {
        const msg = JSON.parse(text) as { approve?: boolean };
        if (typeof msg.approve === "boolean") finish(msg.approve);
      } catch {
        // Ignore anything that isn't a decision; the server only ever sends one.
      }
    });

    // If the server goes away without deciding, treat it as a decline rather
    // than hanging on a cart that may be about to be charged.
    rl.on("close", () => finish(false));
  });
}
