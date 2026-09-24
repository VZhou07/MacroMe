import { test } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
process.env.OPENROUTER_API_KEY ||= 'test-only';
const { pickMeals } = await import('../src/macro-picker.ts');
const menus = ['A', 'B'].map((store) => ({ store, url: `https://example.com/${store}`, items: Array.from({length: 60}, (_, i) => ({ id: String(i), name: `Meal ${i}`, description: 'Ingredients '.repeat(30), price: 10 })) }));
const meal = { name: 'Lunch', time: '12:00', macroShare: 0.5 };
const macros = { calories: 2000, protein: 150, carbs: 200, fat: 60 };
const nutrition = () => null;
const sleep = async () => {};
// Keep menu order fixed so the canned model replies below reference items the prompt contains.
const shuffle = <T,>(items: readonly T[]) => [...items];

test('smaller balanced prompt, three choices, capped output and no hidden retries', async (t) => {
  const old = process.env.MACROME_MODEL;
  process.env.MACROME_MODEL = 'test-model';
  t.after(() => { if (old === undefined) delete process.env.MACROME_MODEL; else process.env.MACROME_MODEL = old; });
  const client = { chat: { completions: { create: async (request: any, options: any) => {
    assert.equal(request.model, 'test-model');
    assert.equal(request.max_tokens, 1200);
    assert.equal(request.reasoning.enabled, false);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeout, 45000);
    const prompt = request.messages[1].content;
    assert.equal((prompt.match(/\[\d+:\d+\]/g) || []).length, 20);
    assert.ok(prompt.includes('A / Meal') && prompt.includes('B / Meal'));
    return { choices: [{ message: { content: JSON.stringify(['0:0','1:0','0:1','1:1'].map(itemId => ({itemId, estimatedMacros:{calories:500,protein:40,carbs:50,fat:15},reasoning:'Fits'}))) } }] };
  } } } } as unknown as OpenAI;
  const result = await pickMeals(menus, meal, macros, 20, '', {client,nutrition,sleep,shuffle});
  assert.equal(result.picks.length, 3);
  assert.ok(result.picks.some(pick => pick.restaurant === 'B'));
  assert.equal(result.picks[0].itemId, '0', 'real menu IDs survive model prompt aliases');
});

test('model timeout falls back to heuristic menu picks instead of failing the run', async () => {
  let calls=0;
  const client = { chat: { completions: { create: async () => { calls++; throw new Error('Request timed out.'); } } } } as unknown as OpenAI;
  const result = await pickMeals(menus, meal, macros, 20, '', {client,nutrition,sleep,shuffle});
  assert.equal(calls,2);
  assert.ok(result.picks.length >= 1);
  assert.match(result.picks[0].reasoning, /Picked .+ for ~/i);
});

test('rate-limit failures fall back after one attempt', async () => {
  let calls=0;
  const client = { chat: { completions: { create: async () => { calls++; throw Object.assign(new Error('Rate limit'),{status:429}); } } } } as unknown as OpenAI;
  const result = await pickMeals(menus, meal, macros, 20, '', {client,nutrition,sleep,shuffle});
  assert.equal(calls,1);
  assert.ok(result.picks.length >= 1);
});

test('two-item meal uses combined price/macros and rejects mixed-store or over-budget combinations', async () => {
  const estimatedMacros = { calories: 300, protein: 25, carbs: 35, fat: 8 };
  const item = (itemId: string) => ({itemId, estimatedMacros});
  const response = (items: unknown[]) => ({choices:[{message:{content:JSON.stringify(items)}}]});
  const client = {chat:{completions:{create:async()=>response([
    {items:[item('0:0'),item('0:1')],reasoning:'Main plus side'},
    {items:[item('0:0'),item('1:0')],reasoning:'Invalid cross-store'},
    {items:[item('0:0'),item('0:0')],reasoning:'Invalid duplicate'},
  ])}}} as unknown as OpenAI;
  const result=await pickMeals(menus,meal,macros,20,'Dairy-free',{client,nutrition,sleep,shuffle});
  assert.equal(result.picks.length,3, 'a valid combination is followed by distinct menu alternatives');
  assert.equal(result.picks[0].components?.length,2);
  assert.equal(result.picks[0].price,20);
  assert.equal(result.picks[0].estimatedMacros.calories,600);
  assert.equal(result.picks[0].estimatedMacros.protein,50);
  assert.ok(result.picks.slice(1).every(pick => !pick.components?.some(component => ['0', '1'].includes(component.itemId) && pick.storeUrl === menus[0].url)));
  assert.match(result.debug.systemPrompt,/SUM of menu prices/);
  assert.match(result.debug.systemPrompt,/All components must obey dietary/);
  const overBudget = await pickMeals(menus,meal,macros,15,'',{client,nutrition,sleep,shuffle});
  assert.ok(overBudget.picks.length >= 1, 'over-budget model reply still yields heuristic picks');
});

test('a short or duplicate model reply gains distinct, dairy-compatible in-budget backups', async () => {
  const foodMenus = [{ store: 'Harvest', url: 'https://example.com/harvest', items: [
    { id: 'burrito', name: 'Thai Peanut Burrito', description: 'Rice, cabbage, carrots, roasted chicken and peanut sauce.', price: 14.95 },
    { id: 'bowl', name: 'Roasted Chicken Bowl', description: 'Rice, vegetables and roasted chicken.', price: 16.50 },
    { id: 'tofu', name: 'Tofu Rice Bowl', description: 'Rice, cabbage and tofu.', price: 13.25 },
    { id: 'cookie', name: 'Chocolate Chip Cookie', description: 'Single cookie.', price: 5 },
    { id: 'cheese', name: 'Mac and Cheese', description: 'Pasta and cheddar.', price: 12 },
    { id: 'expensive', name: 'Salmon Rice Bowl', description: 'Salmon and rice.', price: 30 },
  ] }];
  const answer = [0, 1].map(() => ({ itemId: '0:burrito', estimatedMacros: { calories: 510, protein: 32, carbs: 58, fat: 16 }, reasoning: 'A satisfying meal' }));
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) } } } as unknown as OpenAI;
  const result = await pickMeals(foodMenus, meal, macros, 24.81, 'Dairy-free',
    { client, nutrition, sleep, shuffle }, undefined, { dietary: ['Dairy-free'] });
  assert.deepEqual(result.picks.map(pick => pick.itemId), ['burrito', 'bowl', 'tofu']);
  assert.equal(new Set(result.picks.map(pick => pick.selectionId)).size, 3);
  assert.ok(result.picks.every(pick => pick.price <= 24.81));
});

test('unverified model macros copied from all four targets are replaced without repeating an unchosen option', async () => {
  const target = { calories: 516, protein: 38, carbs: 55, fat: 16 };
  const foodMenus = [{ store: 'Harvest', url: 'https://example.com/harvest', items: [
    { id: 'burrito', name: 'Thai Peanut Burrito', description: 'Rice, cabbage, choice of peanut tofu or roasted chicken.', price: 14.95 },
  ] }];
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify([
    { itemId: '0:burrito', estimatedMacros: target, reasoning: 'Exactly meets all macro targets with roasted chicken.' },
  ]) } }] }) } } } as unknown as OpenAI;
  const selection = await pickMeals(foodMenus, { ...meal, macroShare: 1 }, target, 24.81, 'Dairy-free',
    { client, nutrition, sleep, shuffle }, undefined, { dietary: ['Dairy-free'] });
  const pick = selection.picks[0];
  assert.equal(pick.item, 'Thai Peanut Burrito');
  assert.equal(pick.source, 'estimated');
  assert.notDeepEqual(pick.estimatedMacros, target);
  assert.deepEqual(pick.components?.[0].estimatedMacros, pick.estimatedMacros);
  assert.match(pick.reasoning, new RegExp(`~${pick.estimatedMacros.calories} kcal`));
  assert.doesNotMatch(pick.reasoning, /roasted chicken|exactly meets/i);

  const trusted = await pickMeals(foodMenus, { ...meal, macroShare: 1 }, target, 24.81, 'Dairy-free',
    { client, nutrition: () => ({ matchedName: 'Thai Peanut Burrito', macros: target }), sleep, shuffle },
    undefined, { dietary: ['Dairy-free'] });
  assert.equal(trusted.picks[0].source, 'usda');
  assert.deepEqual(trusted.picks[0].estimatedMacros, target);
});

test('empty model array falls back to heuristic picks', async () => {
  let calls=0;
  const client={chat:{completions:{create:async()=>{calls++;return {choices:[{message:{content:'[]'}}]};}}}} as unknown as OpenAI;
  const result=await pickMeals(menus,meal,macros,20,'',{client,nutrition,sleep,shuffle});
  assert.equal(calls,1);
  assert.ok(result.picks.length >= 1);
});
