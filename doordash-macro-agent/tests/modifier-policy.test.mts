import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequiredChoices, assessCustomization, chooseRequiredOption, compatible, deterministicChoice, type OptionGroup } from '../src/modifiers.ts';
import { sourceBackedDairyFreeChoice } from '../src/dietary-evidence.ts';

const context = { item: 'Burrito', description: 'Rice, cabbage, tofu and peanut sauce.', preferences: { dietary: ['Dairy-free'] } };
const wrapGroup: OptionGroup = { id: 'wrap', label: 'Wrap Options', min: 1, max: 1, choices: [
  { id: 'plain', label: 'Wrap', selected: false, disabled: false, price: 0, kind: 'radio' },
  { id: 'wheat', label: 'Whole Wheat Wrap', selected: false, disabled: false, price: 0, kind: 'radio' },
  { id: 'cheese', label: 'Cheese Wrap', selected: false, disabled: false, price: 0, kind: 'radio' },
] };

test('neutral required choices reach the model, while explicit dairy cannot', async () => {
  assert.deepEqual(allowedRequiredChoices(wrapGroup, context).map(choice => choice.id), ['plain', 'wheat']);
  assert.equal(deterministicChoice(allowedRequiredChoices(wrapGroup, context), context, wrapGroup), undefined);
  let calls = 0;
  const selected = await chooseRequiredOption(wrapGroup, context, [], async () => {
    calls++;
    return { choices: [{ message: { content: '{"id":"wheat"}' } }] };
  });
  assert.equal(calls, 1);
  assert.equal(selected, 'wheat');
  assert.equal(await chooseRequiredOption(wrapGroup, context, [], async () =>
    ({ choices: [{ message: { content: '{"id":null}' } }] })), undefined);
});

test('unknown wrap ingredients fail closed without whole-meal evidence', async () => {
  const result = { complete: true, selectedOptions: ['Whole Wheat Wrap'],
    groups: [{ ...wrapGroup, choices: wrapGroup.choices.map(choice => ({ ...choice, selected: choice.id === 'wheat' })) }],
    unresolved: [], extraPrice: 0 };
  const previous = process.env.OPENROUTER_API_KEY;
  try { delete process.env.OPENROUTER_API_KEY; await assessCustomization(context, result); }
  finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
  assert.equal(result.complete, false);
  assert.match(result.unresolved.join(' '), /customization-validation-unavailable/);
});

test('dairy veto recognizes removals and plant foods without overlooking actual dairy', () => {
  for (const label of ['Cow milk', 'Cheese Wrap', 'Feta', 'Butter sauce', 'Vegan cheese with butter'])
    assert.equal(compatible(label, context), false, label);
  for (const label of ['No cheese', 'Vegan cheese', 'Dairy-free cream', 'Peanut butter', 'Coconut cream', 'Butter lettuce', 'Tofu'])
    assert.equal(compatible(label, context), true, label);
});

test('restaurant evidence does not clear a changed ingredient list or an ambiguous wrap', () => {
  const documented = {
    item: 'Thai Peanut Burrito', storeUrl: 'https://www.doordash.com/store/50516008/',
    description: 'Thai Peanut Burrito\nRice, Purple Cabbage, Shredded Carrot, Cucumber, Green Onion, Peanuts, Choice of Peanut Tofu or Roasted Chicken, Cilantro, Thai Peanut Sauce\nCA$14.95',
  };
  const group = { ...wrapGroup, label: 'Wrap Options' };
  assert.equal(sourceBackedDairyFreeChoice(documented, group, 'Gluten Free Wrap +CA$2.00'), true);
  assert.equal(sourceBackedDairyFreeChoice(documented, group, 'Wrap'), false);
  assert.equal(sourceBackedDairyFreeChoice({ ...documented, description: documented.description + '\nNew dressing' }, group, 'Gluten Free Wrap +CA$2.00'), false);
});
