import type { ModifierContext, ModifierResult, OptionGroup } from './modifiers.js';

// Harvest's January 2026 allergen guide marks its GF wrap (used in the vegan
// breakfast burrito), Chicken and Peanut Tofu add-ons, and Thai Peanut Sauce as
// dairy-free. The Thai Peanut Burrito itself has no row in that guide, so this
// evidence applies only while DoorDash still shows the documented ingredients
// and the exact observed choices below. Do not generalize it to other items.
// https://static1.squarespace.com/static/6581fc77643f7b03addc416b/t/6973d19208fc247f47ad91d6/1769197970697/HARVEST_NutritionInfo_Jan2026.pdf
// https://www.harvestcleaneats.ca/menu
const harvestThaiPeanutBurrito = {
  storeId: '50516008',
  item: 'Thai Peanut Burrito',
  ingredients: 'Rice, Purple Cabbage, Shredded Carrot, Cucumber, Green Onion, Peanuts, Choice of Peanut Tofu or Roasted Chicken, Cilantro, Thai Peanut Sauce',
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const choiceName = (label: string) => normalize(label.replace(/\s*\+\s*(?:CA)?\$\s*[\d.]+\s*$/i, ''));

function matchesHarvestThaiPeanutBurrito(context: ModifierContext): boolean {
  if (!new RegExp(`/store/(?:[^/]*-)?${harvestThaiPeanutBurrito.storeId}/`).test(context.storeUrl ?? '') ||
      normalize(context.item ?? '') !== normalize(harvestThaiPeanutBurrito.item)) return false;
  const observed = normalize(context.description ?? '');
  const ingredients = normalize(harvestThaiPeanutBurrito.ingredients);
  const titleAndIngredients = `${normalize(harvestThaiPeanutBurrito.item)} ${ingredients}`;
  // Only a trailing menu price may differ. A newly added ingredient invalidates
  // the source-backed clearance until the restaurant evidence is rechecked.
  const remainder = observed.startsWith(titleAndIngredients) ? observed.slice(titleAndIngredients.length).trim()
    : observed.startsWith(ingredients) ? observed.slice(ingredients.length).trim() : null;
  return remainder !== null && (remainder === '' || /^(?:ca )?\d+ \d{2}$/.test(remainder));
}

export function sourceBackedDairyFreeChoice(context: ModifierContext, group: OptionGroup, label: string): boolean {
  if (!matchesHarvestThaiPeanutBurrito(context)) return false;
  const groupName = normalize(group.label);
  const name = choiceName(label);
  // The unlabeled "Wrap" could differ from the documented multigrain wrap.
  if (groupName === 'wrap options') return name === 'gluten free wrap' || name === 'gf wrap';
  if (groupName === 'tofu chicken') return name === 'chicken' || name === 'peanut tofu';
  return false;
}

export function sourceBackedDairyFreeMeal(context: ModifierContext, result: ModifierResult): boolean {
  if (!matchesHarvestThaiPeanutBurrito(context) || !result.complete || context.preferences?.avoid) return false;
  const dietary = context.preferences?.dietary ?? [];
  if (dietary.length === 0 || !dietary.every(value => /^(?:dairy[ -]free|lactose[ -]free)$/i.test(value.trim()))) return false;
  const required = result.groups.filter(group => group.min > 0);
  if (required.length !== 2 || !required.some(group => normalize(group.label) === 'wrap options') ||
      !required.some(group => normalize(group.label) === 'tofu chicken')) return false;
  return result.groups.every(group => {
    const selected = group.choices.filter(choice => choice.selected);
    if (group.min === 0) return selected.length === 0;
    return selected.length === 1 && sourceBackedDairyFreeChoice(context, group, selected[0].label);
  });
}
