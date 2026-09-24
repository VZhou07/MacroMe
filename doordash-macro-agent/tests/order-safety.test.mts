import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { isMealCandidate } from '../src/meal-eligibility.ts';
import { fallbackPicks } from '../src/fallback-picks.ts';
import { deterministicChoice, allowedRequiredChoices, assessCustomization, compatible } from '../src/modifiers.ts';
import { demoPlaceEnabled } from '../src/doordash.ts';
import { matchesSelectedOptions } from '../src/cart-modifiers.ts';

const dietary = { dietary: ['Dairy-free'] };
const target = { calories: 516, protein: 38, carbs: 55, fat: 16 };
const items = [
  { id: 'green', name: 'Be Green', description: 'Choose three sides.', price: 18.69 },
  { id: 'dahl', name: 'Red Lentil Dahl Stew', description: 'Coconut milk, tomatoes and turmeric rice.', price: 13.75 },
  { id: 'cookie', name: 'Bake-and-serve Salted Chocolate Chip Cookies', description: 'Half dozen.', price: 21 },
  { id: 'vegan-cookie', name: 'Bake-and-serve Enlightened Salted Chocolate Chip Cookies', description: 'Vegan half dozen.', price: 21 },
  { id: 'yogurt', name: 'Mediterranean Yogurt Dip', description: 'Greek yogurt and cucumber.', price: 9.90 },
];
const menu = [{ store: 'Mary Be Kitchen', url: 'https://www.doordash.com/store/237559/', items }];

test('an empty model choice cannot send cookies or dairy to the cart', async () => {
  process.env.OPENROUTER_API_KEY ||= 'test-only';
  const { pickMeals } = await import('../src/macro-picker.ts');
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '[]' } }] }) } } } as unknown as OpenAI;
  const meal = { name: 'Dinner', time: '18:30', macroShare: 1 };
  const result = await pickMeals(menu, meal, target, 24.81, 'Dairy-free',
    { client, nutrition: async () => null, sleep: async () => {}, shuffle: xs => [...xs] }, undefined, dietary);
  assert.ok(result.picks.length > 0);
  assert.ok(result.picks.every(p => !/cookie|yogurt/i.test(p.item)));
  assert.ok(fallbackPicks(menu, target, 24.81, '', 3, dietary).every(p => !/cookie|yogurt/i.test(p.item)));
  assert.equal(isMealCandidate(items[1], dietary), true, 'plant milk is not dairy');
  assert.equal(isMealCandidate({ id: 'shot', name: 'Smart Energy Wellness Shot', description: 'Green tea caffeine', price: 5.75 }, dietary), false);
});

test('required sides choose observed vegan options when the model gives no usable answer', () => {
  const context = { preferences: dietary, basePrice: 18.69, budget: 24.81, storeUrl: 'https://www.doordash.com/store/237559/' };
  const choices = ['Kale & Cabbage Caesar VT', 'Turmeric Rice VG', 'Roasted Sweet Potatoes VG', 'Grilled Broccoli VG', "Mary’s Mac VT"]
    .map((label, index) => ({ id: String(index), label, selected: false, disabled: false, price: 0, kind: 'stepper' }));
  const sideGroup = { id: 'sides', label: 'Choice of Sides', min: 3, max: 3, choices };
  assert.deepEqual(allowedRequiredChoices(sideGroup, context).map(choice => choice.label),
    ['Kale & Cabbage Caesar VT', 'Turmeric Rice VG', 'Roasted Sweet Potatoes VG', 'Grilled Broccoli VG', "Mary’s Mac VT"],
    'unknown choices remain available to the model, but cannot be chosen by the safe fallback');
  assert.deepEqual(allowedRequiredChoices({ ...sideGroup, label: 'Size', min: 1, max: 1,
    choices: [{ ...choices[0], label: 'Regular' }] }, context).map(choice => choice.label), ['Regular']);
  const chosen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = deterministicChoice(choices.filter(c => !c.selected), context);
    assert.ok(id);
    choices.find(c => c.id === id)!.selected = true;
    chosen.push(choices.find(c => c.id === id)!.label);
  }
  assert.deepEqual(chosen, ['Turmeric Rice VG', 'Roasted Sweet Potatoes VG', 'Grilled Broccoli VG']);
  assert.equal(deterministicChoice(choices.filter(c => /VG/.test(c.label)),
    { ...context, storeUrl: 'https://www.doordash.com/store/other/999/' }), undefined);
  assert.equal(compatible('Coconut milk with cheese', context), false);
});

test('a sides-only dish with explicit vegan selections passes dairy check without a second model call', async () => {
  const result = { complete: true, selectedOptions: ['Turmeric Rice VG', 'Roasted Sweet Potatoes VG', 'Grilled Broccoli VG'], groups: [], unresolved: [], extraPrice: 0 };
  await assessCustomization({ item: 'Be Green', description: 'Choose three sides.', preferences: dietary, storeUrl: 'https://www.doordash.com/store/237559/' }, result);
  assert.equal(result.complete, true);
});

test('real checkout is the default and demo mode must be explicit', () => {
  const previous = process.env.MACROME_DEMO_PLACE;
  try {
    delete process.env.MACROME_DEMO_PLACE;
    assert.equal(demoPlaceEnabled(), false);
    process.env.MACROME_DEMO_PLACE = '1';
    assert.equal(demoPlaceEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.MACROME_DEMO_PLACE;
    else process.env.MACROME_DEMO_PLACE = previous;
  }
});

test('a combined DoorDash modifier line confirms each selected side exactly once', () => {
  const cart = ['Turmeric Rice, Roasted Sweet Potatoes, Roasted Cauliflower'];
  assert.equal(matchesSelectedOptions(cart, ['Turmeric Rice VG', 'Roasted Sweet Potatoes VG', 'Roasted Cauliflower VG']), true);
  assert.equal(matchesSelectedOptions(cart, ['Turmeric Rice VG', 'Grilled Broccoli VG']), false);
  assert.equal(matchesSelectedOptions(cart, ['2 × Turmeric Rice VG']), false);
  assert.equal(matchesSelectedOptions(['Choice of Sides: Turmeric Rice'], ['Turmeric Rice VG']), true);
});
