import { readFileSync } from "fs";
import { z } from "zod";
import type { UserConfig } from "./types.js";

const MacroGoalsSchema = z.object({
  calories: z.number().positive(),
  protein: z.number().positive(),
  carbs: z.number().positive(),
  fat: z.number().positive(),
});

const MealConfigSchema = z.object({
  name: z.string(),
  time: z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM"),
  macroShare: z.number().min(0).max(1),
});

const DaySchema = z.enum([
  "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday", "sunday",
]);

const UserConfigSchema = z.object({
  macros: MacroGoalsSchema,
  meals: z.array(MealConfigSchema).min(1),
  days: z.array(DaySchema).min(1),
  budgetPerMeal: z.number().positive(),
  searchQuery: z.string().min(1).default("healthy"),
  maxStores: z.number().int().positive().default(3),
});

export function loadConfig(path = "./config.json"): UserConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const result = UserConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error("Invalid config.json:", result.error.flatten());
    process.exit(1);
  }
  return result.data as UserConfig;
}
