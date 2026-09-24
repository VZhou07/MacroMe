/** Replays the failed Harvest candidate through cart and checkout; never submits an order. */
import 'dotenv/config';
import Steel from 'steel-sdk';
import { chromium, type Page } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { addItemToCart, clearCart, goToCheckout, inspectCart } from '../src/doordash.js';
import { navigate } from '../src/browser-work.js';
import { reconcileUncertainAdd } from '../src/cart-reconciliation.js';
import { sessionTimeoutMs } from '../src/session.js';
import { prepareCheckout } from '../src/checkout-recovery.js';
import type { PickedMeal } from '../src/types.js';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: tsx scripts/verify-late-snack-cart.ts reports/<order-report>.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const pick = report.candidates?.[0] as PickedMeal | undefined;
if (!pick || pick.itemId !== '44708617847' || pick.components?.length !== 1 || !/\/store\/50516008\//.test(pick.storeUrl)) {
  throw new Error('This probe only accepts the reported Harvest Clean Eats / Thai Peanut Burrito candidate');
}
const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY, timeout: 20000, maxRetries: 0 });
let session: Awaited<ReturnType<typeof client.sessions.create>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let page: Page | undefined;
try {
  session = await client.sessions.create({ profileId: process.env.STEEL_PROFILE_ID, persistProfile: false, timeout: sessionTimeoutMs() });
  browser = await chromium.connectOverCDP(session.websocketUrl, { timeout: 20000 });
  const context = browser.contexts()[0];
  page = await context.newPage();
  await navigate(page, pick.storeUrl, ['[data-testid="storeInfo"]', '[data-testid="MenuItem"]'], 'Harvest cart probe baseline', { attemptMs: 35000 });
  const baseline = await inspectCart(page);
  if (!baseline || baseline.cartItems.length) throw new Error('Cart baseline unreadable or not empty; probe stopped before adding');
  const added = await addItemToCart(page, pick.storeUrl, pick.itemId, {
    item: pick.item, basePrice: pick.price, budget: 24.81,
    preferences: { dietary: ['Dairy-free'] }, clearExisting: false,
  });
  console.log('CART_ADD', JSON.stringify({ ok: added.ok, status: added.status, reason: added.reason, options: added.selectedOptions,
    groups: added.customization?.groups.map(group => ({ label: group.label, selected: group.choices.filter(choice => choice.selected).map(choice => choice.label) })) }));
  pick.selectedOptions = added.selectedOptions;
  pick.components![0].selectedOptions = added.selectedOptions;
  if (!added.ok && added.status === 'uncertain') {
    const reconciled = await reconcileUncertainAdd(page, pick);
    page = reconciled.page;
    console.log('RECONCILED', JSON.stringify({ matched: reconciled.matched, cart: reconciled.cart }));
    if (!reconciled.matched) throw new Error(added.reason ?? 'Cart add was not confirmed');
  } else if (!added.ok) throw new Error(added.reason ?? 'Cart add was not confirmed');
  const checkout = await goToCheckout(page);
  if (!checkout) throw new Error('Checkout was not readable');
  console.log('CHECKOUT_READY', JSON.stringify(checkout));
  const prepared = await prepareCheckout(page, pick, [pick], {
    budget: 35, includesFees: true, brief: 'Dairy-free',
    preferences: { dietary: ['Dairy-free'] },
  });
  console.log('APPROVAL_READY', JSON.stringify({ total: prepared.checkout.checkoutTotal, item: prepared.picked.item }));
  const placeEnabled = await page.locator('[data-testid="PlaceOrderButton"]').first().isEnabled();
  console.log('PLACE_ORDER_ENABLED', placeEnabled);
  if (!placeEnabled) throw new Error('DoorDash has disabled Place Order on the verified checkout');
} catch (error) {
  process.exitCode = 1;
  console.error('CART_PROBE_FAILED', error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  if (browser) {
    try {
      const cleanup = await browser.contexts()[0].newPage();
      await navigate(cleanup, pick.storeUrl, ['[data-testid="storeInfo"]', '[data-testid="MenuItem"]'], 'Harvest cart probe cleanup', { attemptMs: 35000 });
      const cart = await inspectCart(cleanup);
      if (!cart) throw new Error('Cart unreadable during cleanup');
      if (cart.cartItems.length) await clearCart(cleanup, cart);
      console.log('CART_CLEARED');
    } catch (error) {
      process.exitCode = 1;
      console.error('CART_CLEANUP_FAILED', error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
    await browser.close().catch(() => {});
  }
  if (session) await client.sessions.release(session.id, {}, { timeout: 10000, maxRetries: 0 }).catch(() => {});
}
