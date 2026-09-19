import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { CheckoutSummary, PickedMeal } from '../src/types.js';
import { cartCost, validateRecovery } from '../src/recovery.ts';
import { prepareCheckout } from '../src/checkout-recovery.ts';

const pick: PickedMeal = { item: 'Bowl', itemId: '1', restaurant: 'A', storeUrl: 'https://www.doordash.com/store/1/',
  price: 20, estimatedMacros: { calories: 500, protein: 20, carbs: 50, fat: 20 }, reasoning: 'Suitable',
  source: 'estimated', macroConsistent: true, score: 0 };
const cheap = { ...pick, item: 'Rice bowl', itemId: '2', restaurant: 'B', storeUrl: 'https://www.doordash.com/store/2/', price: 12 };
const cart = (total: string, names = ['Bowl']): CheckoutSummary => ({ checkoutTotal: total,
  cartItems: names.map((name) => ({ name, quantity: 1, linePrice: '$20.00', modifiers: [] })) });
const options = { budget: 30, includesFees: true, brief: 'Dairy-free' };
const page = { reload: async () => {}, waitForTimeout: async () => {} } as unknown as Page;

test('budget uses checkout total with fees, or actual line totals when fees are excluded', () => {
  assert.equal(cartCost(cart('CA$84.69', ['Bowl', 'Leftover']), true), 84.69);
  assert.equal(cartCost(cart('CA$84.69', ['Bowl', 'Leftover']), false), 40);
  assert.throws(() => cartCost(cart('Place Order'), true));
});

test('model actions cannot invent cart lines, candidates, quantity changes or a purchase action', () => {
  for (const action of [
    { action: 'remove', line: 5, reasoning: 'x' }, { action: 'decrease', line: 0, reasoning: 'x' },
    { action: 'replace', candidate: 5, reasoning: 'x' }, { action: 'placeOrder', reasoning: 'x' },
  ]) assert.throws(() => validateRecovery(action, cart('CA$25.00'), [pick]));
  assert.throws(() => validateRecovery({ action: 'replace', candidate: 0, reasoning: 'x' }, null, [pick]));
});

test('over-budget cart is edited then reread before approval', async () => {
  let current = cart('CA$55.00', ['Bowl', 'Leftover']);
  let edits = 0;
  const result = await prepareCheckout(page, pick, [pick], options, {
    inspect: async () => current,
    edit: async (_, observed, index) => { assert.equal(observed, current); assert.equal(index, 1); edits++; current = cart('CA$25.00'); },
    clear: async () => assert.fail('Unexpected clear'), add: async () => assert.fail('Unexpected add'),
    decide: async (input) => { assert.match(input.problem, /above/); return { action: 'remove', line: 1, reasoning: 'Remove leftover' }; },
  });
  assert.equal(edits, 1);
  assert.equal(result.checkout.checkoutTotal, 'CA$25.00');
});

test('model may replace the cart with a cheaper candidate from another restaurant', async () => {
  let current = cart('CA$50.00');
  const sequence: string[] = [];
  const result = await prepareCheckout(page, pick, [pick, cheap], options, {
    inspect: async () => current, edit: async () => assert.fail('Unexpected edit'),
    clear: async () => { sequence.push('clear'); },
    add: async (_, url, id) => { assert.equal(url, cheap.storeUrl); assert.equal(id, '2'); sequence.push('add'); current = cart('CA$19.00', ['Rice bowl']); return { ok: true }; },
    decide: async () => ({ action: 'replace', candidate: 1, reasoning: 'Choose cheaper restaurant' }),
  });
  assert.deepEqual(sequence, ['clear', 'add']);
  assert.equal(result.picked.restaurant, 'B');
});

test('inspection failures reach recovery; repeated failures stop after eight attempts', async () => {
  let decisions = 0;
  await assert.rejects(prepareCheckout(page, pick, [pick], options, {
    inspect: async () => { throw new Error('Layout changed'); },
    edit: async () => assert.fail('Unverified edit'), clear: async () => assert.fail('Unverified clear'), add: async () => assert.fail('Unverified add'),
    decide: async (input) => { assert.equal(input.cart, null); assert.match(input.problem, /Layout changed/); decisions++; return { action: 'retry', reasoning: 'Reload' }; },
  }), /after recovery attempts/);
  assert.equal(decisions, 8);
});

test('checkout timeouts retry navigation before asking the model, and refuse early stop', async () => {
  let inspects = 0;
  let decisions = 0;
  const result = await prepareCheckout(page, pick, [pick], options, {
    inspect: async () => {
      inspects += 1;
      if (inspects <= 2) throw new Error('page.waitForSelector: Timeout 20000ms exceeded');
      return cart('CA$25.00');
    },
    edit: async () => assert.fail('Unverified edit'), clear: async () => assert.fail('Unverified clear'), add: async () => assert.fail('Unverified add'),
    decide: async () => { decisions += 1; assert.fail('Early timeout retries must not call the model'); return { action: 'stop', reasoning: 'nope' }; },
  });
  assert.equal(inspects, 3);
  assert.equal(decisions, 0);
  assert.equal(result.checkout.checkoutTotal, 'CA$25.00');

  inspects = 0;
  decisions = 0;
  let forcedRetries = 0;
  await assert.rejects(prepareCheckout(page, pick, [pick], options, {
    inspect: async () => { inspects += 1; throw new Error('Timeout while reading checkout'); },
    edit: async () => assert.fail('Unverified edit'), clear: async () => assert.fail('Unverified clear'), add: async () => assert.fail('Unverified add'),
    decide: async () => {
      decisions += 1;
      return { action: 'stop', reasoning: 'Cart is null after one retry; stopping' };
    },
  }), /Cart is null after one retry|after recovery attempts/);
  assert.ok(inspects >= 4, `expected several inspect attempts, got ${inspects}`);
  assert.ok(decisions >= 1);
  forcedRetries = decisions;
  assert.ok(forcedRetries >= 1);
});

test('combination is approved only when every selected component is in the cart', async () => {
  const combo = { ...pick, item: 'Bowl + Rice', components: [
    { itemId:'1', item:'Bowl', price:15, estimatedMacros:pick.estimatedMacros },
    { itemId:'2', item:'Rice', price:5, estimatedMacros:pick.estimatedMacros },
  ] };
  let calls=0;
  await assert.rejects(prepareCheckout(page, combo, [combo], options, {
    inspect:async()=>cart('CA$25.00',['Bowl']), edit:async()=>{}, clear:async()=>{}, add:async()=>({ok:true}),
    decide:async(input)=>{calls++;assert.match(input.problem,/components/);return {action:'stop',reasoning:'Missing Rice'};},
  }),/Missing Rice/);
  assert.equal(calls,1);
  const result=await prepareCheckout(page, combo, [combo], options, {
    inspect:async()=>cart('CA$25.00',['Bowl','Rice']), edit:async()=>{}, clear:async()=>{}, add:async()=>({ok:true}),
    decide:async()=>assert.fail('Complete, in-budget combo needs no recovery'),
  });
  assert.equal(result.picked,combo);
});

test('combination adds stop on a partial failure so recovery cannot blindly duplicate a component', async () => {
  const { addMealToCart } = await import('../src/meal-components.ts');
  const combo = { ...pick, components: [
    {itemId:'1',item:'Bowl',price:15,estimatedMacros:pick.estimatedMacros},
    {itemId:'2',item:'Rice',price:5,estimatedMacros:pick.estimatedMacros},
  ] };
  const calls:string[]=[];
  const result=await addMealToCart(page,combo,async(_,url,id)=>{
    assert.equal(url,pick.storeUrl);calls.push(id);
    if(id==='2') throw new Error('Navigation timed out');
    return {ok:true};
  });
  assert.deepEqual(calls,['1','2']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'uncertain');
  assert.match(result.reason, /Navigation timed out/);
});
test('uncertain checkout replacement cancels and reconciles before inspecting the new page',async()=>{
  const fresh={...page} as Page;
  let current=cart('CA$50.00'),adds=0,clears=0,reconciles=0;
  const result=await prepareCheckout(page,pick,[cheap],options,{
    inspect:async tab=>{if(reconciles)assert.equal(tab,fresh);return current;},
    edit:async()=>assert.fail('Unexpected edit'),clear:async()=>{clears++;},
    add:async()=>{adds++;return {ok:false,status:'uncertain',reason:'click timed out'};},
    decide:async()=>({action:'replace',candidate:0,reasoning:'Lower price'}),
    reconcile:async()=>{reconciles++;current=cart('CA$19.00',['Rice bowl']);return {page:fresh,matched:true,cart:current};},
  });
  assert.equal(result.page,fresh);assert.equal(adds,1);assert.equal(clears,1);assert.equal(reconciles,1);
});
test('failed replacement reconciliation stops recovery before another mutation',async()=>{
  let adds=0;
  await assert.rejects(prepareCheckout(page,pick,[cheap],options,{
    inspect:async()=>cart('CA$50.00'),edit:async()=>{},clear:async()=>{},
    add:async()=>{adds++;return {ok:false,status:'uncertain',reason:'timeout'};},
    decide:async()=>({action:'replace',candidate:0,reasoning:'Lower price'}),
    reconcile:async()=>{throw Error('cart unreadable');},
  }),/could not be reconciled/);
  assert.equal(adds,1);
});
