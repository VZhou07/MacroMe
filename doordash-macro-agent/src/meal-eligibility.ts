import type { MenuItem } from './types.js';

export interface FoodPreferences { dietary?: string[]; avoid?: string }

// A snack can have a plausible macro score when nutrition is inferred from its
// price. Keep the meal picker focused on single-serving prepared meals.
const nonMeals = /\b(cookie|cookies|brownie|brownies|cake|cupcake|muffin|donut|doughnut|fudge|chocolate|granola|chips|crackers|dip|dressing|vinaigrette|rub|compote|jam|syrup|beverage|drink|smoothie|juice|soda|bar|shot)\b/i;
const bulk = /\b(half dozen|dozen|family.size|party|bulk|bottle|\d+\s*(?:grams|ml|oz)\b|bake.and.serve)\b/i;
const dairy = /\b(milk|cheese|cream|creamy|butter|yogurt|yoghurt|whey|ghee|feta|parmesan|mozzarella|cheddar|paneer|tzatziki|labneh|ranch)\b/i;

export function isMealCandidate(item: MenuItem, preferences: FoodPreferences = {}): boolean {
  const name = item.name.trim();
  const description = item.description.trim();
  if (!name || nonMeals.test(name) || bulk.test(`${name} ${description}`)) return false;
  const full = `${name} ${description}`;
  const avoid = (preferences.avoid ?? '').toLowerCase().split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  if (avoid.some(s => full.toLowerCase().includes(s))) return false;
  const restrictions = (preferences.dietary ?? []).join(' ').toLowerCase();
  const withoutPlantMilk = full.replace(/\b(?:oat|almond|soy|coconut) milk\b/gi, '');
  if (/dairy.free|lactose|vegan/.test(restrictions) && dairy.test(withoutPlantMilk)) return false;
  if (/\b(vegan|vegetarian)\b/.test(restrictions) && /\b(chicken|beef|pork|bacon|ham|turkey|fish|salmon|tuna|shrimp|steak)\b/i.test(full)) return false;
  return true;
}
