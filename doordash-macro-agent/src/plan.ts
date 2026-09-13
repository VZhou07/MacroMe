// Bridges the MacroMe onboarding wizard to the ordering agent.
//
// The wizard (../ui) writes ../macrome-config.json. That file is the single
// source of truth: this module validates it and produces the two things the
// agent needs — a structured UserConfig for the scraper/budget filter, and a
// natural-language brief that gets injected into the meal-picker's prompt so
// details the structured config has no room for (delivery time, address,
// drop-off, tip, foods to avoid) actually reach the model.
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { DayOfWeek, MacroGoals, MealConfig, UserConfig } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLAN_PATH = process.env.MACROME_CONFIG || path.resolve(HERE, "../../macrome-config.json");

// DoorDash adds a delivery fee and a percentage service fee on top of the cart.
// When the user said their budget already covers fees and tip, we work backwards
// from it to a cart cap so checkout still lands under what they asked for.
const DELIVERY_FEE_ESTIMATE = 3.99;
const SERVICE_FEE_PERCENT = 15;
const MIN_CART_BUDGET = 5;

// How many restaurants to scrape per run. Each store costs a slow virtualized
// menu scroll, so this trades breadth for run time.
const DEFAULT_MAX_STORES = 12;

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const DAY_KEY_TO_FULL: Record<DayKey, DayOfWeek> = {
  mon: "monday", tue: "tuesday", wed: "wednesday",
  thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday",
};

const MacrosSchema = z.object({
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fat: z.number().nonnegative(),
});

const AddressSchema = z.object({
  id: z.string(),
  label: z.string(),
  street: z.string(),
  apt: z.string().default(""),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  dropoff: z.enum(["door", "hand"]).default("door"),
  instructions: z.string().default(""),
});

// The wizard added preferences after v2 shipped, so every field is optional and
// a plan saved before that step existed still loads.
const PreferencesSchema = z
  .object({
    cuisines: z.array(z.string()).default([]),
    dietary: z.array(z.string()).default([]),
    avoid: z.string().default(""),
    searchQuery: z.string().default(""),
  })
  .default({ cuisines: [], dietary: [], avoid: "", searchQuery: "" });

const PlanSchema = z.object({
  version: z.number(),
  savedAt: z.string().optional(),
  macros: MacrosSchema,
  meals: z.array(z.object({
    name: z.string(),
    time: z.string().regex(/^\d{2}:\d{2}$/, "meal time must be HH:MM"),
    orderAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })).min(1),
  orderLeadMinutes: z.number().nonnegative().default(45),
  budget: z.object({
    amount: z.number().positive(),
    period: z.enum(["meal", "day", "week"]),
    includesFeesAndTip: z.boolean().default(true),
    tipPercent: z.number().min(0).max(100).default(15),
  }),
  days: z.array(z.enum(DAY_KEYS)).min(1),
  addresses: z.array(AddressSchema).min(1),
  schedule: z.array(z.object({
    day: z.enum(DAY_KEYS),
    meal: z.string(),
    time: z.string(),
    orderAt: z.string().optional(),
    addressId: z.string(),
  })),
  timezone: z.string().default("UTC"),
  preferences: PreferencesSchema,
  derived: z.object({
    perMealMacros: MacrosSchema,
    perOrderBudget: z.number().nonnegative(),
    ordersPerWeek: z.number().nonnegative(),
  }),
});

export type MacroMePlan = z.infer<typeof PlanSchema>;
export type PlanAddress = z.infer<typeof AddressSchema>;

export interface Plan {
  raw: MacroMePlan;
  config: UserConfig;
  /** The natural-language brief for one meal, injected into the picker prompt. */
  briefFor(mealName: string, when?: Date): string;
  /** Where a given meal is delivered on a given day. */
  addressFor(mealName: string, when?: Date): PlanAddress;
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The most a single cart may cost. When the user's budget is meant to cover
 * fees and tip, back those out so the food total leaves room for them.
 */
export function cartBudget(plan: MacroMePlan): number {
  const perOrder = plan.derived.perOrderBudget;
  if (!plan.budget.includesFeesAndTip) return perOrder;
  const afterDelivery = perOrder - DELIVERY_FEE_ESTIMATE;
  const cap = afterDelivery / (1 + (plan.budget.tipPercent + SERVICE_FEE_PERCENT) / 100);
  return Math.max(MIN_CART_BUDGET, Math.round(cap * 100) / 100);
}

/** What the agent types into DoorDash's store search. */
export function searchQuery(plan: MacroMePlan): string {
  const explicit = plan.preferences.searchQuery.trim();
  if (explicit) return explicit;
  const parts: string[] = [];
  if (plan.preferences.cuisines.length === 1) parts.push(plan.preferences.cuisines[0]);
  const diet = plan.preferences.dietary.find((d) => /vegan|vegetarian|halal|kosher/i.test(d));
  if (diet) parts.push(diet);
  parts.push("healthy");
  return parts.join(" ").toLowerCase();
}

function toUserConfig(plan: MacroMePlan): UserConfig {
  // The wizard splits daily macros evenly across meals, so every meal carries
  // the same share. Keeping it as a share (rather than baking in absolute
  // numbers) preserves the agent's existing target maths.
  const share = 1 / plan.meals.length;
  const meals: MealConfig[] = plan.meals.map((m) => ({
    name: m.name,
    // The agent should start working at orderAt, not when the food should
    // arrive, so the order has time to be picked, cooked and driven over.
    time: m.orderAt ?? m.time,
    macroShare: share,
  }));

  return {
    macros: plan.macros as MacroGoals,
    meals,
    days: plan.days.map((d) => DAY_KEY_TO_FULL[d]),
    budgetPerMeal: cartBudget(plan),
    searchQuery: searchQuery(plan),
    maxStores: Math.max(1, Math.min(30, Math.floor(Number(process.env.MACROME_MAX_STORES) || DEFAULT_MAX_STORES))),
  };
}

function scheduleEntry(plan: MacroMePlan, mealName: string, when: Date) {
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: plan.timezone }).format(when).toLowerCase() as DayKey;
  const forMeal = plan.schedule.filter((s) => s.meal.toLowerCase() === mealName.toLowerCase());
  // Prefer today's entry; otherwise any day's, so a manual run outside the
  // schedule still knows where the food should go.
  return forMeal.find((s) => s.day === today) ?? forMeal[0] ?? null;
}

export function loadPlan(file = PLAN_PATH): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `No plan found at ${file}.`
      : `Could not read ${file}: ${err instanceof Error ? err.message : err}`;
    throw new Error(`${reason}\nRun the onboarding first: \`npm run ui\` in the project root, then open http://localhost:3000`);
  }

  const result = PlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${file} is not a valid MacroMe plan:\n${issues}\nRe-run the onboarding to rewrite it.`);
  }
  const plan = result.data;

  const addressFor = (mealName: string, when = new Date()): PlanAddress => {
    const entry = scheduleEntry(plan, mealName, when);
    return plan.addresses.find((a) => a.id === entry?.addressId) ?? plan.addresses[0];
  };

  const briefFor = (mealName: string, when = new Date()): string => {
    const meal = plan.meals.find((m) => m.name.toLowerCase() === mealName.toLowerCase()) ?? plan.meals[0];
    const target = plan.derived.perMealMacros;
    const address = addressFor(mealName, when);
    const prefs = plan.preferences;

    const lines = [
      `This is ${meal.name}, to arrive by ${fmtTime(meal.time)} at ${address.label} (${address.city}, ${address.state}).`,
      `Delivery is ${address.dropoff === "door" ? "left at the door" : "handed to the customer"}.`,
      `Macro target for this meal: ${target.calories} kcal, ${target.protein}g protein, ${target.carbs}g carbs, ${target.fat}g fat.`,
      `The cart must stay at or under $${cartBudget(plan).toFixed(2)}, which leaves room for fees and a ${plan.budget.tipPercent}% tip.`,
      `It is one meal for one person.`,
    ];
    if (prefs.cuisines.length) lines.push(`The customer prefers ${list(prefs.cuisines)} food.`);
    if (prefs.dietary.length) lines.push(`Dietary requirements, which are hard constraints: ${list(prefs.dietary)}.`);
    if (prefs.avoid.trim()) lines.push(`Never choose anything containing: ${prefs.avoid.trim()}.`);
    return lines.join(" ");
  };

  return { raw: plan, config: toUserConfig(plan), briefFor, addressFor };
}

/** True when onboarding has been completed at least once. */
export function planExists(file = PLAN_PATH): boolean {
  try {
    readFileSync(file, "utf-8");
    return true;
  } catch {
    return false;
  }
}
