import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUncertainAdd } from '../src/cart-reconciliation.ts';
import { cartContainsMeal, addMealToCart } from '../src/meal-components.ts';
import type { PickedMeal, CheckoutSummary } from '../src/types.ts';
const pick: PickedMeal={item:'Bowl',itemId:'1',price:10,restaurant:'Fixture',storeUrl:'https://example.test',estimatedMacros:{calories:500,protein:30,carbs:60,fat:15},source:'estimated',macroConsistent:true,score:0,reasoning:'fixture',selectedOptions:['Tofu']};
const cart=(quantity=1,modifiers=['Tofu']):CheckoutSummary=>({cartItems:[{name:'Bowl',quantity,linePrice:'$10',modifiers}],checkoutTotal:'$13'});
const page:any={waitForTimeout:async()=>{}};
test('timeout after successful mutation cancels work then confirms cart without another add',async()=>{
  const events:string[]=[];
  const result=await reconcileUncertainAdd(page,pick,{close:async()=>{events.push('cancel');},open:async()=>{events.push('open');return page;},inspect:async()=>{events.push('inspect');return cart();},clear:async()=>assert.fail('Must not clear a matching cart')});
  assert.equal(result.matched,true);assert.deepEqual(events,['cancel','open','inspect']);
});
test('delayed cart update is reread without retrying the mutation',async()=>{
  let reads=0,clears=0;
  const result=await reconcileUncertainAdd(page,pick,{close:async()=>{},open:async()=>page,inspect:async()=>++reads<3?null:cart(),clear:async()=>{clears++;}});
  assert.equal(result.matched,true);assert.equal(reads,3);assert.equal(clears,0);
});
test('partial combo is inspected before clearing; failed clearing prevents another candidate',async()=>{
  const combo={...pick,components:[{...pick},{...pick,item:'Rice',itemId:'2'}]};
  const events:string[]=[];
  await assert.rejects(reconcileUncertainAdd(page,combo,{close:async()=>{events.push('close');},open:async()=>page,inspect:async()=>{events.push('inspect');return cart();},clear:async()=>{events.push('clear');throw Error('clear failed');}}),/clear failed/);
  assert.deepEqual(events,['close','inspect','inspect','inspect','clear','close']);
});
test('unreadable cart stops with zero mutations',async()=>{
  await assert.rejects(reconcileUncertainAdd(page,pick,{close:async()=>{},open:async()=>page,inspect:async()=>null,clear:async()=>assert.fail('Unreadable cart must not be edited')}),/uncertain-cart-unreadable/);
});
test('matching requires exact quantities, components and selected modifiers',()=>{
  assert.equal(cartContainsMeal(cart(),pick),true);
  assert.equal(cartContainsMeal(cart(2),pick),false);
  assert.equal(cartContainsMeal(cart(1,['Chicken']),pick),false);
  assert.equal(cartContainsMeal({...cart(),cartItems:[...cart().cartItems,{name:'Rice',quantity:1,linePrice:'$3',modifiers:[]}]},pick),false);
});
test('selected modifiers are retained before a timed-out add returns',async()=>{
  const customized=structuredClone(pick);
  const result=await addMealToCart(page,customized,async(_page,_url,_id,options)=>{
    options?.onCustomization?.({complete:true,selectedOptions:['Beans'],unresolved:[],groups:[],extraPrice:2,estimatedMacros:{calories:550,protein:35,carbs:65,fat:16}});
    assert.deepEqual(customized.selectedOptions,['Beans']);throw Error('timeout after mutation');
  });
  assert.equal(result.status,'uncertain');assert.equal(customized.price,12);assert.equal(customized.estimatedMacros.protein,35);
});
