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
  await navigate(page, url, 'a[href*="/store/"]', `search / ${term || 'browse restaurants'}`);
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
    if (!stores.has(id)) stores.set(id, { name, url: clean.startsWith("http") ? clean : `${BASE}${clean}` });
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

export type AddToCartResult = { ok: true } | { ok: false; reason: string };

async function sessionEndedVisible(page: Page): Promise<boolean> {
  return page.getByText(/session ended/i).first().isVisible().catch(() => false);
}

/**
 * DoorDash item modals often require at least one choice (milk, size, …).
 * Pick the first unselected option in each radio group so Add becomes enabled.
 * Returns how many options we clicked.
 */
export async function fillRequiredOptions(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Object methods survive tsx's keepNames transform without an external
    // __name helper, which does not exist in the remote browser.
    const { visible } = { visible(el: Element) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    } };

    let clicked = 0;

    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(visible);
    const byName = new Map<string, HTMLInputElement[]>();
    for (const radio of radios) {
      const key = radio.name || radio.id;
      if (!key) continue;
      const list = byName.get(key) ?? [];
      list.push(radio);
      byName.set(key, list);
    }
    for (const opts of byName.values()) {
      if (opts.some((o) => o.checked)) continue;
      const pick = opts.find((o) => !o.disabled);
      if (!pick) continue;
      pick.click();
      clicked++;
    }

    const roleRadios = [...document.querySelectorAll('[role="radio"]')].filter(visible);
    const roleGroups = new Map<Element, HTMLElement[]>();
    for (const radio of roleRadios) {
      const group = radio.closest('[role="radiogroup"]') ?? radio.parentElement;
      if (!group) continue;
      const list = roleGroups.get(group) ?? [];
      list.push(radio as HTMLElement);
      roleGroups.set(group, list);
    }
    for (const opts of roleGroups.values()) {
      if (opts.some((o) => o.getAttribute("aria-checked") === "true")) continue;
      opts[0]?.click();
      clicked++;
    }

    // Fallback: sections labeled Required with no selection yet — click the first
    // clickable option row under that heading.
    for (const el of document.querySelectorAll("h1, h2, h3, h4, span, div, p, legend")) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!/required/i.test(text) || text.length > 120) continue;
      const section = el.closest("section, fieldset, [data-testid], li, div") ?? el.parentElement;
      if (!section) continue;
      const already = section.querySelector('input[type="radio"]:checked, [role="radio"][aria-checked="true"]');
      if (already) continue;
      const option =
        section.querySelector<HTMLElement>('input[type="radio"]:not(:disabled)') ??
        section.querySelector<HTMLElement>('[role="radio"]') ??
        section.querySelector<HTMLElement>('label, [role="button"], button');
      if (!option || !visible(option)) continue;
      option.click();
      clicked++;
    }

    return clicked;
  });
}

export async function addItemToCart(page: Page, storeUrl: string, itemId: string): Promise<AddToCartResult> {
  // Background tabs are throttled and DoorDash's virtualized menu never renders in them.
  await focus(page);
  console.log(`[doordash] addItemToCart: itemId=${itemId} store=${storeUrl}`);

  // Full menu cards only render once scrolled past the featured carousel, so
  // wait for the store header and let the scroll loop below find the card.
  await navigate(page, storeUrl, '[data-testid="storeInfo"]', `cart / ${storeUrl}`);
  if (await sessionEndedVisible(page)) return { ok: false, reason: "session-ended" };

  const before = await cartCount(page);
  console.log(`[doordash] cart count before: ${before}`);

  const card = page.locator(`[data-testid="MenuItem"][data-item-id="${itemId}"]`);
  for (let i = 0; i < 40 && (await card.count()) === 0; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(500);
  }
  if ((await card.count()) === 0) {
    console.log(`[doordash] menu card not found for itemId=${itemId}`);
    return { ok: false, reason: "item-not-found" };
  }

  const itemName = (await card.locator('[data-telemetry-id="storeMenuItem.title"]').innerText().catch(() => "")).trim();
  console.log(`[doordash] opening item modal: ${itemName || itemId}`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[role="button"]').first().click();

  const addBtn = page.locator('[data-testid^="AddToCartButton"]').first();
  await addBtn.waitFor({ timeout: 10000 }).catch(() => {});
  if ((await addBtn.count()) === 0) {
    console.log("[doordash] AddToCart button never appeared");
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, reason: "no-add-button" };
  }

  // Required modifiers (milk, size, …) leave the button disabled / relabeled
  // ("Make 1 required selection"). Auto-pick the first option in each group.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await sessionEndedVisible(page)) {
      console.log("[doordash] session ended while on item modal");
      return { ok: false, reason: "session-ended" };
    }
    const enabled = await addBtn.isEnabled().catch(() => false);
    const label = ((await addBtn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    console.log(`[doordash] add button attempt ${attempt + 1}: enabled=${enabled} label="${label}"`);
    if (enabled && !/required selection/i.test(label)) break;

    const filled = await fillRequiredOptions(page);
    console.log(`[doordash] auto-selected ${filled} required option(s)`);
    if (filled === 0 && !enabled) {
      await page.keyboard.press("Escape").catch(() => {});
      return { ok: false, reason: "required-options-unfilled" };
    }
    await page.waitForTimeout(400);
  }

  if (!(await addBtn.isEnabled().catch(() => false))) {
    const label = ((await addBtn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    console.log(`[doordash] add still disabled after filling options: "${label}"`);
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, reason: "required-options-unfilled" };
  }

  await addBtn.click();
  console.log("[doordash] clicked Add to cart");

  // Adding from a different store than what's already in the cart asks to start a new cart.
  const newCartSelector = 'button:has-text("New Order"), button:has-text("Start New Cart"), button:has-text("New cart")';
  if (await appears(page, newCartSelector, 2000)) {
    console.log("[doordash] confirming start-new-cart dialog");
    await page.locator(newCartSelector).first().click();
  }

  await page.waitForTimeout(2500);
  if (await sessionEndedVisible(page)) return { ok: false, reason: "session-ended" };

  // The badge can update late, or reset when switching restaurants. Inspect
  // the cart itself as well before deciding whether the add succeeded.
  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await cartCount(page);
    console.log(`[doordash] cart count after: ${after}`);
    if (after > before) return { ok: true };
    if (!(await page.locator('[data-testid="CheckoutButton"]').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="OrderCartIconButton"]').click().catch(() => {});
    }
    const cart = await readCheckout(page, false).catch(() => null);
    if (cart?.cartItems.some((line) => line.name.toLowerCase() === itemName.toLowerCase())) {
      console.log(`[doordash] confirmed ${itemName} in the cart`);
      return { ok: true };
    }
    await page.waitForTimeout(1000);
  }
  return { ok: false, reason: "add-unconfirmed" };
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
  const alreadyAtCheckout = await page.locator('[data-testid="PlaceOrderButton"]').first().isVisible().catch(() => false);
  if (!alreadyAtCheckout) {
  // Adding an item can leave the cart drawer already open, and clicking the
  // cart icon then toggles it shut — only open it if Continue isn't showing.
  if (!(await appears(page, '[data-testid="CheckoutButton"]', 3000))) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator('[data-testid="OrderCartIconButton"]').click();
    if (!(await appears(page, '[data-testid="CheckoutButton"]', 10000))) {
      console.log("[doordash] Cart drawer opened but no Continue/checkout button appeared.");
      return null;
    }
  }
  await page.locator('[data-testid="CheckoutButton"]').first().click();
  if (!(await appears(page, '[data-testid="PlaceOrderButton"]', 40000))) {
    const inDom = await page.locator('[data-testid="PlaceOrderButton"]').count().catch(() => -1);
    await page.screenshot({ path: "checkout-failed.png" }).catch(() => {});
    console.log(`[doordash] Checkout page never showed Place Order (in DOM: ${inDom}, at ${page.url()}). Screenshot: checkout-failed.png`);
    return null;
  }
  }
  // Some layouts collapse the order summary on checkout.
  const expand = page.getByRole("button", { name: /^(?:view|show) (?:order|cart|items)(?: summary| details)?/i }).first();
  if (await expand.isVisible().catch(() => false)) await expand.click();
  for (let attempt = 0; ; attempt++) {
    try {
      return await readCheckout(page);
    } catch (err) {
      if (attempt === 4) throw err;
      await page.waitForTimeout(1000);
    }
  }
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
      const quantityEl = row.querySelector<HTMLInputElement>('[data-testid="CartItemQuantity"], [data-testid="OrderCartItemQuantity"], input[type="number"], select, [role="spinbutton"]');
      const quantityText = quantityEl?.value || quantityEl?.getAttribute("aria-valuenow") || text(quantityEl);
      const quantityLine = lines.find((s) => /^(?:(?:qty|quantity)\s*:?\s*|[x×]\s*)?\d+\s*[x×]?$/i.test(s));
      const quantityMatch = (quantityText || quantityLine || "").match(/\d+/);
      const quantity = quantityMatch ? Number(quantityMatch[0]) : NaN;
      const name = text(nameEl) || lines.find((s) => s !== quantityLine && !s.match(money) && !/^(?:edit|remove|delete|quantity|qty)(?:\s|$)/i.test(s)) || "";
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
      const detailLines = [...row.querySelectorAll('*')].filter((el) => visible(el) && !el.children.length && !el.closest('button, [role="button"], s, del, select'))
        .map((el) => text(el)).filter(Boolean);
      const modifiers = detailLines.filter((s) => s !== name && s !== quantityLine && s !== quantityText &&
        !new RegExp(`^${money.source}$`).test(s) && !/^(?:edit|remove|delete)(?:\s|$)/i.test(s));
      return { name, quantity, linePrice: prices[0].replace(/\s+/g, ""), modifiers };
    });
    const countLabels = [...document.querySelectorAll('h1, h2, h3, h4, button, [role="button"], span')]
      .filter(visible).map((el) => text(el).match(/^(?:(?:your )?(?:cart|order)(?: summary)?\s*\(?\s*)?(\d+) items?\)?$/i))
      .filter((match) => match !== null);
    const quantity = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    if (countLabels.some((match) => Number(match![1]) !== quantity)) {
      throw new Error("Checkout item count does not match the scraped cart. Order was not approved or placed.");
    }
    return { cartItems, checkoutTotal: checkoutTotal ?? "" };
  }, requireTotal);
}

async function openEditableCart(page: Page, expected: CheckoutSummary): Promise<void> {
  const current = await readCheckout(page);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Cart changed before editing; inspect it again');
  const back = page.getByRole('link', { name: 'Back to Store', exact: true });
  if (await back.isVisible()) {
    await back.click();
    await page.locator('[data-testid="storeInfo"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
  }
  if (!(await page.locator('[data-testid="CheckoutButton"]').first().isVisible().catch(() => false))) {
    await page.locator('[data-testid="OrderCartIconButton"]').click();
  }
  await page.locator('[data-anchor-id="OrderCartItem"]').first().waitFor({ timeout: 15000 });
  const actual = await page.locator('[data-anchor-id="OrderCartItem"]').evaluateAll((rows) => rows.map((row) => ({
    name: (row.getAttribute('aria-label') ?? '').replace(/^click to open modal and edit item:\s*/i, ''),
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

export async function placeOrder(page: Page, approvedCheckout: CheckoutSummary): Promise<boolean> {
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
  await page.locator('[data-testid="PlaceOrderButton"]').first().click();
  await page.waitForTimeout(8000);
  return true;
}
