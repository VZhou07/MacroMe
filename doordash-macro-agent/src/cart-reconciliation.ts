import type { Page } from 'playwright-core';
import type { PickedMeal } from './types.js';
import { closePage, navigate } from './browser-work.js';
import { clearCart, inspectCart } from './doordash.js';
import { cartContainsMeal } from './meal-components.js';

/** Own and cancel the mutation tab before inspecting through a fresh tab. */
export async function reconcileUncertainAdd(page: Page, pick: PickedMeal, dependencies = {
  close: closePage,
  open: async (previous: Page, url: string) => {
    const fresh = await previous.context().newPage();
    try { await navigate(fresh, url, ['[data-testid="storeInfo"]', '[data-testid="MenuItem"]'], 'cart reconciliation', { attemptMs: 35000 }); return fresh; }
    catch (error) { await closePage(fresh, 'reconciliation navigation'); throw error; }
  },
  inspect: inspectCart, clear: clearCart,
}) {
  await dependencies.close(page, 'uncertain add');
  const fresh = await dependencies.open(page, pick.storeUrl);
  try {
    let cart = null;
    for (let read = 0; read < 3; read++) {
      cart = await dependencies.inspect(fresh).catch(() => null);
      if (cart && cartContainsMeal(cart, pick)) return { page: fresh, matched: true, cart };
      await fresh.waitForTimeout(1000);
    }
    if (!cart) throw new Error('uncertain-cart-unreadable; no further mutations');
    if (cart.cartItems.length) await dependencies.clear(fresh, cart);
    return { page: fresh, matched: false, cart };
  } catch (error) {
    await dependencies.close(fresh, 'reconciliation failed');
    throw error;
  }
}
