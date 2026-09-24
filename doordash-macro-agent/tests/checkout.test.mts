import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { readCheckout, goToCheckout, placeOrder, fillRequiredOptions, editCartLine, clearCart } from "../src/doordash.ts";
import { printCartSummary } from "../src/notifier.ts";

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
});
after(async () => { await browser?.close(); });

const line = (name: string, qty = 1, price = 'CA$18.69', extra = '') => `
  <div data-testid="OrderCartItem">
    <h3>${name}</h3><span data-testid="CartItemQuantity">${qty}</span>
    <span data-testid="CartItemPrice">${price}</span>${extra}<button>Edit</button>
  </div>`;
const checkout = (lines: string, count: number, total = 'CA$53.32') => `
  <h2>${count} items</h2>${lines}<button data-testid="PlaceOrderButton">Place Order ${total}</button>`;

test('required options run inside the browser without TypeScript helper errors', async () => {
  await page.setContent('<div role="dialog"><fieldset><legend>Size Required</legend><input type="radio" name="size" value="small"><input type="radio" name="size" value="large"></fieldset></div>');
  assert.equal(await fillRequiredOptions(page), 1);
  assert.equal(await page.locator('input:checked').count(), 1);
  assert.equal(await fillRequiredOptions(page), 0);
});

test('reads all lines, quantities, modifiers and the exact checkout total', async () => {
  await page.setContent(checkout(line('Hot Honey Bowl') + line('Vegan Bowl', 2, 'CA$37.38', '<p>No onions</p>'), 3));
  const result = await readCheckout(page);
  assert.deepEqual(result, {
    checkoutTotal: 'CA$53.32',
    cartItems: [
      { name: 'Hot Honey Bowl', quantity: 1, linePrice: 'CA$18.69', modifiers: [] },
      { name: 'Vegan Bowl', quantity: 2, linePrice: 'CA$37.38', modifiers: ['No onions'] },
    ],
  });
  const logs: string[] = [];
  const original = console.log;
  try { console.log = (value) => logs.push(value); printCartSummary(result); }
  finally { console.log = original; }
  assert.match(logs.join('\n'), /2 × Vegan Bowl/);
  assert.match(logs.join('\n'), /CA\$53.32.*entire cart/);
});

test('scrapes the observed DoorDash checkout layout without invented test ids or edit buttons', async () => {
  await page.setContent(`<span>3 items</span><div data-testid="checkoutItemDetailsWrapper">${[
    ['Hot Honey Bowl', '$19.94'], ['Vegan Bowl', '$18.69'], ['Hungry Buddha Bowl', '$20.56'],
  ].map(([name, price]) => `<div role="listitem" data-anchor-id="OrderItemContainer"><div><span>1×</span></div><div><span>${name}</span><span title="Regular">Regular</span></div><div><span>${price}</span></div></div>`).join('')}</div><button data-testid="PlaceOrderButton">Place Order CA$84.69</button>`);
  const result = await readCheckout(page);
  assert.deepEqual(result.cartItems.map((item) => item.name), ['Hot Honey Bowl', 'Vegan Bowl', 'Hungry Buddha Bowl']);
  assert.equal(result.checkoutTotal, 'CA$84.69');
  assert.deepEqual(result.cartItems[2].modifiers, ['Regular']);
  assert.deepEqual(await goToCheckout(page), result);
});

test('removes and decreases through the observed cart controls, without clicking Place Order', async () => {
  for (const action of ['decrease', 'remove', 'clear'] as const) {
    await page.setContent(`${checkout(line('Bowl', 2, '$40.00'), 2, 'CA$45.00')}
      <button data-testid="CheckoutButton">Continue</button>
      <div data-anchor-id="OrderCartItem" data-order-item-id="fixture-line" aria-label="click to open modal and edit item: Bowl">
        <div data-testid="QuantityContainer"><span data-testid="stepper-expanded-quantity">2 ×</span>
        <button data-testid="stepper-decrement-button" onclick="const row=this.closest('[data-order-item-id]');const qty=row.querySelector('span');const n=parseInt(qty.textContent);if(n===1)row.remove();else qty.textContent=(n-1)+' ×';">Remove one</button></div>
      </div>`);
    const expected = await readCheckout(page);
    if (action === 'clear') await clearCart(page, expected);
    else await editCartLine(page, expected, 0, action);
    if (action === 'decrease') assert.equal(await page.locator('[data-testid="stepper-expanded-quantity"]').innerText(), '1 ×');
    else assert.equal(await page.locator('[data-anchor-id="OrderCartItem"]').count(), 0);
    assert.equal(await page.locator('[data-testid="PlaceOrderButton"]').count(), 1);
  }
});

test('single item works; identical names remain separate customized lines; hidden rows are excluded', async () => {
  await page.setContent(checkout(line('Vegan Bowl'), 1, 'CA$23.00'));
  assert.equal((await readCheckout(page)).cartItems.length, 1);
  await page.setContent(checkout(line('Vegan Bowl') + line('Vegan Bowl', 1, 'CA$19.00', '<p>Extra tofu</p>') + `<div hidden>${line('Hidden item')}</div>`, 2));
  assert.equal((await readCheckout(page)).cartItems.length, 2);
});

test('supports edit-control fallback without cart row test ids', async () => {
  await page.setContent(checkout('<section><h3>Vegan Bowl</h3><p>Qty: 2</p><span>CA$37.38</span><button>Edit item</button></section>', 2));
  assert.equal((await readCheckout(page)).cartItems[0].quantity, 2);
});

test('refuses empty, incomplete, count-mismatched and price-less checkouts', async () => {
  for (const html of [checkout('', 0), checkout(line('Bowl').replace('>1</span>', '></span>'), 1), checkout(line('Bowl'), 2), checkout(line('Bowl'), 1, ''), checkout(line('Bowl', 1, ''), 1)]) {
    await page.setContent(html);
    await assert.rejects(readCheckout(page));
  }
});

test('a changed cart or total cannot be placed using a previous approval', async (t) => {
  const previous = process.env.MACROME_DEMO_PLACE;
  process.env.MACROME_DEMO_PLACE = '0';
  t.after(() => { if (previous === undefined) delete process.env.MACROME_DEMO_PLACE; else process.env.MACROME_DEMO_PLACE = previous; });
  await page.setContent(checkout(line('Bowl'), 1));
  const approved = await readCheckout(page);
  for (const html of [checkout(line('Bowl'), 1, 'CA$60.00'), checkout(line('Bowl') + line('Leftover'), 2)]) {
    await page.setContent(html);
    await page.evaluate(() => { document.querySelector('button[data-testid="PlaceOrderButton"]')!.addEventListener('click', () => { document.body.dataset.placed = 'yes'; }); });
    await assert.rejects(placeOrder(page, approved), /changed after approval/);
    assert.equal(await page.getAttribute('body', 'data-placed'), null);
  }
});

test('real submission requires an observed DoorDash confirmation and never retries the click', async (t) => {
  const previous = process.env.MACROME_DEMO_PLACE;
  process.env.MACROME_DEMO_PLACE = '0';
  t.after(() => { if (previous === undefined) delete process.env.MACROME_DEMO_PLACE; else process.env.MACROME_DEMO_PLACE = previous; });
  await page.setContent(checkout(line('Bowl'), 1));
  const approved = await readCheckout(page);
  await page.evaluate(() => { document.querySelector('button[data-testid="PlaceOrderButton"]')!.addEventListener('click', () => {
    document.body.innerHTML = '<h1>Your order is confirmed</h1>';
  }); });
  let submissions = 0;
  assert.equal(await placeOrder(page, approved, { onSubmit: () => submissions++, confirmationTimeoutMs: 1000 }), true);
  assert.equal(submissions, 1);

  await page.setContent(checkout(line('Bowl'), 1));
  const unchanged = await readCheckout(page);
  await page.evaluate(() => { document.querySelector('button[data-testid="PlaceOrderButton"]')!.addEventListener('click', () => {
    document.body.dataset.clicked = 'yes';
  }); });
  await assert.rejects(placeOrder(page, unchanged, { onSubmit: () => submissions++, confirmationTimeoutMs: 100 }), /submission was attempted.*no confirmation/i);
  assert.equal(submissions, 2);
  assert.equal(await page.getAttribute('body', 'data-clicked'), 'yes');
});

test('dashboard lists the full cart, labels the pick and escapes scraped text', async () => {
  await page.setContent(readFileSync(new URL('../../ui/dashboard.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''));
  const script = readFileSync(new URL('../../ui/dashboard.js', import.meta.url), 'utf8').split('(async function init()')[0];
  await page.addScriptTag({ content: script });
  const state = {
    status: 'awaiting-approval',
    approval: {
      item: 'Vegan Bowl', restaurant: 'Kitchen', price: 18.69, checkoutTotal: 'CA$53.32',
      macros: { calories: 500 }, reasoning: 'Fits your target',
      cartItems: [
        { name: 'Hot Honey Bowl', quantity: 1, linePrice: 'CA$18.69', modifiers: [] },
        { name: '<img src=x onerror=alert(1)>', quantity: 2, linePrice: 'CA$37.38', modifiers: ['No onions'] },
      ],
    },
  };
  const render = async () => page.evaluate((value) => (window as any).renderRun(value), state);
  await render();
  assert.equal(await page.locator('.approval-cart li').count(), 2);
  assert.match(await page.locator('#approvalBody').innerText(), /CA\$53.32/);
  assert.match(await page.locator('#approvalBody').innerText(), /Agent pick/);
  assert.match(await page.locator('#approvalBody').innerText(), /entire cart/);
  assert.equal(await page.locator('#approvalBody img').count(), 0);
  assert.equal(await page.locator('#approve').isEnabled(), true);
  state.approval.cartItems = state.approval.cartItems.slice(0, 1);
  await render();
  assert.equal(await page.locator('.approval-cart li').count(), 1);
  state.approval.cartItems = [];
  await render();
  assert.equal(await page.locator('#approve').isEnabled(), false);
  await page.evaluate(() => { (window as any).eval('plan = { timezone: "America/Toronto", addresses: [{ id: "home", label: "Home" }] }'); });
  const queued = {
    status: 'idle', upcoming: [
      { id: 'first', meal: 'Dinner', time: '19:00', eatAt: '2026-09-12T23:00:00Z', orderAt: '2026-09-12T22:15:00Z', addressId: 'home' },
      { id: 'second', meal: 'Breakfast', time: '08:00', eatAt: '2026-09-13T12:00:00Z', orderAt: '2026-09-13T11:15:00Z', addressId: 'home' },
    ],
  };
  await page.evaluate((value) => (window as any).renderRun(value), queued);
  assert.match(await page.locator('#nextOrderLabel').innerText(), /Next: Dinner/);
  assert.equal(await page.locator('#runNow').isEnabled(), true);
  queued.upcoming.shift();
  await page.evaluate((value) => (window as any).renderRun(value), queued);
  assert.match(await page.locator('#nextOrderLabel').innerText(), /Next: Breakfast/);
  assert.equal(await page.locator('#upcoming li').count(), 1);
  queued.upcoming = [];
  await page.evaluate((value) => (window as any).renderRun(value), queued);
  assert.equal(await page.locator('#runNow').isEnabled(), false);
});
test('reads observed drawer rows without requiring checkout navigation', async()=>{
  for (const role of ['listitem', 'button']) {
  await page.setContent(`<button data-testid="OrderCartIconButton">0</button><div role="${role}" data-anchor-id="OrderCartItem" aria-label="click to open modal and edit item: Bowl "><span>Bowl</span><span title="Tofu">Tofu</span><div data-testid="QuantityContainer"><span data-testid="stepper-expanded-quantity">1 ×</span><button><span>Decrease quantity</span></button></div><span>$16.35</span></div>`);
  assert.deepEqual(await readCheckout(page,false),{cartItems:[{name:'Bowl',quantity:1,linePrice:'$16.35',modifiers:['Tofu']}],checkoutTotal:''});
  }
});
