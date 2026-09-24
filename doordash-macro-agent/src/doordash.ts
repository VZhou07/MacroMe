import { resolveRequiredOptions, assessCustomization, type ModifierContext, type ModifierResult } from './modifiers.js';
import { matchesSelectedOptions } from './cart-modifiers.js';
import type { Page } from "playwright-core";
import type { CheckoutSummary, MenuItem, StoreMenu } from "./types.js";

import { assertConnected, bounded, BrowserUnavailableError, navigate } from "./browser-work.js";

const BASE = "https://www.doordash.com";
// Long menus are memory-heavy to scroll; this many in-budget items is plenty to pick from.
const MAX_ITEMS_PER_STORE = 20;

// Background tabs are throttled and DoorDash's virtualized menu never renders
// in them, so focus the tab first. bringToFront has no timeout and has hung
// indefinitely on Steel's remote browser, so don't wait on it forever.
function focus(page: Page): Promise<void> {
  return bounded(page.bringToFront(), 3000, 'focus tab').catch(() => {
    console.log('[browser] focus tab: did not finish in 3 seconds; continuing with bounded page work.');
  });
}

function parsePrice(text: string): number {
  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : NaN;
}

export async function findStores(page: Page, query: string, max: number): Promise<{ name: string; url: string }[]> {
  const term = query.trim();
  const url = term ? `${BASE}/search/store/${encodeURIComponent(term)}/` : `${BASE}/`;
  await navigate(page, url, 'a[href*="/store/"]', `search / ${term || 'browse restaurants'}`, { attemptMs: 35000 });
  await page.waitForTimeout(2000);

  const stores = new Map<string, { name: string; url: string }>();
  let stagnant = 0;
  for (let pass = 0; pass < 12 && stores.size < max && stagnant < 3; pass++) {
  const before = stores.size;
  const links = await page.$$eval('a[href*="/store/"]', (els) =>
    els.map((a) => ({
      href: (a as HTMLAnchorElement).href,
      text: (a as HTMLElement).innerText.trim(),
    }))
  );

  for (const { href, text } of links) {
    const id = href.match(/\/store\/[^/?]*?(\d+)/)?.[1];
    if (!id || !text) continue;
    // Card text sometimes arrives without line breaks ("Mary Be Kitchen4.7(200+)…"),
    // so cut the name off where the rating starts.
    const name = text.split("\n")[0].replace(/\d\.\d.*$/, "").trim();
    if (!name) continue;
    // Keep DoorDash's full store path (slug + id). A bare /store/<id>/ often
    // redirects slowly or lands on a shell without menu cards.
    const clean = href.split(/[?#]/)[0].replace(/\/?$/, "/");
    const storeUrl = clean.startsWith("http") ? clean : `${BASE}${clean}`;
    if (!stores.has(id)) stores.set(id, { name, url: storeUrl });
    if (stores.size >= max) break;
  }
  stagnant = stores.size === before ? stagnant + 1 : 0;
  if (stores.size < max) {
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(600);
  }
  }
  return [...stores.values()];
}

export async function scrapeMenu(page: Page, store: { name: string; url: string }, budget: number): Promise<StoreMenu> {
  await focus(page);
  // Menu cards are virtualized and often missing until the store shell paints.
  // Wait for the store header OR a menu card, then scroll until cards appear —
  // same pattern addItemToCart already uses successfully.
  await navigate(
    page,
    store.url,
    ['[data-testid="MenuItem"]', '[data-testid="storeInfo"]', '[data-testid="StoreMenuItemPrice"]'],
    `${store.name} / menu`,
    { attemptMs: 35000 },
  );

  const items = new Map<string, MenuItem>();
  let stagnant = 0;
  let sawCard = false;
  for (let i = 0; i < 28 && stagnant < 4 && items.size < MAX_ITEMS_PER_STORE; i++) {
    const batch = await page.$$eval('[data-testid="MenuItem"]', (els) =>
      els.map((el) => ({
        id: el.getAttribute("data-item-id") ?? "",
        name: el.querySelector('[data-telemetry-id="storeMenuItem.title"]')?.textContent?.trim()
          ?? el.querySelector('[data-testid="StoreMenuItemName"]')?.textContent?.trim()
          ?? "",
        description: el.querySelector('[data-telemetry-id="storeMenuItem.subtitle"]')?.textContent?.trim() ?? "",
        priceText: el.querySelector('[data-testid="StoreMenuItemPrice"]')?.textContent ?? "",
      }))
    ).catch(() => [] as { id: string; name: string; description: string; priceText: string }[]);
    if (batch.length) sawCard = true;
    const before = items.size;
    for (const b of batch) {
      const price = parsePrice(b.priceText);
      if (!b.id || !b.name || items.has(b.id) || !(price > 0) || price > budget) continue;
      items.set(b.id, { id: b.id, name: b.name, description: b.description.slice(0, 200), price });
    }
    stagnant = items.size === before ? stagnant + 1 : 0;
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  }

  if (!sawCard) {
    const title = await page.title().catch(() => "");
    const href = page.url();
    console.log(`[doordash] ${store.name}: no MenuItem cards after scroll (title=${JSON.stringify(title)} url=${href})`);
    throw new Error(`${store.name}: menu cards never appeared (possible login wall or empty store page)`);
  }

  return { store: store.name, url: store.url, items: [...items.values()] };
}

async function cartCount(page: Page): Promise<number> {
  const text = await page.locator('[data-testid="OrderCartIconButton"]').innerText().catch(() => "");
  return parseInt(text.match(/\d+/)?.[0] ?? "0", 10);
}

async function closeCartDrawer(page: Page): Promise<void> {
  const close = page.locator('[data-testid="dbd-pre-checkout-header-close-button"]:visible').first();
  if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 });
  else await page.keyboard.press('Escape').catch(() => {});
}

/** Menu scrolling must not depend on a pointer left over the cart drawer. */
async function scrollMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.querySelector('[data-testid="MenuItem"]') ?? document.querySelector('[data-testid="storeInfo"]');
    let panel = card?.parentElement;
    while (panel) {
      if (panel.scrollHeight > panel.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(panel).overflowY)) {
        panel.scrollBy(0, 1200); return;
      }
      panel = panel.parentElement;
    }
    document.scrollingElement?.scrollBy(0, 1200);
  });
}

/** Remove leftover lines so a new meal never stacks on top of an old cart. */
export async function emptyCart(page: Page): Promise<void> {
  let count = await cartCount(page);

  console.log(`[doordash] Clearing ${count} leftover cart item(s) before the new meal…`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  if (!(await appears(page, '[data-testid="CheckoutButton"]', 2500))) {
    await page.locator('[data-testid="OrderCartIconButton"]').first().click({ timeout: 8000 }).catch(() => {});
  }
  await appears(page, '[data-anchor-id="OrderCartItem"]', 8000);

  for (let guard = 0; guard < 30; guard++) {
    const rows = page.locator('[data-anchor-id="OrderCartItem"]');
    if ((await rows.count()) === 0) break;
    const row = rows.first();
    await row.locator('[data-testid="QuantityContainer"]').hover().catch(() => {});
    const qtyText = await row.locator('[data-testid="stepper-expanded-quantity"]').textContent().catch(() => '1');
    const qty = Math.max(1, Number(qtyText?.match(/\d+/)?.[0] ?? 1));
    for (let step = 0; step < qty; step++) {
      if ((await rows.count()) === 0) break;
      await rows.first().locator('[data-testid="QuantityContainer"]').hover().catch(() => {});
      await rows.first().locator('[data-testid="stepper-decrement-button"]').click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(350);
    }
  }

  count = await cartCount(page);
  if (await page.locator('[data-anchor-id="OrderCartItem"]').count()) throw new Error('cart-clear-failed');
  const empty = await page.getByText(/your cart is empty|cart is empty|no items in your cart/i).first().isVisible().catch(() => false);
  if (!empty) throw new Error('cart-empty-unverified');
  await closeCartDrawer(page);
  await page.waitForTimeout(400);
}

export type AddToCartResult = ({ ok: true } | { ok: false; reason: string }) & {
  status?: 'confirmed' | 'failed' | 'uncertain'; phase?: string;
  selectedOptions?: string[]; diagnostics?: unknown; customization?: ModifierResult;
};
export type AddOptions = ModifierContext & { clearExisting?: boolean; onCustomization?: (result: ModifierResult) => void };

async function sessionEndedVisible(page: Page): Promise<boolean> {
  return page.getByText(/session ended/i).first().isVisible().catch(() => false);
}

export async function fillRequiredOptions(page: Page): Promise<number> {
  const before = await page.locator('input:checked, [aria-checked="true"]').count();
  await resolveRequiredOptions(page);
  return (await page.locator('input:checked, [aria-checked="true"]').count()) - before;
}

async function confirmNewCartIfPrompted(page: Page): Promise<void> {
  const newCartSelector = 'button:has-text("New Order"), button:has-text("Start New Cart"), button:has-text("New cart"), button:has-text("Replace cart")';
  if (await appears(page, newCartSelector, 2500)) {
    console.log('[doordash] confirming start-new-cart dialog');
    await page.locator(newCartSelector).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

export async function addItemToCart(
  page: Page,
  storeUrl: string,
  itemId: string,
  options: AddOptions = {},
): Promise<AddToCartResult> {
  // Background tabs are throttled and DoorDash's virtualized menu never renders in them.
  await focus(page);
  console.log(`[doordash] addItemToCart: itemId=${itemId} store=${storeUrl}`);

  // Full menu cards only render once scrolled past the featured carousel, so
  // wait for the store header and let the scroll loop below find the card.
  await navigate(page, storeUrl, ['[data-testid="storeInfo"]', '[data-testid="MenuItem"]'], `cart / ${storeUrl}`, { attemptMs: 35000 });
  if (await sessionEndedVisible(page)) return { ok: false, status: "failed", phase: "navigation", reason: "session-ended" };

  // Default: wipe leftovers so we never stack meals and blow the budget.
  if (options.clearExisting !== false) {
    await emptyCart(page);
  }

  let baseline: CheckoutSummary = { cartItems: [], checkoutTotal: '' };
  if (options.clearExisting === false) {
    if (!(await page.locator('[data-testid="CheckoutButton"]').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="OrderCartIconButton"]').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    const observed = await readCheckout(page, false).catch(() => null);
    const empty = await page.getByText(/your cart is empty|cart is empty|no items in your cart/i).first().isVisible().catch(() => false);
    if (!observed && !empty) return { ok: false, status: 'failed', phase: 'baseline', reason: 'cart-baseline-unreadable' };
    if (observed) baseline = observed;
    await closeCartDrawer(page);
  }
  const before = await cartCount(page);
  console.log(`[doordash] cart count before: ${before}`);

  const card = page.locator(`[data-testid="MenuItem"][data-item-id="${itemId}"]`);
  for (let i = 0; i < 40 && (await card.count()) === 0; i++) {
    await scrollMenu(page);
    await page.waitForTimeout(500);
  }
  if ((await card.count()) === 0) {
    console.log(`[doordash] menu card not found for itemId=${itemId}`);
    return { ok: false, status: "failed", phase: "navigation", reason: "item-not-found" };
  }

  const itemName = (await card.locator('[data-telemetry-id="storeMenuItem.title"]').innerText().catch(() => "")).trim();
  options = { ...options, description: (await card.innerText()).slice(0, 1500) };
  console.log(`[doordash] opening item modal: ${itemName || itemId}`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[role="button"]').first().click();

  const addBtn = page.locator('[data-testid^="AddToCartButton"]').first();
  await addBtn.waitFor({ timeout: 10000 }).catch(() => {});
  if ((await addBtn.count()) === 0) {
    console.log("[doordash] AddToCart button never appeared");
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, status: "failed", phase: "dialog", reason: "no-add-button" };
  }

  // The footer can render before the item data and required controls settle.
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid^="AddToCartButton"]') as HTMLButtonElement | null;
    const root = button?.closest('[role="dialog"], [aria-modal="true"]');
    return !!root && (!!root.querySelector('input,select,[role="radio"],[role="checkbox"],[role="combobox"]') ||
      (!!button && !button.disabled && !/required selection/i.test(button.innerText)));
  }, undefined, { timeout: 5000 }).catch(() => {});
  const dialogDescription = await addBtn.evaluate(el => {
    const root = el.closest('[role="dialog"], [aria-modal="true"]') as HTMLElement | null;
    return root?.innerText.slice(0, 4000) ?? '';
  });
  options = { ...options, storeUrl, dialogDescription };
  const customization = await resolveRequiredOptions(page, options);
  await assessCustomization(options, customization);
  const detail = { selectedOptions: customization.selectedOptions, customization, diagnostics: { item: itemName, description: options.description } };
  const enabled = await addBtn.isEnabled().catch(() => false);
  const label = await addBtn.innerText().catch(() => '');
  if (!customization.complete || !enabled || /required selection/i.test(label)) {
    return { ok: false, status: 'failed', phase: 'options', reason: `required-options-unfilled: ${customization.unresolved.join('; ') || label}`, ...detail };
  }
  options.onCustomization?.(customization);
  // Once the click starts, any exception is an uncertain mutation.
  try {
  await addBtn.click({ timeout: 10000 });
  console.log("[doordash] clicked Add to cart");
  await confirmNewCartIfPrompted(page);

  await page.keyboard.press('Escape').catch(() => {});
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!(await page.locator('[data-testid="CheckoutButton"]').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="OrderCartIconButton"]').first().click({ timeout: 3000 }).catch(() => {});
    }
    const cart = await readCheckout(page, false).catch(() => null);
    const lines = cart?.cartItems.filter(line => line.name.toLowerCase() === itemName.toLowerCase()) ?? [];
    const modifiersMatch = lines.some(line => matchesSelectedOptions(line.modifiers, customization.selectedOptions));
    if (lines.reduce((n,line)=>n+line.quantity,0) === 1 && modifiersMatch &&
        cart?.cartItems.reduce((n,line)=>n+line.quantity,0) === baseline.cartItems.reduce((n,line)=>n+line.quantity,0) + 1 &&
        baseline.cartItems.every(old => cart.cartItems.some(line => line.name === old.name && line.quantity === old.quantity && JSON.stringify(line.modifiers) === JSON.stringify(old.modifiers)))) {
      return { ok: true, status: 'confirmed', phase: 'cart', ...detail, diagnostics: cart };
    }
    await page.waitForTimeout(800);
  }
  return { ok: false, status: 'uncertain', phase: 'cart', reason: 'add-unconfirmed', ...detail };
  } catch (error) {
    return { ok: false, status: 'uncertain', phase: 'add', reason: 'add-unconfirmed', ...detail,
      diagnostics: { error: error instanceof Error ? error.message.split('\n')[0] : 'add failed' } };
  }
}

function appears(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
}

// Checkout is reached through the cart drawer: the bare /consumer/checkout/ URL
// is a 404 without the order_cart_id the Continue link carries.
// Returns the actual checkout contents and Place Order total, or null if navigation fails.
export async function goToCheckout(page: Page): Promise<CheckoutSummary | null> {
  assertConnected(page.context().browser());
  if (await sessionEndedVisible(page)) throw new BrowserUnavailableError('Steel session ended during checkout. Start a new run.');
  await focus(page);

  // DoorDash often needs a second open/Continue after an add; one timeout must not
  // abort a run that already put food in the cart.
  let lastError: unknown;
  for (let nav = 0; nav < 3; nav++) {
    try {
      if (await sessionEndedVisible(page)) {
        throw new BrowserUnavailableError('Steel session ended during checkout. Start a new run.');
      }
      const alreadyAtCheckout = await page.locator('[data-testid="PlaceOrderButton"]').first().isVisible().catch(() => false);
      if (!alreadyAtCheckout) {
        // Adding an item can leave the cart drawer already open, and clicking the
        // cart icon then toggles it shut — only open it if Continue isn't showing.
        if (!(await appears(page, '[data-testid="CheckoutButton"]', 4000))) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(400);
          await page.locator('[data-testid="OrderCartIconButton"]').first().click({ timeout: 12000 });
          if (!(await appears(page, '[data-testid="CheckoutButton"]', 12000))) {
            console.log(`[doordash] Cart drawer opened but no Continue/checkout button appeared (attempt ${nav + 1}/3).`);
            await page.waitForTimeout(1200);
            continue;
          }
        }
        await page.locator('[data-testid="CheckoutButton"]').first().click({ timeout: 12000 });
        if (!(await appears(page, '[data-testid="PlaceOrderButton"]', 45000))) {
          const inDom = await page.locator('[data-testid="PlaceOrderButton"]').count().catch(() => -1);
          await page.screenshot({ path: 'checkout-failed.png' }).catch(() => {});
          console.log(`[doordash] Checkout page never showed Place Order (attempt ${nav + 1}/3, in DOM: ${inDom}, at ${page.url()}). Screenshot: checkout-failed.png`);
          await page.waitForTimeout(1500);
          continue;
        }
      }
      // Some layouts collapse the order summary on checkout.
      const expand = page.getByRole('button', { name: /^(?:view|show) (?:order|cart|items)(?: summary| details)?/i }).first();
      if (await expand.isVisible().catch(() => false)) await expand.click({ timeout: 5000 }).catch(() => {});
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await readCheckout(page);
        } catch (err) {
          lastError = err;
          if (attempt === 4) break;
          await page.waitForTimeout(1200);
        }
      }
    } catch (err) {
      if (err instanceof BrowserUnavailableError) throw err;
      lastError = err;
      console.log(`[doordash] goToCheckout attempt ${nav + 1}/3: ${String(err).split('\n')[0]}`);
      await page.waitForTimeout(1500);
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function readCheckout(page: Page, requireTotal = true): Promise<CheckoutSummary> {
  // Read lines and total in one DOM snapshot. Unrecognized/incomplete markup
  // must stop approval, never fall back to the last recommended dish.
  return page.evaluate((requireTotal) => {
    const { visible, text } = { visible(el: Element) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }, text(el: Element | null) { return (el as HTMLElement | null)?.innerText?.trim() ?? el?.textContent?.trim() ?? ""; } };
    const money = /(?:[A-Z]{2,3}\s*)?\$\s*\d[\d,]*\.\d{2}/g;
    const button = [...document.querySelectorAll('[data-testid="PlaceOrderButton"]')].find(visible);
    const checkoutTotal = text(button ?? null).match(money)?.at(-1)?.replace(/\s+/g, "");
    if (requireTotal && !checkoutTotal) throw new Error("Could not read the Place Order total. Order was not approved or placed.");

    const rowSelector = '[data-anchor-id="OrderItemContainer"], [data-testid="OrderCartItem"], [data-testid="CartItem"], [data-testid="CheckoutItem"], [data-testid="OrderItem"], [data-testid="order-cart-item"]';
    let rows = [...document.querySelectorAll(rowSelector)].filter(visible);
    const drawerRows = [...document.querySelectorAll('[data-anchor-id="OrderCartItem"]')].filter(visible);
    if (!requireTotal && drawerRows.length) rows = drawerRows;
    // Keep only the outer row when wrappers share a test id; don't merge
    // equal names because differently customized dishes can be separate lines.
    rows = rows.filter((row) => !rows.some((other) => other !== row && other.contains(row)));
    if (!rows.length) {
      // Layouts without row test ids still expose an Edit control per cart line.
      const edits = [...document.querySelectorAll('button, [role="button"]')].filter(
        (el) => visible(el) && /^(?:edit|edit item)(?:\s|$)/i.test(el.getAttribute("aria-label") || text(el))
      );
      for (const edit of edits) {
        for (let row = edit.parentElement; row && row !== document.body; row = row.parentElement) {
          if (row.querySelector('[data-testid="PlaceOrderButton"]')) break;
          const controls = edits.filter((other) => row.contains(other));
          if (controls.length > 1) break;
          if (text(row).match(money)) { rows.push(row); break; }
        }
      }
      rows = [...new Set(rows)];
    }
    if (!rows.length) throw new Error("Could not read checkout cart items. Order was not approved or placed.");

    document.querySelectorAll('[data-macrome-cart-line]').forEach((el) => el.removeAttribute('data-macrome-cart-line'));
    const cartItems = rows.map((row, index) => {
      row.setAttribute('data-macrome-cart-line', String(index));
      const leafTexts = [...row.querySelectorAll('*')].filter((el) => visible(el) && !el.children.length)
        .map((el) => text(el)).filter(Boolean);
      const lines = [...new Set([...leafTexts, ...text(row).split(/\n+/).map((s) => s.trim()).filter(Boolean)])];
      const nameEl = row.querySelector('[data-testid="CartItemName"], [data-testid="OrderCartItemName"], [data-telemetry-id="orderCartItem.name"], [data-telemetry-id="orderCartItem.title"], h3, h4');
      const quantityEl = row.querySelector<HTMLInputElement>('[data-testid="CartItemQuantity"], [data-testid="OrderCartItemQuantity"], [data-testid="stepper-expanded-quantity"], input[type="number"], select, [role="spinbutton"]');
      const quantityText = quantityEl?.value || quantityEl?.getAttribute("aria-valuenow") || text(quantityEl);
      const quantityLine = lines.find((s) => /^(?:(?:qty|quantity)\s*:?\s*|[x×]\s*)?\d+\s*[x×]?$/i.test(s));
      const quantityMatch = (quantityText || quantityLine || "").match(/\d+/);
      const quantity = quantityMatch ? Number(quantityMatch[0]) : NaN;
      const name = (text(nameEl) || (row.getAttribute('aria-label') ?? '').replace(/^click to open modal and edit item:\s*/i, '') || lines.find((s) => s !== quantityLine && !s.match(money) && !/^(?:edit|remove|delete|quantity|qty)(?:\s|$)/i.test(s)) || "").trim();
      const priceEl = row.querySelector('[data-testid="CartItemPrice"], [data-testid="OrderCartItemPrice"]');
      // Ignore struck-through original prices and modifier surcharges.
      const priceLines = [...row.querySelectorAll('*')].filter((el) =>
        visible(el) && !el.children.length && !el.closest('s, del') &&
        getComputedStyle(el).textDecorationLine !== "line-through" &&
        new RegExp(`^${money.source}$`).test(text(el))
      );
      const prices = text(priceEl).match(money) ?? priceLines.flatMap((el) => text(el).match(money) ?? []);
      if (!name || !Number.isSafeInteger(quantity) || quantity < 1 || prices.length !== 1) {
        throw new Error("Could not read every cart line's name, quantity and price. Order was not approved or placed.");
      }
      const detailLines = [...row.querySelectorAll('*')].filter((el) => {
        const action = el.closest('button, [role="button"], s, del, select');
        // Drawer rows themselves can be edit buttons; their food details still count.
        return visible(el) && !el.children.length && (!action || action === row || !row.contains(action));
      })
        .map((el) => text(el)).filter(Boolean);
      const modifiers = detailLines.filter((s) => s !== name && s !== quantityLine && s !== quantityText &&
        !new RegExp(`^${money.source}$`).test(s) && !/^(?:edit|remove|delete)(?:\s|$)/i.test(s));
      return { name, quantity, linePrice: prices[0].replace(/\s+/g, ""), modifiers };
    });
    // Ignore the floating cart icon badge — it often disagrees briefly with checkout
    // lines and used to abort readable carts after a successful add.
    const countLabels = [...document.querySelectorAll('h1, h2, h3, h4, span')]
      .filter((el) => visible(el) && !el.closest('[data-testid="OrderCartIconButton"]'))
      .map((el) => text(el).match(/^(?:(?:your )?(?:cart|order)(?: summary)?\s*\(?\s*)?(\d+) items?\)?$/i))
      .filter((match) => match !== null);
    const quantity = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    if (countLabels.length && !countLabels.some((match) => Number(match![1]) === quantity)) {
      throw new Error("Checkout item count does not match the scraped cart. Order was not approved or placed.");
    }
    return { cartItems, checkoutTotal: checkoutTotal ?? "" };
  }, requireTotal);
}

/** Inspect the drawer without requiring the checkout page to be ready. */
export async function inspectCart(page: Page): Promise<CheckoutSummary | null> {
  await page.keyboard.press('Escape').catch(() => {});
  for (let read = 0; read < 3; read++) {
    const current = await readCheckout(page, false).catch(() => null);
    if (current) return current;
    if (await page.getByText(/your cart is empty|cart is empty|no items in your cart/i).first().isVisible().catch(() => false)) {
      return { cartItems: [], checkoutTotal: '' };
    }
    if (!(await page.locator('[data-testid="CheckoutButton"]').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="OrderCartIconButton"]').first().click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
  }
  return null;
}

async function openEditableCart(page: Page, expected: CheckoutSummary): Promise<void> {
  const current = await readCheckout(page, !!expected.checkoutTotal);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Cart changed before editing; inspect it again');
  const back = page.getByRole('link', { name: 'Back to Store', exact: true });
  if (await back.isVisible()) {
    await back.click();
    await page.locator('[data-testid="storeInfo"], [data-testid="MenuItem"]').first().waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);
  }
  if (!(await page.locator('[data-anchor-id="OrderCartItem"]:visible').first().isVisible().catch(() => false))) {
    await page.locator('[data-testid="OrderCartIconButton"]:visible').first().click({ timeout: 10000 });
  }
  await page.locator('[data-anchor-id="OrderCartItem"]:visible').first().waitFor({ timeout: 15000 });
  const actual = await page.locator('[data-anchor-id="OrderCartItem"]:visible').evaluateAll((rows) => rows.map((row) => ({
    name: (row.getAttribute('aria-label') ?? '').replace(/^click to open modal and edit item:\s*/i, '').trim(),
    quantity: Number(row.querySelector('[data-testid="stepper-expanded-quantity"]')?.textContent?.match(/\d+/)?.[0]),
  })));
  const wanted = expected.cartItems.map(({ name, quantity }) => ({ name, quantity }));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error('Editable cart differs from checkout; inspect it again before changing anything');
}

async function decrementCartRow(page: Page, index: number, count: number): Promise<void> {
  if (count > 20) throw new Error('Too many quantity changes for one recovery step');
  const row = page.locator('[data-anchor-id="OrderCartItem"]').nth(index);
  const id = await row.getAttribute('data-order-item-id');
  if (!id) throw new Error('Cart line has no stable identifier');
  for (let step = 0; step < count; step++) {
    const previous = Number((await row.locator('[data-testid="stepper-expanded-quantity"]').textContent())?.match(/\d+/)?.[0]);
    await row.locator('[data-testid="QuantityContainer"]').hover();
    await row.locator('[data-testid="stepper-decrement-button"]').click();
    await page.waitForFunction(({ id, previous }) => {
      const line = [...document.querySelectorAll('[data-anchor-id="OrderCartItem"]')].find((el) => el.getAttribute('data-order-item-id') === id);
      return previous === 1 ? !line : Number(line?.querySelector('[data-testid="stepper-expanded-quantity"]')?.textContent?.match(/\d+/)?.[0]) === previous - 1;
    }, { id, previous }, { timeout: 10000 });
  }
}

export async function editCartLine(page: Page, expected: CheckoutSummary, index: number, action: 'remove' | 'decrease'): Promise<void> {
  const line = expected.cartItems[index];
  if (!line) throw new Error('Unknown cart line');
  await openEditableCart(page, expected);
  await decrementCartRow(page, index, action === 'remove' ? line.quantity : 1);
  console.log(`[cart] ${action}: ${line.name}`);
}

export async function clearCart(page: Page, expected: CheckoutSummary): Promise<void> {
  await openEditableCart(page, expected);
  for (const line of expected.cartItems) await decrementCartRow(page, 0, line.quantity);
  if (await page.locator('[data-anchor-id="OrderCartItem"]').count()) throw new Error('Cart did not become empty');
  console.log('[cart] Cleared the current cart before replacing the meal.');
}

/**
 * Explicit demo mode: an approved, verified cart counts as placed without charging.
 * Real checkout is the default.
 */
export function demoPlaceEnabled(): boolean {
  return /^(?:1|true|on|yes)$/i.test(String(process.env.MACROME_DEMO_PLACE ?? '').trim());
}

export class OrderSubmissionUnconfirmedError extends Error {}

export async function placeOrder(page: Page, approvedCheckout: CheckoutSummary,
  options: { onSubmit?: () => void; confirmationTimeoutMs?: number } = {}): Promise<boolean> {
  if (demoPlaceEnabled()) {
    console.log('[doordash] MACROME_DEMO_PLACE: treating Place Order as successful without charging.');
    await page.waitForTimeout(800).catch(() => {});
    return true;
  }
  if (!(await appears(page, '[data-testid="PlaceOrderButton"]', 10000))) return false;
  const current = await readCheckout(page);
  if (JSON.stringify(current) !== JSON.stringify(approvedCheckout)) {
    throw new Error("The checkout cart or total changed after approval. No order was placed; run again to review the updated cart.");
  }
  if (await page.getByText('Please add or select valid payment method', { exact: true }).isVisible().catch(() => false)) {
    throw new Error('DoorDash needs a valid payment method. Add or select one in DoorDash, then run again. No order was placed.');
  }
  if (!(await page.locator('[data-testid="PlaceOrderButton"]').first().isEnabled())) {
    throw new Error('DoorDash has disabled Place Order. Complete the required checkout details in DoorDash before retrying.');
  }
  // This is the mutation boundary. A timeout after the click may still mean
  // DoorDash accepted the order, so callers must not blindly retry it.
  options.onSubmit?.();
  try {
    await page.locator('[data-testid="PlaceOrderButton"]').first().click();
    await page.waitForFunction(() => {
      const confirmation = document.querySelector('[data-testid="OrderConfirmation"], [data-testid="OrderConfirmationPage"], [data-testid="OrderReceipt"]');
      if (confirmation && confirmation.getClientRects().length) return true;
      const path = location.pathname.toLowerCase();
      if (/\/orders?\/(?:[^/?]+\/)?(?:confirmation|receipt|tracking)\b/.test(path)) return true;
      const body = document.body?.innerText ?? '';
      return /\b(?:your order (?:is confirmed|has been placed|was placed)|order (?:confirmed|received|successfully placed)|thank you for (?:your|placing an) order)\b/i.test(body);
    }, undefined, { timeout: options.confirmationTimeoutMs ?? 20000 });
    return true;
  } catch (error) {
    throw new OrderSubmissionUnconfirmedError(`DoorDash order submission was attempted, but no confirmation was observed. Check DoorDash order history before retrying. ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}
