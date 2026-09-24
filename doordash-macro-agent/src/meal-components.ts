import type { Page } from 'playwright-core';
import type { CheckoutSummary, PickedMeal } from './types.js';
import type { AddToCartResult, AddOptions } from './doordash.js';
import { BrowserUnavailableError } from './browser-work.js';
import { matchesSelectedOptions } from './cart-modifiers.js';

export function mealComponents(pick: PickedMeal) {
  return pick.components?.length ? pick.components : [{ itemId: pick.itemId, item: pick.item, price: pick.price, estimatedMacros: pick.estimatedMacros, selectedOptions: pick.selectedOptions, customizationPrice: pick.customizationPrice }];
}
const normalize = (s: string) => s.trim().toLowerCase();

/** Exact quantities and customizations: extra lines must never confirm a meal. */
export function cartContainsMeal(cart: CheckoutSummary, pick: PickedMeal): boolean {
  const remaining = cart.cartItems.map(line => ({ ...line }));
  for (const component of mealComponents(pick)) {
    const line = remaining.find(line => line.quantity > 0 && normalize(line.name) === normalize(component.item) &&
      matchesSelectedOptions(line.modifiers, component.selectedOptions ?? []));
    if (!line) return false;
    line.quantity--;
  }
  return remaining.every(line => line.quantity === 0);
}

/** Stop a partial meal at the first ambiguity. The caller must inspect before another mutation. */
export async function addMealToCart(page: Page, pick: PickedMeal,
  add: (page: Page, url: string, itemId: string, options?: AddOptions) => Promise<AddToCartResult>,
  context: AddOptions = {}): Promise<AddToCartResult> {
  let added = 0;
  const selectedOptions: string[] = [];
  const diagnostics: unknown[] = [];
  for (const component of mealComponents(pick)) {
    try {
      let customized = false;
      const previousExtra = component.customizationPrice ?? 0;
      const applyCustomization = (customization: NonNullable<AddToCartResult['customization']>) => {
        if (customized) return;
        customized = true;
        component.selectedOptions = customization.selectedOptions;
        if (!pick.components?.length) pick.selectedOptions = customization.selectedOptions;
        if (customization.estimatedMacros) {
          component.estimatedMacros = customization.estimatedMacros;
          if (!pick.components?.length) pick.estimatedMacros = component.estimatedMacros;
          pick.source = 'estimated';
        }
        pick.price += customization.extraPrice - previousExtra;
        component.customizationPrice = customization.extraPrice;
        if (pick.components?.length) component.price += customization.extraPrice - previousExtra;
        else pick.customizationPrice = customization.extraPrice;
        if (pick.components?.length) pick.estimatedMacros = pick.components.reduce((sum,c) => ({ calories: sum.calories+c.estimatedMacros.calories, protein: sum.protein+c.estimatedMacros.protein, carbs: sum.carbs+c.estimatedMacros.carbs, fat: sum.fat+c.estimatedMacros.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
        const macros = pick.estimatedMacros;
        pick.macroConsistent = Math.abs(macros.calories - (macros.protein*4 + macros.carbs*4 + macros.fat*9)) <= macros.calories*.15;
        if (context.target) pick.score = (['calories','protein','carbs','fat'] as const).reduce((sum,k) => sum + Math.abs(macros[k]-context.target![k])/Math.max(1,context.target![k])*(k==='protein'?2:1),0)/5;
      };
      const result = await add(page, pick.storeUrl, component.itemId, { ...context, item: component.item, basePrice: pick.price - previousExtra, clearExisting: added === 0, onCustomization: applyCustomization });
      selectedOptions.push(...(result.selectedOptions ?? []));
      diagnostics.push(result);
      if (result.customization?.complete) applyCustomization(result.customization);
      if (!customized && result.selectedOptions) {
        component.selectedOptions = result.selectedOptions;
        if (!pick.components?.length) pick.selectedOptions = result.selectedOptions;
      }
      if (!result.ok) return { ...result, status: added ? 'uncertain' : result.status ?? (result.reason === 'add-unconfirmed' ? 'uncertain' : 'failed'), selectedOptions, diagnostics };
      added++;
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error;
      return { ok: false, status: 'uncertain', phase: 'component', reason: String(error).split('\n')[0], selectedOptions, diagnostics };
    }
  }
  if (pick.components?.length) pick.estimatedMacros = pick.components.reduce((sum,c) => ({ calories: sum.calories+c.estimatedMacros.calories, protein: sum.protein+c.estimatedMacros.protein, carbs: sum.carbs+c.estimatedMacros.carbs, fat: sum.fat+c.estimatedMacros.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return { ok: true, status: 'confirmed', phase: 'cart', selectedOptions, diagnostics };
}
