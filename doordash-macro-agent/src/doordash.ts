import type { Page } from "playwright-core";
import type { MenuItem, StoreMenu } from "./types.js";

const BASE = "https://www.doordash.com";
// Long menus are memory-heavy to scroll; this many in-budget items is plenty to pick from.
const MAX_ITEMS_PER_STORE = 60;

// Background tabs are throttled and DoorDash's virtualized menu never renders
// in them, so focus the tab first. bringToFront has no timeout and has hung
// indefinitely on Steel's remote browser, so don't wait on it forever.
function focus(page: Page): Promise<void> {
  return Promise.race([
    page.bringToFront().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function parsePrice(text: string): number {
  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : NaN;
}

export async function findStores(page: Page, query: string, max: number): Promise<{ name: string; url: string }[]> {
  await page.goto(`${BASE}/search/store/${encodeURIComponent(query)}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('a[href*="/store/"]', { timeout: 20000 });
  await page.waitForTimeout(2000);

  const links = await page.$$eval('a[href*="/store/"]', (els) =>
    els.map((a) => ({
      href: (a as HTMLAnchorElement).href,
      text: (a as HTMLElement).innerText.trim(),
    }))
  );

  const stores = new Map<string, { name: string; url: string }>();
  for (const { href, text } of links) {
    const id = href.match(/\/store\/[^/?]*?(\d+)/)?.[1];
    if (!id || !text) continue;
    // Card text sometimes arrives without line breaks ("Mary Be Kitchen4.7(200+)…"),
    // so cut the name off where the rating starts.
    const name = text.split("\n")[0].replace(/\d\.\d.*$/, "").trim();
    if (!name) continue;
    if (!stores.has(id)) stores.set(id, { name, url: `${BASE}/store/${id}/` });
    if (stores.size >= max) break;
  }
  return [...stores.values()];
}

export async function scrapeMenu(page: Page, store: { name: string; url: string }, budget: number): Promise<StoreMenu> {
  await focus(page);
  await page.goto(store.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('[data-testid="MenuItem"]', { timeout: 20000 }).catch(() => {});

  // The menu is virtualized, so collect items while scrolling rather than
  // reading the DOM once at the end.
  const items = new Map<string, MenuItem>();
  let stagnant = 0;
  for (let i = 0; i < 40 && stagnant < 4 && items.size < MAX_ITEMS_PER_STORE; i++) {
    const batch = await page.$$eval('[data-testid="MenuItem"]', (els) =>
      els.map((el) => ({
        id: el.getAttribute("data-item-id") ?? "",
        name: el.querySelector('[data-telemetry-id="storeMenuItem.title"]')?.textContent?.trim() ?? "",
        description: el.querySelector('[data-telemetry-id="storeMenuItem.subtitle"]')?.textContent?.trim() ?? "",
        priceText: el.querySelector('[data-testid="StoreMenuItemPrice"]')?.textContent ?? "",
      }))
    );
    const before = items.size;
    for (const b of batch) {
      const price = parsePrice(b.priceText);
      if (!b.id || !b.name || items.has(b.id) || !(price > 0) || price > budget) continue;
      items.set(b.id, { id: b.id, name: b.name, description: b.description.slice(0, 200), price });
    }
    stagnant = items.size === before ? stagnant + 1 : 0;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(600);
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
async function fillRequiredOptions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

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
  // Store pages occasionally stall on first load, so allow one retry.
  let loaded = false;
  for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
    await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    loaded = await page.waitForSelector('[data-testid="storeInfo"]', { state: "attached", timeout: 20000 }).then(() => true).catch(() => false);
    if (!loaded) console.log(`[doordash] store header missing on load attempt ${attempt + 1}`);
  }
  if (!loaded) return { ok: false, reason: "store-page-failed" };
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

  const after = await cartCount(page);
  console.log(`[doordash] cart count after: ${after}`);
  if (after > before) return { ok: true };

  console.log("[doordash] cart count did not increase");
  return { ok: false, reason: "cart-unchanged" };
}

function appears(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
}

// Checkout is reached through the cart drawer: the bare /consumer/checkout/ URL
// is a 404 without the order_cart_id the Continue link carries.
// Returns the Place Order button's total (whole cart, with fees), or null.
export async function goToCheckout(page: Page): Promise<string | null> {
  await focus(page);
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
  const text = await page.locator('[data-testid="PlaceOrderButton"]').first().innerText();
  return text.match(/[A-Z]*\$[\d.,]+/)?.[0] ?? text.replace(/\s+/g, " ");
}

export async function placeOrder(page: Page): Promise<boolean> {
  if (!(await appears(page, '[data-testid="PlaceOrderButton"]', 10000))) return false;
  await page.locator('[data-testid="PlaceOrderButton"]').first().click();
  await page.waitForTimeout(8000);
  return true;
}
