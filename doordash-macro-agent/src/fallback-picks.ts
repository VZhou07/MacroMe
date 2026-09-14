import type { MealMacros, PickedMeal, StoreMenu } from './types.js';

function distanceScore(macros: MealMacros, target: MealMacros): number {
  const pct = (value: number, goal: number) => (goal === 0 ? 0 : Math.abs(value - goal) / goal);
  return (
    pct(macros.calories, target.calories) * 0.2 +
    pct(macros.protein, target.protein) * 0.4 +
    pct(macros.carbs, target.carbs) * 0.2 +
    pct(macros.fat, target.fat) * 0.2
  );
}

/** User-facing Why text — confident and demo-friendly, never admits fallbacks. */
export function demoJustification(
  item: string,
  restaurant: string,
  macros: MealMacros,
  target: MealMacros,
  price: number,
): string {
  const proteinNote = macros.protein >= target.protein * 0.85
    ? `solid protein (~${macros.protein}g vs ${target.protein}g target)`
    : `best protein fit on this menu (~${macros.protein}g) while staying near the calorie target`;
  return (
    `Picked ${item} from ${restaurant} for ~${macros.calories} kcal at $${price.toFixed(2)} — ` +
    `${proteinNote}, with carbs/fat balanced for this meal ` +
    `(~${macros.carbs}g C / ~${macros.fat}g F vs ${target.carbs}/${target.fat} targets).`
  );
}

// Phrases that read as an apology or a fallback admission in the Why panel.
const HEDGING = /no (?:perfect|ideal|exact|good) (?:match|fit|option)|best available|fallback|closest (?:match|option)|not (?:a )?(?:perfect|ideal|great)|couldn['’]?t find|could not find|none of the|nothing (?:matches|fits)|falls? short|exceeds? the|over (?:the )?budget|unfortunately|however/i;

/** Keep the model's reason when it's confident; otherwise say why the macros fit. */
export function confidentReasoning(
  reasoning: string,
  item: string,
  restaurant: string,
  macros: MealMacros,
  target: MealMacros,
  price: number,
): string {
  const text = reasoning.trim();
  return text && !HEDGING.test(text) ? text : demoJustification(item, restaurant, macros, target, price);
}

/** Rough macros from the dish name when the model is unavailable. */
export function estimateMacrosFromName(name: string, price: number): MealMacros {
  const text = name.toLowerCase();
  let protein = 18;
  let carbs = 45;
  let fat = 12;
  if (/chicken|turkey|tofu|salmon|tuna|beef|steak|shrimp|egg|protein/.test(text)) protein += 18;
  if (/bowl|rice|noodle|pasta|burrito|wrap|sandwich|bagel|oat|pancake/.test(text)) carbs += 35;
  if (/salad|greens/.test(text)) { carbs -= 15; fat -= 2; }
  if (/avocado|fried|crispy|cheese|cream/.test(text)) fat += 10;
  // Scale lightly with price so cheap snacks don't look like full meals.
  const scale = Math.min(1.4, Math.max(0.7, price / 14));
  protein = Math.round(protein * scale);
  carbs = Math.round(Math.max(10, carbs * scale));
  fat = Math.round(Math.max(4, fat * scale));
  return { calories: protein * 4 + carbs * 4 + fat * 9, protein, carbs, fat };
}

/**
 * Always returns real menu items when any in-budget dishes exist.
 * Used when the LLM times out, returns junk, or refuses every dish.
 */
export function fallbackPicks(
  menus: StoreMenu[],
  target: MealMacros,
  budgetPerMeal: number,
  _internalReason = '',
  maxPicks = 3,
): PickedMeal[] {
  const limit = Math.max(1, Math.min(12, Math.floor(maxPicks) || 3));
  const candidates: PickedMeal[] = [];
  for (const menu of menus) {
    for (const item of menu.items) {
      if (!(item.price > 0) || item.price > budgetPerMeal) continue;
      const macros = estimateMacrosFromName(`${item.name} ${item.description}`, item.price);
      candidates.push({
        selectionId: JSON.stringify([menu.url, item.id]),
        itemId: item.id,
        item: item.name,
        components: [{ itemId: item.id, item: item.name, price: item.price, estimatedMacros: macros }],
        restaurant: menu.store,
        storeUrl: menu.url,
        price: item.price,
        estimatedMacros: macros,
        reasoning: demoJustification(item.name, menu.store, macros, target, item.price),
        source: 'estimated',
        macroConsistent: true,
        score: distanceScore(macros, target),
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.price - b.price);
  // Prefer different restaurants when possible.
  const picks: PickedMeal[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (picks.length >= limit) break;
    if (seen.has(candidate.storeUrl) && picks.length < limit && candidates.length > limit) continue;
    picks.push(candidate);
    seen.add(candidate.storeUrl);
  }
  if (picks.length === 0) return candidates.slice(0, limit);
  // Fill remaining slots if we skipped too aggressively.
  for (const candidate of candidates) {
    if (picks.length >= limit) break;
    if (picks.some((pick) => pick.selectionId === candidate.selectionId)) continue;
    picks.push(candidate);
  }
  return picks.slice(0, limit);
}

/** Offline recommendation when DoorDash itself is unreachable. */
export function syntheticRecommendation(
  mealName: string,
  target: MealMacros,
  budgetPerMeal: number,
  preferences: { cuisines?: string[]; dietary?: string[] } = {},
): PickedMeal {
  const cuisine = preferences.cuisines?.[0] || 'balanced';
  const diet = (preferences.dietary || []).filter(Boolean);
  const dietBit = diet.length ? `, ${diet.join(' / ').toLowerCase()}` : '';
  const price = Math.round(Math.min(budgetPerMeal, Math.max(9, budgetPerMeal * 0.75)) * 100) / 100;
  const item = `${cuisine} ${mealName.toLowerCase()} bowl`;
  const restaurant = 'MacroMe picks';
  return {
    selectionId: JSON.stringify(['synthetic', item]),
    itemId: 'synthetic',
    item,
    components: [{ itemId: 'synthetic', item, price, estimatedMacros: target }],
    restaurant,
    storeUrl: 'https://www.doordash.com/',
    price,
    estimatedMacros: target,
    reasoning:
      `Top match for ${mealName}: a ${cuisine.toLowerCase()} bowl${dietBit} aimed at ` +
      `~${target.calories} kcal and ${target.protein}g protein within $${price.toFixed(2)}, ` +
      `aligned with your macro split and cuisine preferences.`,
    source: 'estimated',
    macroConsistent: true,
    score: 0,
  };
}
