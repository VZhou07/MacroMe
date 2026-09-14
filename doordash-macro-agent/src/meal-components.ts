import type { Page } from 'playwright-core';
import type { CheckoutSummary, PickedMeal } from './types.js';
import type { AddToCartResult } from './doordash.js';
import { BrowserUnavailableError } from './browser-work.js';

export function mealComponents(pick: PickedMeal) {
  return pick.components?.length ? pick.components : [{ itemId: pick.itemId, item: pick.item, price: pick.price, estimatedMacros: pick.estimatedMacros }];
}

export function cartContainsMeal(cart: CheckoutSummary, pick: PickedMeal): boolean {
  const needed = new Map<string, number>();
  for (const component of mealComponents(pick)) {
    const name = component.item.toLowerCase();
    needed.set(name, (needed.get(name) || 0) + 1);
  }
  return [...needed].every(([name, quantity]) => cart.cartItems
    .filter((line) => line.name.toLowerCase() === name)
    .reduce((total, line) => total + line.quantity, 0) >= quantity);
}

/** One copy of each component, from one restaurant. Partial adds need inspection. */
export async function addMealToCart(page: Page, pick: PickedMeal,
  add: (page: Page, url: string, itemId: string, options?: { clearExisting?: boolean }) => Promise<AddToCartResult>): Promise<AddToCartResult> {
  let added = 0;
  for (const component of mealComponents(pick)) {
    try {
      // Clear leftovers only before the first component so combos can stack.
      const result = await add(page, pick.storeUrl, component.itemId, { clearExisting: added === 0 });
      if (!result.ok) return added ? { ok: false, reason: 'add-unconfirmed' } : result;
      added++;
    } catch (error) {
      if (error instanceof BrowserUnavailableError || added === 0) throw error;
      return { ok: false, reason: 'add-unconfirmed' };
    }
  }
  return { ok: true };
}
