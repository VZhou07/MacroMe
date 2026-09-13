export interface MacroGoals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface MealConfig {
  name: string;
  time: string;       // "HH:MM" 24h
  macroShare: number; // 0-1, fraction of daily macros for this meal
}

export type DayOfWeek =
  | "monday" | "tuesday" | "wednesday"
  | "thursday" | "friday" | "saturday" | "sunday";

export interface UserConfig {
  macros: MacroGoals;
  meals: MealConfig[];
  days: DayOfWeek[];
  budgetPerMeal: number;
  searchQuery: string;
  maxStores: number;
}

export interface MealMacros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
}

export interface CartLine {
  name: string;
  quantity: number;
  // Preserve DoorDash's currency and displayed amount; never substitute menu prices.
  linePrice: string;
  modifiers: string[];
}

export interface CheckoutSummary {
  cartItems: CartLine[];
  checkoutTotal: string;
}

export interface StoreMenu {
  store: string;
  url: string;
  items: MenuItem[];
}

export interface PickedMeal {
  itemId: string;
  item: string;
  restaurant: string;
  storeUrl: string;
  estimatedMacros: MealMacros;
  price: number;
  reasoning: string;
  source: "usda" | "estimated";
  macroConsistent: boolean; // calories roughly match protein*4 + carbs*4 + fat*9
  score: number;            // weighted % distance from this meal's macro target, lower = better
}
