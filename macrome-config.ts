// Typed access to the plan saved by the MacroMe setup UI (macrome-config.json).
// Usage in the agent:
//   import { loadMacroMeConfig, getUpcomingOrders } from './macrome-config';
//   const plan = loadMacroMeConfig();
//   for (const { order, address, placeOrderAt } of getUpcomingOrders(plan)) { ... }
import { readFileSync } from 'fs';
import * as path from 'path';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Macros {
  calories: number;
  protein: number; // grams
  carbs: number;   // grams
  fat: number;     // grams
}

export interface Meal {
  name: string;    // e.g. "Lunch"
  time: string;    // "HH:MM" 24h, when the user wants to eat
  orderAt: string; // "HH:MM" 24h, when the agent should place the order
}

export interface Address {
  id: string;
  label: string;   // e.g. "Home", "Work"
  street: string;
  apt: string;
  city: string;
  state: string;
  zip: string;
  dropoff: 'door' | 'hand';
  instructions: string;
}

/** One recurring weekly order: which meal, on which day, delivered where. */
export interface ScheduledOrder {
  day: DayKey;
  meal: string;
  time: string;
  orderAt: string;
  addressId: string;
}

export interface MacroMeConfig {
  version: 2;
  savedAt: string;
  macros: Macros;               // daily totals
  meals: Meal[];                // sorted by time
  orderLeadMinutes: number;
  budget: {
    amount: number;
    period: 'meal' | 'day' | 'week';
    includesFeesAndTip: boolean;
    tipPercent: number;
  };
  days: DayKey[];
  addresses: Address[];         // 1 to 3
  schedule: ScheduledOrder[];   // every day × meal, sorted by day then time
  timezone: string;
  derived: {
    perMealMacros: Macros;      // daily macros split evenly across meals
    perOrderBudget: number;     // max cart total (USD) for a single order
    ordersPerWeek: number;
  };
}

export const CONFIG_PATH = path.join(__dirname, 'macrome-config.json');

export function loadMacroMeConfig(file = CONFIG_PATH): MacroMeConfig {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const JS_DAY_TO_KEY: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Next orders the agent needs to place, soonest first, with the address to deliver to. */
export function getUpcomingOrders(config: MacroMeConfig, from = new Date(), count = 10) {
  const out: { order: ScheduledOrder; address: Address; deliverBy: Date; placeOrderAt: Date }[] = [];
  for (let d = 0; d < 14 && out.length < count; d++) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
    const day = JS_DAY_TO_KEY[date.getDay()];
    for (const order of config.schedule.filter((o) => o.day === day)) {
      const [h, m] = order.time.split(':').map(Number);
      const deliverBy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
      const placeOrderAt = new Date(deliverBy.getTime() - config.orderLeadMinutes * 60_000);
      const address = config.addresses.find((a) => a.id === order.addressId) ?? config.addresses[0];
      if (placeOrderAt > from) out.push({ order, address, deliverBy, placeOrderAt });
      if (out.length >= count) break;
    }
  }
  return out;
}
