import type { Page } from 'playwright-core';
import type { CheckoutSummary, PickedMeal } from './types.js';
import { addItemToCart, clearCart, editCartLine, goToCheckout } from './doordash.js';
import { cartCost, decideRecovery } from './recovery.js';
import { emit } from './events.js';

export async function prepareCheckout(page: Page, initialPick: PickedMeal, candidates: PickedMeal[], options: {
  budget: number; includesFees: boolean; brief: string;
}, dependencies = { inspect: goToCheckout, edit: editCartLine, clear: clearCart, add: addItemToCart, decide: decideRecovery }) {
  let picked = initialPick;
  const history: string[] = [];
  const deadline = Date.now() + 4 * 60000;
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
    let cart: CheckoutSummary | null = null;
    let problem = '';
    try {
      cart = await dependencies.inspect(page);
      if (!cart) throw new Error('Checkout navigation did not finish');
      const cost = cartCost(cart, options.includesFees);
      const containsPick = cart.cartItems.some((line) => line.name.toLowerCase() === picked.item.toLowerCase());
      if (cost <= options.budget && containsPick) return { checkout: cart, picked };
      problem = !containsPick ? 'The recommended dish is no longer in the cart. Replace with a suitable candidate.'
        : `Cart costs ${cost.toFixed(2)}, above the ${options.budget.toFixed(2)} ${options.includesFees ? 'all-in' : 'food'} budget.`;
    } catch (error) {
      problem = String(error).split('\n')[0];
    }
    const action = await dependencies.decide({ ...options, cart, candidates, problem, history });
    const message = `Recovery ${attempt + 1}/8: ${action.reasoning}`;
    console.log(`[agent] ${message}`);
    emit({ type: 'status', message });
    if (action.action === 'stop') throw new Error(action.reasoning);
    try {
      if (action.action === 'remove' || action.action === 'decrease') {
        if (!cart) throw new Error('Cart must be readable before editing');
        await dependencies.edit(page, cart, action.line, action.action);
      } else if (action.action === 'replace') {
        if (!cart || !candidates[action.candidate]) throw new Error('Invalid replacement');
        const replacement = candidates[action.candidate];
        await dependencies.clear(page, cart);
        const result = await dependencies.add(page, replacement.storeUrl, replacement.itemId);
        // An ambiguous add is inspected on the next iteration, never blindly repeated.
        picked = replacement;
        if (!result.ok) throw new Error(`Replacement add: ${result.reason}`);
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);
      }
      history.push(`${JSON.stringify(action)}: executed; inspect fresh cart next`);
    } catch (error) {
      history.push(`${JSON.stringify(action)} failed: ${String(error).split('\n')[0]}`);
    }
  }
  throw new Error(`Could not prepare a verified cart within budget after recovery attempts. No order placed. ${history.at(-1) ?? ''}`);
}
