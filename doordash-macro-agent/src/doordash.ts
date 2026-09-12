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

export async function addItemToCart(page: Page, storeUrl: string, itemId: string): Promise<boolean> {
  // Background tabs are throttled and DoorDash's virtualized menu never renders in them.
  await focus(page);
  // Full menu cards only render once scrolled past the featured carousel, so
  // wait for the store header and let the scroll loop below find the card.
  // Store pages occasionally stall on first load, so allow one retry.
  let loaded = false;
  for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
    await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    loaded = await page.waitForSelector('[data-testid="storeInfo"]', { state: "attached", timeout: 20000 }).then(() => true).catch(() => false);
  }
  if (!loaded) return false;
  const before = await cartCount(page);

  const card = page.locator(`[data-testid="MenuItem"][data-item-id="${itemId}"]`);
  for (let i = 0; i < 40 && (await card.count()) === 0; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(500);
  }
  if ((await card.count()) === 0) return false;

  await card.scrollIntoViewIfNeeded();
  await card.locator('[role="button"]').first().click();

  const addBtn = page.locator('[data-testid^="AddToCartButton"]').first();
  await addBtn.waitFor({ timeout: 10000 }).catch(() => {});
  if (!(await addBtn.isEnabled().catch(() => false))) {
    // Item needs required choices (size, sides, etc.) we don't pick automatically.
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await addBtn.click();

  // Adding from a different store than what's already in the cart asks to start a new cart.
  const newCartSelector = 'button:has-text("New Order"), button:has-text("Start New Cart"), button:has-text("New cart")';
  if (await appears(page, newCartSelector, 2000)) await page.locator(newCartSelector).first().click();

  await page.waitForTimeout(2500);
  return (await cartCount(page)) > before;
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
