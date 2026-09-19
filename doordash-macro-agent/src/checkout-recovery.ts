import type { ModifierContext } from './modifiers.js';
import type { Page } from 'playwright-core';
import type { CheckoutSummary, PickedMeal } from './types.js';
import { addItemToCart, clearCart, editCartLine, goToCheckout } from './doordash.js';
import { cartCost, decideRecovery } from './recovery.js';
import { addMealToCart, cartContainsMeal } from './meal-components.js';
import { BrowserUnavailableError } from './browser-work.js';
import { emit } from './events.js';
import { reconcileUncertainAdd } from './cart-reconciliation.js';

export class CheckoutRecoveryError extends Error {
  constructor(message: string, public diagnostics: unknown[]) { super(message); }
}

const INSPECT_FAIL = /timeout|time budget|navigation did not finish|could not read|not readable|null/i;

/** Soft settle after a failed checkout read — avoid reloading on the first tries. */
async function settleAfterInspectFailure(page: Page, reload: boolean): Promise<void> {
  await page.keyboard?.press?.('Escape')?.catch?.(() => {});
  await page.waitForTimeout(800);
  if (reload) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

export async function prepareCheckout(page: Page, initialPick: PickedMeal, candidates: PickedMeal[], options: {
  budget: number; includesFees: boolean; brief: string; onPage?: (page: Page) => void;
} & ModifierContext, dependencies: {
  inspect: typeof goToCheckout; edit: typeof editCartLine; clear: typeof clearCart;
  add: typeof addItemToCart; decide: typeof decideRecovery; reconcile?: typeof reconcileUncertainAdd;
} = { inspect: goToCheckout, edit: editCartLine, clear: clearCart, add: addItemToCart, decide: decideRecovery, reconcile: reconcileUncertainAdd }) {
  let picked = initialPick;
  const history: string[] = [];
  const evidence: unknown[] = [];
  const deadline = Date.now() + 4 * 60000;
  let consecutiveInspectFailures = 0;
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
    let cart: CheckoutSummary | null = null;
    let problem = '';
    try {
      cart = await dependencies.inspect(page);
      if (!cart) throw new Error('Checkout navigation did not finish');
      evidence.push({ phase: 'inspect', cart });
      consecutiveInspectFailures = 0;
      const cost = cartCost(cart, options.includesFees);
      const containsPick = cartContainsMeal(cart, picked);
      if (cost <= options.budget && containsPick) return { checkout: cart, picked, evidence, page };
      problem = [!containsPick ? 'Cart components, quantities or modifiers do not match the recommended meal.' : '',
        cost > options.budget ? `Cart costs ${cost.toFixed(2)}, above the ${options.budget.toFixed(2)} ${options.includesFees ? 'all-in' : 'food'} budget.` : ''].filter(Boolean).join(' ');
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error;
      problem = String(error).split('\n')[0];
      consecutiveInspectFailures += 1;
      evidence.push({ phase: 'inspect', reason: problem });
    }

    // After a successful add, DoorDash often needs a couple of Continue clicks
    // before Place Order is readable. Don't ask the model to stop yet.
    if (!cart && consecutiveInspectFailures <= 3 && INSPECT_FAIL.test(problem)) {
      const message = `Recovery ${attempt + 1}/8: Checkout not readable yet (${problem}); retrying navigation.`;
      console.log(`[agent] ${message}`);
      emit({ type: 'status', message });
      history.push(`deterministic-inspect-retry: ${problem}`);
      await settleAfterInspectFailure(page, consecutiveInspectFailures >= 3);
      continue;
    }

    const action = await dependencies.decide({ ...options, cart, candidates, problem, history });
    let resolved = action;
    if (action.action === 'stop' && !cart && consecutiveInspectFailures < 6) {
      resolved = {
        action: 'retry',
        reasoning: `Checkout still unreadable (${problem}); forcing another navigation retry instead of stopping early.`,
      };
    }
    const message = `Recovery ${attempt + 1}/8: ${resolved.reasoning}`;
    console.log(`[agent] ${message}`);
    emit({ type: 'status', message });
    if (resolved.action === 'stop') throw new CheckoutRecoveryError(resolved.reasoning, evidence);
    try {
      if (resolved.action === 'remove' || resolved.action === 'decrease') {
        if (!cart) throw new Error('Cart must be readable before editing');
        await dependencies.edit(page, cart, resolved.line, resolved.action);
      } else if (resolved.action === 'replace') {
        if (!cart || !candidates[resolved.candidate]) throw new Error('Invalid replacement');
        const replacement = candidates[resolved.candidate];
        await dependencies.clear(page, cart);
        const result = await addMealToCart(page, replacement, dependencies.add, options);
        evidence.push({ phase: 'replacement', result });
        picked = replacement;
        if (result.status === 'uncertain') {
          try {
            const reconciled = await (dependencies.reconcile ?? reconcileUncertainAdd)(page, replacement);
            page = reconciled.page;
            options.onPage?.(page);
            evidence.push({ phase: 'replacement-reconciliation', matched: reconciled.matched, cart: reconciled.cart });
          } catch (error) {
            evidence.push({ phase: 'replacement-reconciliation', reason: String(error).split('\n')[0] });
            throw new CheckoutRecoveryError('Replacement cart could not be reconciled; no further mutations.', evidence);
          }
          continue;
        }
        if (!result.ok) throw new Error(`Replacement add: ${result.reason}`);
      } else {
        await settleAfterInspectFailure(page, history.filter((line) => /retry|inspect/i.test(line)).length >= 2);
      }
      history.push(`${JSON.stringify(resolved)}: executed; inspect fresh cart next`);
    } catch (error) {
      if (error instanceof BrowserUnavailableError || error instanceof CheckoutRecoveryError) throw error;
      history.push(`${JSON.stringify(resolved)} failed: ${String(error).split('\n')[0]}`);
      evidence.push({ phase: 'recovery', action: resolved, reason: String(error).split('\n')[0] });
    }
  }
  throw new CheckoutRecoveryError(`Could not prepare a verified cart within budget after recovery attempts. No order placed. ${history.at(-1) ?? ''}`, evidence);
}
