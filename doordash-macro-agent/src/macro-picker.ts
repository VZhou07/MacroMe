import OpenAI from "openai";
import { lookupNutrition } from "./nutrition.js";
import type { MacroGoals, MealConfig, MealMacros, PickedMeal, StoreMenu } from "./types.js";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 30000,
  maxRetries: 1,
});

const FREE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

interface Ranked {
  itemId: string;
  estimatedMacros: MealMacros;
  reasoning: string;
}

export interface PickMealsResult {
  picks: PickedMeal[];
  debug: { systemPrompt: string; userPrompt: string; rawResponse: string };
}

function isMacroConsistent(m: MealMacros): boolean {
  const fromMacros = m.protein * 4 + m.carbs * 4 + m.fat * 9;
  if (m.calories === 0) return fromMacros === 0;
  return Math.abs(fromMacros - m.calories) / m.calories <= 0.15;
}

// Weighted % distance from the target, protein weighted highest to match the
// "prioritize protein" rule given to the model. Lower is better.
function distanceScore(macros: MealMacros, target: MealMacros): number {
  const pct = (value: number, goal: number) => (goal === 0 ? 0 : Math.abs(value - goal) / goal);
  return (
    pct(macros.calories, target.calories) * 0.2 +
    pct(macros.protein, target.protein) * 0.4 +
    pct(macros.carbs, target.carbs) * 0.2 +
    pct(macros.fat, target.fat) * 0.2
  );
}

// Returns up to 8 candidates, ranked best-first by actual distance to the
// macro target. Every candidate is guaranteed to be a real item from the
// scraped menus — the model only chooses among ids. Macros are verified
// against USDA FoodData Central where a confident match exists; otherwise
// the LLM's own estimate is kept and labeled as such.
export async function pickMeals(
  menus: StoreMenu[],
  mealConfig: MealConfig,
  dailyMacros: MacroGoals,
  budgetPerMeal: number,
  // Natural-language brief from the user's onboarding plan (see plan.ts). It
  // carries what the numeric targets can't: delivery context, cuisine
  // preferences and dietary constraints.
  brief = ""
): Promise<PickMealsResult> {
  const target = {
    calories: Math.round(dailyMacros.calories * mealConfig.macroShare),
    protein: Math.round(dailyMacros.protein * mealConfig.macroShare),
    carbs: Math.round(dailyMacros.carbs * mealConfig.macroShare),
    fat: Math.round(dailyMacros.fat * mealConfig.macroShare),
  };

  const lookup = new Map<string, { menu: StoreMenu; item: StoreMenu["items"][number] }>();
  const menuText = menus
    .map((menu) => {
      const lines = menu.items.slice(0, 60).map((item) => {
        lookup.set(item.id, { menu, item });
        return `  [${item.id}] ${item.name} — $${item.price.toFixed(2)} — ${item.description}`;
      });
      return `${menu.store}:\n${lines.join("\n")}`;
    })
    .join("\n\n");

  if (lookup.size === 0) return { picks: [], debug: { systemPrompt: "", userPrompt: "", rawResponse: "" } };

  const briefSection = brief ? `\nThe customer's plan for this order:\n${brief}\n` : "";

  const systemPrompt = `You are a nutrition-aware meal selector. Choose menu items that best match the macro targets.
${briefSection}
Macro targets for this meal (${mealConfig.name}):
- Calories: ${target.calories} kcal
- Protein: ${target.protein}g
- Carbs: ${target.carbs}g
- Fat: ${target.fat}g
- Max budget: $${budgetPerMeal}

Rules: only choose ids that appear in the menu in [brackets]; choose a single-serving meal for one person (no family-size, bundles, sides, drinks, or add-ons); prioritize protein; estimate macros from the name and description; treat any dietary requirement or avoided ingredient in the plan above as a hard constraint and never pick an item that breaks it.
Compare all the supplied restaurants. Include affordable alternatives across different restaurants when available.
Return ONLY valid JSON, no extra text: a ranked array of up to 8 choices, best first:
[{"itemId":"123","estimatedMacros":{"calories":0,"protein":0,"carbs":0,"fat":0},"reasoning":"brief reason"}]`;

  const userPrompt = `Menus:\n\n${menuText}\n\nReturn the ranked JSON array.`;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // The free OpenRouter model occasionally returns an empty or malformed
  // response under load; a couple of retries clears that up.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({ model: FREE_MODEL, messages, temperature: 0.2 });
      const rawResponse = response.choices?.[0]?.message?.content ?? "";
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error(`Model did not return a JSON array. Got: ${rawResponse}`);

      const ranked = (JSON.parse(jsonMatch[0]) as Ranked[])
        .slice(0, 8)
        .map((r) => ({ r, hit: lookup.get(String(r.itemId)) }))
        .filter((x): x is { r: Ranked; hit: NonNullable<typeof x.hit> } => Boolean(x.hit) && x.hit!.item.price <= budgetPerMeal &&
          Boolean(x.r.estimatedMacros) && ['calories', 'protein', 'carbs', 'fat'].every((key) => {
            const value = x.r.estimatedMacros[key as keyof MealMacros];
            return typeof value === 'number' && Number.isFinite(value) && value >= 0;
          }));

      if (ranked.length === 0) throw new Error(`Model chose no valid menu item ids. Got: ${rawResponse}`);

      const picks: PickedMeal[] = await Promise.all(
        ranked.map(async ({ r, hit }) => {
          const usda = await lookupNutrition(hit.item.name);
          const macros = usda?.macros ?? r.estimatedMacros;
          return {
            itemId: hit.item.id,
            item: hit.item.name,
            restaurant: hit.menu.store,
            storeUrl: hit.menu.url,
            price: hit.item.price,
            estimatedMacros: macros,
            reasoning: r.reasoning,
            source: usda ? ("usda" as const) : ("estimated" as const),
            macroConsistent: isMacroConsistent(macros),
            score: distanceScore(macros, target),
          };
        })
      );

      picks.sort((a, b) => a.score - b.score);
      return { picks, debug: { systemPrompt, userPrompt, rawResponse } };
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`pickMeals failed after 3 attempts: ${lastError}`);
}
