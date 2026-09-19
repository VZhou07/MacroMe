import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { resolveRequiredOptions, scanOptions, compatible, type OptionGroup } from '../src/modifiers.ts';
let browser: Browser, page: Page;
before(async()=>{ browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH}); page=await browser.newPage(); });
after(async()=>{await browser?.close();});
const choose = async(g: OptionGroup) => g.choices.filter(c=>!c.disabled&&!c.selected).sort((a,b)=>a.price-b.price)[0]?.id;
const resolve = (context = {}) => resolveRequiredOptions(page,context,Date.now()+5000,choose);
const dialog = (body: string) => `<div role="dialog">${body}<button data-testid="AddToCartButton">Add</button></div>`;
test('hidden inputs, required checkbox minimum and optional extras',async()=>{
  await page.setContent(`<label><input type="radio" name="outside">Outside</label>`+dialog(`<fieldset><legend>Protein Required Choose 1</legend><label><input hidden type="radio" name="protein" value="chicken">Chicken +$3</label><label><input hidden type="radio" name="protein" value="tofu">Tofu</label></fieldset><fieldset><legend>Sides Required Choose 2, maximum 2</legend><label><input type="checkbox" disabled>Sold out</label><label><input type="checkbox">Rice</label><label><input type="checkbox">Beans</label></fieldset><fieldset><legend>Extras Optional</legend><label><input type="checkbox">Avocado +$2</label></fieldset>`));
  const result=await resolve(); assert.equal(result.complete,true); assert.deepEqual(result.selectedOptions,['Tofu','Rice','Beans']); assert.equal(await page.locator('input[name="outside"]:checked').count(),0); assert.equal(await page.getByLabel('Avocado +$2').isChecked(),false);
});
test('ARIA radios, disabled choices and conditional required groups',async()=>{
  await page.setContent(dialog(`<div role="radiogroup" aria-label="Base"><h3>Base Required</h3><div role="radio" aria-disabled="true">Unavailable</div><div role="radio" aria-checked="false" onclick="this.setAttribute('aria-checked','true');document.querySelector('#conditional').hidden=false">Bowl</div></div><fieldset id="conditional" hidden><legend>Sauce Required</legend><label><input type="radio" name="sauce">Salsa</label></fieldset>`));
  const result=await resolve();assert.equal(result.complete,true);assert.deepEqual(result.selectedOptions,['Bowl','Salsa']);
});
test('dropdowns and existing selections are preserved',async()=>{
  await page.setContent(dialog(`<fieldset><legend>Size Required</legend><select><option value="">Select size</option><option value="small">Small</option><option value="large">Large +$4</option></select></fieldset><fieldset><legend>Extra Optional</legend><label><input type="checkbox" checked>Sesame</label></fieldset>`));
  assert.deepEqual((await resolve()).selectedOptions,['Small','Sesame']);
});
test('model cannot choose an invented ID or disabled option',async()=>{
  await page.setContent(dialog(`<fieldset><legend>Protein Required</legend><label><input type="radio" disabled>Chicken</label><label><input type="radio">Tofu</label></fieldset>`));
  const result=await resolveRequiredOptions(page,{},Date.now()+1000,async()=> 'invented');assert.equal(result.complete,false);assert.equal(await page.locator('input:checked').count(),0);
});
test('incompatible choices fail closed and report unresolved groups',async()=>{
  await page.setContent(dialog(`<fieldset><legend>Protein Required</legend><label><input type="radio">Chicken</label></fieldset>`));
  const result=await resolve({preferences:{dietary:['Vegan']}});assert.equal(result.complete,false);assert.equal(result.unresolved.length,1);assert.equal(await page.locator('input:checked').count(),0);
  assert.equal(compatible('Peanut sauce',{preferences:{avoid:'peanut'}}),false);
});
test('actual scrolling panel reveals a conditional group and leaves document scroll unchanged',async()=>{
  await page.setContent(dialog(`<div style="height:100px;overflow-y:auto" onscroll="if(this.scrollTop>100)document.querySelector('#late').hidden=false"><div style="height:300px">Options</div><fieldset id="late" hidden><legend>Choose 2 Required</legend><label><input type="checkbox">Rice</label><label><input type="checkbox">Beans</label></fieldset><div style="height:100px"></div></div>`));
  const result=await resolve();assert.equal(result.complete,true);assert.deepEqual(result.selectedOptions,['Rice','Beans']);assert.equal(await page.evaluate(()=>window.scrollY),0);
});
test('already selected incompatible food and price overruns are rejected',async()=>{
  await page.setContent(dialog(`<fieldset><legend>Protein Required</legend><label><input type="radio" checked>Chicken +$5</label></fieldset>`));
  assert.equal((await resolve({preferences:{dietary:['Vegetarian']}})).complete,false);
  assert.equal((await resolve({basePrice:10,budget:12})).complete,false);
});
test('ARIA dropdown options are scoped through aria-controls',async()=>{
  await page.setContent(dialog(`<fieldset><legend>Size Required</legend><button role="combobox" aria-controls="sizes" onclick="document.querySelector('#sizes').hidden=false">Select size</button><div id="sizes" role="listbox" hidden><div role="option" aria-selected="false" onclick="this.setAttribute('aria-selected','true');document.querySelector('[role=combobox]').textContent='Regular';this.parentElement.hidden=true">Regular</div></div></fieldset>`));
  assert.deepEqual((await resolve()).selectedOptions,['Regular']);
});
test('required radio default can be replaced by a compatible observed option',async()=>{
  await page.setContent(dialog('<fieldset><legend>Protein Required</legend><label><input type="radio" name="p" checked>Chicken</label><label><input type="radio" name="p">Tofu</label></fieldset>'));
  const result=await resolve({preferences:{dietary:['Vegetarian']}});
  assert.equal(result.complete,true);assert.deepEqual(result.selectedOptions,['Tofu']);
});
test('labeled option rows and repeated group titles retain independent selection state',async()=>{
  await page.setContent(dialog('<section><h3>Choose 1 Required</h3><div data-state="unchecked" onclick="this.dataset.state=\'checked\'">Rice</div></section><section><h3>Choose 1 Required</h3><div data-state="unchecked" onclick="this.dataset.state=\'checked\'">Beans</div></section>'));
  const result=await resolve();assert.equal(result.complete,true);assert.deepEqual(result.selectedOptions,['Rice','Beans']);
});
test('explicit restaurant dietary labels validate unchanged meals without inventing nutrition',async()=>{
  const { assessCustomization }=await import('../src/modifiers.ts');
  const result={complete:true,selectedOptions:[],groups:[],unresolved:[],extraPrice:0};
  await assessCustomization({item:'Bowl',description:'Tuna, rice, cucumber\nGluten Free / Dairy Free / Contains Nuts',dialogDescription:'Optional extras: cheese, cream',preferences:{dietary:['Dairy-free']}},result);
  assert.equal(result.complete,true);assert.equal('estimatedMacros' in result,false);
});
test('transient empty model responses retry once while explicit unsafe decisions remain unsafe',async()=>{
  const { requestOptionObject }=await import('../src/modifiers.ts');
  let calls=0;
  const result=await requestOptionObject(async()=>++calls===1?{error:{message:'temporary provider failure'}}:{choices:[{message:{content:'{"safe":false}'}}]});
  assert.equal(calls,2);assert.equal(result.safe,false);
  calls=0;await assert.rejects(requestOptionObject(async()=>{calls++;return {};}),/model-response-unavailable/);assert.equal(calls,2);
});
test('required quantity buttons use the food row label and preserve optional add-ons',async()=>{
  const row=(name:string)=>`<div><div><span>${name}</span></div><div><div><button data-testid="IncrementQuantity" aria-label="Increase quantity by 1" onclick="this.parentElement.insertAdjacentHTML('afterbegin','<button data-testid=DecrementQuantity aria-label=Decrease></button><span>1</span>');this.disabled=true"></button></div></div></div>`;
  await page.setContent(dialog(`<div role="group"><h3>Add Protein</h3><span>Required • Select at least 1</span>${row('No Protein Add-On')}${row('Tofu +CA$7.34')}</div><div role="group"><h3>Extras Optional Select up to 5</h3>${row('Avocado +CA$3.08')}</div>`));
  const result=await resolve();
  assert.equal(result.complete,true);assert.deepEqual(result.selectedOptions,['No Protein Add-On']);
  assert.equal(await page.locator('[data-testid="DecrementQuantity"]').count(),1);
  await page.locator('[data-testid="DecrementQuantity"] + span').evaluate(el => { el.textContent = '2'; });
  await page.locator('[role="group"]').first().evaluate(el => el.setAttribute('data-max','1'));
  assert.equal((await resolve()).complete,false,'existing quantity must count toward the group maximum');
});
