import { createInterface } from "readline";
import type { PickedMeal, MealConfig } from "./types.js";

export function printOrderSummary(meal: MealConfig, picked: PickedMeal): void {
  console.log("\n" + "=".repeat(55));
  console.log(`  MEAL ORDER READY — ${meal.name.toUpperCase()}`);
  console.log("=".repeat(55));
  console.log(`  Item:       ${picked.item}`);
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

export async function promptApproval(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Place this order? (yes/no): ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}
