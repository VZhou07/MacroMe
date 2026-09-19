import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { addItemToCart, emptyCart } from '../src/doordash.ts';
let browser:Browser,page:Page;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});page=await browser.newPage();});
after(async()=>{await browser?.close();});
const fixture=(mode:string)=>`<div data-testid="storeInfo">Fixture</div><button data-testid="OrderCartIconButton">${mode==='badge-only'?5:0}</button><div data-testid="MenuItem" data-item-id="1"><h3 data-telemetry-id="storeMenuItem.title">Bowl</h3><button role="button" onclick="document.querySelector('[role=dialog]').hidden=false">Bowl</button></div><div role="dialog" hidden><button data-testid="AddToCartButton" onclick="add()">Add $10</button></div><div id="cart">Your cart is empty</div><script>
function add(){ document.body.dataset.adds=String(Number(document.body.dataset.adds||0)+1);
${mode==='badge-only'?"document.querySelector('[data-testid=AddToCartButton]').textContent='Required selection error';":`document.querySelector('[role=dialog]').hidden=true;setTimeout(()=>{document.querySelector('#cart').innerHTML='<button data-testid="CheckoutButton">Continue</button><div data-testid="CartItem"><h3>Bowl</h3><span data-testid="CartItemQuantity">1</span><span data-testid="CartItemPrice">$10.00</span></div>'},100);`}
}</script>`;
async function route(mode:string){await page.unrouteAll();await page.route('https://cart.test/**',r=>r.fulfill({contentType:'text/html',body:fixture(mode)}));}
test('a delayed cart line confirms despite a stale zero badge, and clicks Add once',async()=>{
  await route('delayed');const result=await addItemToCart(page,'https://cart.test/store','1',{clearExisting:false});assert.equal(result.status,'confirmed');assert.equal(await page.locator('body').getAttribute('data-adds'),'1');
});
test('badge increase and validation error after Add do not confirm or repeat a mutation',async()=>{
  await route('badge-only');const result=await addItemToCart(page,'https://cart.test/store','1',{clearExisting:false});assert.equal(result.ok,false);assert.equal(result.status,'uncertain');assert.equal(await page.locator('body').getAttribute('data-adds'),'1');
});
test('failed clearing with a stale zero badge cannot proceed to an add',async()=>{
  await page.setContent('<button data-testid="OrderCartIconButton">0</button><button data-testid="CheckoutButton">Continue</button><div data-anchor-id="OrderCartItem"><div data-testid="QuantityContainer"><span data-testid="stepper-expanded-quantity">1</span><button data-testid="stepper-decrement-button">Remove</button></div></div>');
  // Run waits immediately; the failed control deliberately leaves its row intact.
  const fast=new Proxy(page,{get(target,key){if(key==='waitForTimeout')return async()=>{};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(emptyCart(fast),/cart-clear-failed/);assert.equal(await page.locator('[data-anchor-id="OrderCartItem"]').count(),1);
});

test('waits for the transient required-selection footer before adding an item with no modifiers',async()=>{
  await page.unrouteAll();
  await page.route('https://cart.test/**',r=>r.fulfill({contentType:'text/html',body:fixture('delayed')
    .replace("document.querySelector('[role=dialog]').hidden=false", "document.querySelector('[role=dialog]').hidden=false;setTimeout(()=>document.querySelector('[data-testid=AddToCartButton]').textContent='Add $10',900)")
    .replace('onclick="add()">Add $10','onclick="add()">Make 1 required selection')}));
  const result=await addItemToCart(page,'https://cart.test/store','1',{clearExisting:false});
  assert.equal(result.status,'confirmed');assert.equal(await page.locator('body').getAttribute('data-adds'),'1');
});
test('scrolls the menu even when the pointer remains over a fixed cart panel',async()=>{
  await page.unrouteAll();
  await page.route('https://cart.test/**',r=>r.fulfill({contentType:'text/html',body:fixture('delayed')+`<style>body{min-height:3000px}aside{position:fixed;right:0;top:0;width:100px;height:100vh;overflow:auto}</style><aside><div style="height:5000px">Cart panel</div></aside><script>const virtualCard=document.querySelector('[data-testid=MenuItem]');virtualCard.remove();window.addEventListener('scroll',()=>{if(scrollY>100&&!virtualCard.isConnected)document.body.prepend(virtualCard)});</script>`}));
  const width=page.viewportSize()!.width;
  await page.mouse.move(width-20,300);
  const result=await addItemToCart(page,'https://cart.test/store','1',{clearExisting:false});
  assert.equal(result.status,'confirmed');assert.equal(await page.locator('body').getAttribute('data-adds'),'1');
});
