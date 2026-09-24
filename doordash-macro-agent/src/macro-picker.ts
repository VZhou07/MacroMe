import OpenAI from "openai";
import { confidentReasoning, demoJustification, estimateMacrosFromName, fallbackPicks } from "./fallback-picks.js";
import { lookupNutrition } from "./nutrition.js";
import { shuffled } from "./shuffle.js";
import { isMealCandidate, type FoodPreferences } from './meal-eligibility.js';
import type { MacroGoals, MealConfig, MealMacros, PickedMeal, StoreMenu } from "./types.js";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 45000,
  maxRetries: 0,
});

const MAX_PICKS = 3;
const FREE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

interface RankedItem {
  itemId: string;
  estimatedMacros: MealMacros;
}
interface Ranked {
  items?: RankedItem[];
  itemId?: string;
  estimatedMacros?: MealMacros;
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

function copiesTarget(macros: MealMacros, target: MealMacros): boolean {
  return macros.calories === target.calories && macros.protein === target.protein &&
    macros.carbs === target.carbs && macros.fat === target.fat;
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

function fillShortlist(
  modelPicks: PickedMeal[],
  menus: StoreMenu[],
  target: MealMacros,
  budgetPerMeal: number,
  preferences: FoodPreferences,
): PickedMeal[] {
  const picks: PickedMeal[] = [];
  const seenSelections = new Set<string>();
  const usedComponents = new Set<string>();
  const componentsOf = (pick: PickedMeal) => pick.components?.length ? pick.components : [{ itemId: pick.itemId }];
  const componentKey = (pick: PickedMeal, itemId: string) => JSON.stringify([pick.storeUrl, itemId]);
  const selectionKey = (pick: PickedMeal) => pick.selectionId ??
    JSON.stringify([pick.storeUrl, ...componentsOf(pick).map((component) => component.itemId).sort()]);
  const append = (pick: PickedMeal) => {
    const key = selectionKey(pick);
    if (seenSelections.has(key)) return false;
    picks.push(pick);
    seenSelections.add(key);
    for (const component of componentsOf(pick)) usedComponents.add(componentKey(pick, component.itemId));
    return true;
  };

  for (const pick of modelPicks) {
    if (picks.length === MAX_PICKS) break;
    append(pick);
  }
  if (picks.length === MAX_PICKS) return picks;

  // Request more than the remaining slots so excluding a model-picked item or
  // both parts of a combination does not leave usable alternatives behind.
  for (const candidate of fallbackPicks(menus, target, budgetPerMeal, '', 12, preferences)) {
    if (picks.length === MAX_PICKS) break;
    if (componentsOf(candidate).some((component) => usedComponents.has(componentKey(candidate, component.itemId)))) continue;
    append(candidate);
  }
  return picks;
}

// Returns up to 3 candidates, ranked best-first by actual distance to the
// macro target. Every candidate is guaranteed to be a real item from the
// scraped menus — the model only chooses among ids. Macros are verified
// against USDA FoodData Central where a confident match exists; otherwise
// the LLM's estimate is kept unless it just copies every target value.
export async function pickMeals(
  menus: StoreMenu[],
  mealConfig: MealConfig,
  dailyMacros: MacroGoals,
  budgetPerMeal: number,
  // Natural-language brief from the user's onboarding plan (see plan.ts). It
  // carries what the numeric targets can't: delivery context, cuisine
  // preferences and dietary constraints.
  brief = "",
  dependencies: {
    client: OpenAI;
    nutrition: typeof lookupNutrition;
    sleep: (ms: number) => Promise<void>;
    shuffle?: <T>(items: readonly T[]) => T[];
  } = { client: openai, nutrition: lookupNutrition, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
  signal?: AbortSignal,
  preferences: FoodPreferences = {},
): Promise<PickMealsResult> {
  const target = {
    calories: Math.round(dailyMacros.calories * mealConfig.macroShare),
    protein: Math.round(dailyMacros.protein * mealConfig.macroShare),
    carbs: Math.round(dailyMacros.carbs * mealConfig.macroShare),
    fat: Math.round(dailyMacros.fat * mealConfig.macroShare),
  };

  const limit = Math.max(1, Math.min(60, Math.floor(Number(process.env.MACROME_MAX_MENU_ITEMS) || 20)));
  const lookup = new Map<string, { menu: StoreMenu; item: StoreMenu["items"][number] }>();
  // Round-robin across stores: a large first menu must not crowd out all others.
  // Each menu is shuffled so the picker doesn't always see the same dishes.
  const shuffle = dependencies.shuffle ?? shuffled;
  const eligible = menus.map((menu) => ({ menu, items: shuffle(menu.items.filter((item) => item.price > 0 && item.price <= budgetPerMeal && isMealCandidate(item, preferences))) }));
  const lines: string[] = [];
  for (let index = 0; index < Math.max(0, ...eligible.map((entry) => entry.items.length)) && lookup.size < limit; index++) {
    for (const [storeIndex, { menu, items }] of eligible.entries()) {
      const item = items[index];
      if (!item || lookup.size >= limit) continue;
      const id = `${storeIndex}:${item.id}`;
      lookup.set(id, { menu, item });
      lines.push(`  [${id}] ${menu.store} / ${item.name} — $${item.price.toFixed(2)} — ${item.description.slice(0, 160)}`);
    }
  }
  const menuText = lines.join('\n');

  if (lookup.size === 0) {
    const picks = fallbackPicks(menus, target, budgetPerMeal, 'No eligible items reached the model.', 3, preferences);
    return { picks, debug: { systemPrompt: "", userPrompt: "", rawResponse: "fallback: empty lookup" } };
  }

  const briefSection = brief ? `\nThe customer's plan for this order:\n${brief}\n` : "";

  const systemPrompt = `You are a nutrition-aware meal selector. Choose menu items that best match the macro targets.
${briefSection}
Macro targets for this meal (${mealConfig.name}):
- Calories: ${target.calories} kcal
- Protein: ${target.protein}g
- Carbs: ${target.carbs}g
- Fat: ${target.fat}g
- Max budget: $${budgetPerMeal}

Rules: only choose ids that appear in the menu in [brackets]. Each choice can be one item OR a combination of TWO distinct items from the SAME restaurant (one serving of each). Combine a main with a protein or side when that better matches the targets. Do not choose family-size meals, bundles, drinks, or unavailable add-ons. The SUM of menu prices must fit the max food budget above, and the SUM of macros should match the meal targets as closely as possible; prioritize protein. Estimate macros for EACH component from its name and description. All components must obey dietary requirements and avoided ingredients as hard constraints. Do not invent quantities, items, prices or exact macro matches. If nothing is suitable, return an empty array. Write the brief reason as a confident macro justification (calories, protein, carbs, fat vs the targets); never apologize or call a choice a fallback.
Compare all the supplied restaurants. Include affordable alternatives across different restaurants when available.
Return ONLY valid JSON, no extra text: a ranked array of up to 3 choices, best first:
[{"items":[{"itemId":"0:123","estimatedMacros":{"calories":0,"protein":0,"carbs":0,"fat":0}}],"reasoning":"brief reason, including combined macro fit"}]`;

  const userPrompt = `Menus:\n\n${menuText}\n\nReturn the ranked JSON array.`;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const model = process.env.MACROME_MODEL || FREE_MODEL;
  console.log(`[picker] model=${model}; ${lookup.size} menu items; ${MAX_PICKS} choices; prompt=${systemPrompt.length + userPrompt.length} characters; up to 2 requests of 45s.`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted();
    const started = Date.now();
    try {
      const request = { model, messages, temperature: 0.2, max_tokens: 1200, reasoning: { enabled: false } };
      const response = await dependencies.client.chat.completions.create(request, { timeout: 45000, maxRetries: 0, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
      console.log(`[picker] attempt ${attempt}/2 completed in ${Date.now() - started}ms; finish=${response.choices?.[0]?.finish_reason}; tokens=${response.usage?.total_tokens ?? 'unknown'}.`);
      const rawResponse = response.choices?.[0]?.message?.content ?? "";
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error(`Model did not return a JSON array. Got: ${rawResponse}`);

      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) throw new Error('Model response was not an array.');
      if (parsed.length === 0) {
        console.log(`[picker] Model returned no choices; using menu heuristic fallback. Food cap: $${budgetPerMeal.toFixed(2)}; target: ${target.calories} kcal, ${target.protein}P/${target.carbs}C/${target.fat}F.`);
        const picks = fallbackPicks(menus, target, budgetPerMeal, 'Model returned no choices; ranked eligible meals by estimated macros.', 3, preferences);
        return { picks, debug: { systemPrompt, userPrompt, rawResponse } };
      }
      const ranked = (parsed as Ranked[]).slice(0, MAX_PICKS).flatMap((r) => {
        if (!r || typeof r.reasoning !== 'string') return [];
        const items = r.items ?? (r.itemId && r.estimatedMacros ? [{ itemId: r.itemId, estimatedMacros: r.estimatedMacros }] : []);
        if (!Array.isArray(items) || items.length < 1 || items.length > 2) return [];
        const components = items.map((item) => ({ r: item, hit: lookup.get(String(item?.itemId)) }));
        if (new Set(items.map((item) => item?.itemId)).size !== items.length) return [];
        if (!components.every((component): component is { r: RankedItem; hit: NonNullable<typeof component.hit> } => Boolean(component.hit) &&
          Boolean(component.r?.estimatedMacros) && ['calories', 'protein', 'carbs', 'fat'].every((key) => {
            const value = component.r.estimatedMacros[key as keyof MealMacros];
            return typeof value === 'number' && Number.isFinite(value) && value >= 0;
          }))) return [];
        if (new Set(components.map(({ hit }) => hit.menu.url)).size !== 1) return [];
        const price = Math.round(components.reduce((sum, { hit }) => sum + hit.item.price, 0) * 100) / 100;
        if (price > budgetPerMeal) return [];
        return [{ reasoning: r.reasoning, components, price }];
      });
      if (ranked.length === 0) throw new Error('Model returned no valid, same-restaurant choices within budget.');

      const picks: PickedMeal[] = await Promise.all(ranked.map(async (choice) => {
        const components = await Promise.all(choice.components.map(async ({ r, hit }) => {
          const usda = await dependencies.nutrition(hit.item.name);
          const targetCopy = !usda && copiesTarget(r.estimatedMacros, target);
          // A menu description can list mutually exclusive protein options. A
          // name-only heuristic does not count an unselected option as eaten.
          const estimatedMacros = usda?.macros ?? (targetCopy
            ? estimateMacrosFromName(hit.item.name, hit.item.price)
            : r.estimatedMacros);
          if (targetCopy) console.log(`[picker] Replaced exact-target estimate for ${hit.item.name} with a rough menu estimate; nutrition was unverified.`);
          return { itemId: hit.item.id, item: hit.item.name, price: hit.item.price, estimatedMacros, verified: Boolean(usda), targetCopy };
        }));
        const macros = components.reduce((sum, component) => ({
          calories: sum.calories + component.estimatedMacros.calories,
          protein: sum.protein + component.estimatedMacros.protein,
          carbs: sum.carbs + component.estimatedMacros.carbs,
          fat: sum.fat + component.estimatedMacros.fat,
        }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
        const item = components.map((component) => component.item).join(' + ');
        const restaurant = choice.components[0].hit.menu.store;
        return {
          selectionId: JSON.stringify([choice.components[0].hit.menu.url, ...components.map((component) => component.itemId).sort()]),
          itemId: components[0].itemId,
          item,
          components: components.map(({ verified, targetCopy, ...component }) => component),
          restaurant,
          storeUrl: choice.components[0].hit.menu.url,
          price: choice.price,
          estimatedMacros: macros,
          reasoning: components.some((component) => component.targetCopy)
            ? demoJustification(item, restaurant, macros, target, choice.price)
            : confidentReasoning(choice.reasoning, item, restaurant, macros, target, choice.price),
          source: components.every((component) => component.verified) ? 'usda' as const : 'estimated' as const,
          macroConsistent: isMacroConsistent(macros),
          score: distanceScore(macros, target),
        };
      }));

      picks.sort((a, b) => a.score - b.score);
      const shortlist = fillShortlist(picks, menus, target, budgetPerMeal, preferences);
      if (shortlist.length > picks.length) {
        console.log(`[picker] Model supplied ${picks.length} valid choice(s); added ${shortlist.length - picks.length} eligible menu alternative(s).`);
      }
      return { picks: shortlist, debug: { systemPrompt, userPrompt, rawResponse } };
    } catch (err) {
      if (signal?.aborted) {
        const picks = fallbackPicks(menus, target, budgetPerMeal, 'Selection aborted — using eligible menu meals instead.', 3, preferences);
        if (picks.length) return { picks, debug: { systemPrompt, userPrompt, rawResponse: 'fallback: aborted' } };
        throw err;
      }
      lastError = err;
      const status = (err as { status?: number }).status;
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.log(`[picker] attempt ${attempt}/2 failed after ${Date.now() - started}ms: ${status ? `HTTP ${status}: ` : ''}${reason}`);
      // Hard 4xx (except timeout-like 408): don't burn a second attempt.
      if (status && status >= 400 && status < 500 && status !== 408) break;
      if (attempt < 2) {
        await dependencies.sleep(500);
        continue;
      }
      break;
    }
  }
  const picks = fallbackPicks(
    menus,
    target,
    budgetPerMeal,
    `Model picker failed (${lastError instanceof Error ? lastError.message.split('\n')[0] : lastError}) — ranked menu items by estimated macros instead.`,
    3,
    preferences,
  );
  if (picks.length === 0) {
    return { picks: [], debug: { systemPrompt, userPrompt, rawResponse: `fallback-empty: ${lastError}` } };
  }
  console.log(`[picker] Serving ${picks.length} heuristic fallback pick(s) after model failure.`);
  return { picks, debug: { systemPrompt, userPrompt, rawResponse: `fallback after: ${lastError}` } };
}
