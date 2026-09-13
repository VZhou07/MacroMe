// MacroMe onboarding wizard: collects the user's plan and saves it for the DoorDash agent.

const STEPS = [
  { id: 'macros', label: 'Macro goals' },
  { id: 'meals', label: 'Meals & times' },
  { id: 'budget', label: 'Budget' },
  { id: 'days', label: 'Delivery days' },
  { id: 'location', label: 'Locations' },
  { id: 'prefs', label: 'Food preferences' },
  { id: 'review', label: 'Review' },
];

const DAYS = [
  ['mon', 'Mon', 'Monday'], ['tue', 'Tue', 'Tuesday'], ['wed', 'Wed', 'Wednesday'],
  ['thu', 'Thu', 'Thursday'], ['fri', 'Fri', 'Friday'], ['sat', 'Sat', 'Saturday'], ['sun', 'Sun', 'Sunday'],
];
const JS_DAY_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The first three are the default day; "+" adds the rest in this order, "−" removes the most recent.
const MEAL_SEQUENCE = [
  ['Breakfast', '08:00'],
  ['Lunch', '12:30'],
  ['Dinner', '18:30'],
  ['Brunch', '10:30'],
  ['Afternoon snack', '15:30'],
  ['Late-night snack', '22:00'],
];
const DEFAULT_MEALS = 3;
const MIN_MEALS = 1;
const MAX_MEALS = MEAL_SEQUENCE.length;
const MAX_ADDRESSES = 3;
const ADDRESS_COLORS = ['#2E5E3E', '#C98A1E', '#4A6FA5'];
const ADDRESS_NAMES = ['Home', 'Work', 'Other'];
const DRAFT_KEY = 'macrome-draft-v2';

const CUISINES = ['Japanese', 'Mediterranean', 'Mexican', 'Thai', 'Indian', 'Chinese', 'Korean', 'Italian', 'American', 'Middle Eastern', 'Vietnamese', 'Greek'];
// Anything selected here is passed to the agent as a hard constraint.
const DIETS = ['Vegetarian', 'Vegan', 'Pescatarian', 'Gluten-free', 'Dairy-free', 'Nut-free', 'Halal', 'Kosher'];
// Diets that usefully narrow a DoorDash store search; the rest are filters, not search terms.
const SEARCHABLE_DIETS = ['Vegan', 'Vegetarian', 'Halal', 'Kosher'];

const uid = () => Math.random().toString(36).slice(2, 9);
const newAddress = (label) => ({ id: uid(), label, street: '', apt: '', city: '', state: '', zip: '', dropoff: 'door', instructions: '' });

const defaultState = () => ({
  macros: { protein: '', carbs: '', fat: '' },
  meals: MEAL_SEQUENCE.slice(0, DEFAULT_MEALS).map(([name, time]) => ({ id: uid(), name, time })),
  orderLeadMinutes: 45,
  budget: { amount: 40, period: 'day', includesFeesAndTip: true, tipPercent: 15 },
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  addresses: [newAddress('Home')],
  assignments: {}, // "day|mealId" -> addressId; missing entries use the first address
  prefs: { cuisines: [], dietary: [], avoid: '', searchQuery: '', searchQueryEdited: false },
});

let state = loadDraft() || defaultState();
let current = 0;
let furthest = 0;

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const form = $('#wizard');
const field = (name) => form.elements[name];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const money = (n) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
const calories = (m) => Math.round(num(m.protein) * 4 + num(m.carbs) * 4 + num(m.fat) * 9);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}
function minusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m - mins + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // Shallow merge, so sections added after a draft was saved need a backfill.
    return { ...defaultState(), ...saved, prefs: { ...defaultState().prefs, ...(saved.prefs || {}) } };
  } catch { return null; }
}
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function ordersPerWeek() { return state.meals.length * state.days.length; }

function perOrderBudget() {
  const { amount, period } = state.budget;
  if (period === 'meal') return num(amount);
  if (period === 'day') return num(amount) / state.meals.length;
  return ordersPerWeek() ? num(amount) / ordersPerWeek() : 0;
}

// What's actually left for food once DoorDash's fees and the tip come out of a
// per-order budget. Mirrors cartBudget() in doordash-macro-agent/src/plan.ts.
const DELIVERY_FEE_ESTIMATE = 3.99;
const SERVICE_FEE_PERCENT = 15;
const MIN_CART_BUDGET = 5;

function foodBudget() {
  const perOrder = perOrderBudget();
  if (!state.budget.includesFeesAndTip) return perOrder;
  const afterDelivery = perOrder - DELIVERY_FEE_ESTIMATE;
  return Math.max(MIN_CART_BUDGET, afterDelivery / (1 + (num(state.budget.tipPercent) + SERVICE_FEE_PERCENT) / 100));
}

function perMealMacros() {
  const n = state.meals.length;
  return {
    calories: Math.round(calories(state.macros) / n),
    protein: Math.round(num(state.macros.protein) / n),
    carbs: Math.round(num(state.macros.carbs) / n),
    fat: Math.round(num(state.macros.fat) / n),
  };
}

const selectedDays = () => DAYS.filter(([k]) => state.days.includes(k));
const mealsByTime = () => [...state.meals].sort((a, b) => a.time.localeCompare(b.time));
const addressColor = (id) => ADDRESS_COLORS[Math.max(0, state.addresses.findIndex((a) => a.id === id))];

function addressFor(day, mealId) {
  const id = state.assignments[`${day}|${mealId}`];
  return state.addresses.some((a) => a.id === id) ? id : state.addresses[0].id;
}

function ordersPerAddress() {
  const counts = Object.fromEntries(state.addresses.map((a) => [a.id, 0]));
  selectedDays().forEach(([day]) => state.meals.forEach((m) => { counts[addressFor(day, m.id)] += 1; }));
  return counts;
}

// ---------- rendering ----------
function renderStepList() {
  $('#stepList').innerHTML = STEPS.map((s, i) => {
    const cls = i === current ? 'current' : i <= furthest ? 'done' : '';
    return `<li class="${cls}"><button type="button" data-goto="${i}" ${i > furthest ? 'disabled' : ''}>
      <span class="num">${cls === 'done' ? '✓' : i + 1}</span>${s.label}</button></li>`;
  }).join('');
  $('#progressBar').style.width = `${((current + 1) / STEPS.length) * 100}%`;
}

function renderMacros() {
  const m = state.macros;
  ['protein', 'carbs', 'fat'].forEach((k) => { if (document.activeElement !== field(k)) field(k).value = m[k]; });
  const cal = calories(m);
  $('#calTotal').textContent = cal.toLocaleString();
  const parts = { protein: num(m.protein) * 4, carbs: num(m.carbs) * 4, fat: num(m.fat) * 9 };
  const bar = $('#splitBar');
  Object.entries(parts).forEach(([k, v]) => { $(`.${k}`, bar).style.width = cal ? `${(v / cal) * 100}%` : '0'; });
}

function renderMeals() {
  const n = state.meals.length;
  $('#mealCount').textContent = n;
  $('#mealsMinus').disabled = n <= MIN_MEALS;
  $('#mealsPlus').disabled = n >= MAX_MEALS;
  // Rows show in time order; data-meal keeps the index into state.meals.
  const rows = state.meals.map((meal, i) => [meal, i]).sort(([a], [b]) => a.time.localeCompare(b.time));
  $('#mealRows').innerHTML = rows.map(([meal, i], pos) => `
    <div class="meal-row">
      <span class="meal-idx">${pos + 1}</span>
      <input type="text" data-meal="${i}" data-key="name" value="${esc(meal.name)}" aria-label="Meal ${pos + 1} name" maxlength="30">
      <input type="time" data-meal="${i}" data-key="time" value="${esc(meal.time)}" aria-label="Meal ${pos + 1} time">
    </div>`).join('');
}

const TIP_STEP = 1;
const TIP_MAX = 30;

function renderBudget() {
  const b = state.budget;
  if (document.activeElement !== field('budget')) field('budget').value = b.amount;
  const range = $('#budgetRange');
  const max = { meal: 60, day: 150, week: 700 }[b.period];
  range.max = max;
  range.value = Math.min(num(b.amount), max);
  $$('#budgetPeriod button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.period === b.period)));
  field('includesFees').checked = b.includesFeesAndTip;
  $('#tipOutput').textContent = `${b.tipPercent}%`;
  $('#tipMinus').disabled = b.tipPercent <= 0;
  $('#tipPlus').disabled = b.tipPercent >= TIP_MAX;

  const perOrder = perOrderBudget();
  const food = foodBudget();
  const weekly = perOrder * ordersPerWeek();
  const tight = food < 10;
  $('#budgetStats').innerHTML = `
    <div class="stat"><b>${money(perOrder)}</b>per order</div>
    <div class="stat ${tight ? 'warn' : ''}"><b>${money(food)}</b>${b.includesFeesAndTip ? 'for food, after fees and tip' : 'for food'}</div>
    <div class="stat"><b>${money(weekly)}</b>per week</div>`;
  $('#budgetNote').innerHTML = tight
    ? `Most DoorDash mains cost more than ${money(food)}, so the agent may not find anything it can order. Raise the budget, order fewer meals a day, or untick the box above.`
    : '';
  $('#budgetNote').hidden = !tight;
}

function renderDays() {
  const n = state.meals.length;
  $('#dayChips').innerHTML = DAYS.map(([key, short, long]) =>
    `<button type="button" class="day" data-day="${key}" aria-pressed="${state.days.includes(key)}" aria-label="${long}">${short}<small>${state.days.includes(key) ? plural(n, 'meal') : 'off'}</small></button>`).join('');
  const set = [...state.days].sort().join();
  const presets = { weekdays: 'fri,mon,thu,tue,wed', weekends: 'sat,sun', all: 'fri,mon,sat,sun,thu,tue,wed' };
  $$('[data-days]').forEach((b) => b.setAttribute('aria-pressed', String(presets[b.dataset.days] === set)));
}

function renderAddresses() {
  const many = state.addresses.length > 1;
  $('#addressList').innerHTML = state.addresses.map((a, i) => {
    const input = (key, label, auto, extra = '') => `
      <label class="field ${extra}">
        <span>${label}</span>
        <input data-addr="${i}" data-key="${key}" value="${esc(a[key])}" autocomplete="section-addr${i} ${auto}">
      </label>`;
    return `
    <div class="card address" style="--addr:${ADDRESS_COLORS[i]}">
      <div class="address-head">
        <span class="addr-dot"></span>
        <input class="addr-label" data-addr="${i}" data-key="label" value="${esc(a.label)}" maxlength="20" aria-label="Name for address ${i + 1}">
        ${many ? `<button type="button" class="link" data-remove-addr="${i}">Remove</button>` : ''}
      </div>
      <div class="form-grid">
        ${input('street', 'Street address', 'address-line1', 'span-2')}
        ${input('apt', 'Apt / suite / floor <small>optional</small>', 'address-line2')}
        ${input('city', 'City', 'address-level2')}
        ${input('state', 'State / province', 'address-level1')}
        ${input('zip', 'ZIP / postal code', 'postal-code')}
      </div>
      <span class="field-title spaced">Drop-off</span>
      <div class="seg" role="group" aria-label="Drop-off preference for ${esc(a.label)}">
        <button type="button" data-addr-dropoff="${i}" data-value="door" aria-pressed="${a.dropoff === 'door'}">Leave at door</button>
        <button type="button" data-addr-dropoff="${i}" data-value="hand" aria-pressed="${a.dropoff === 'hand'}">Hand it to me</button>
      </div>
      <label class="field spaced">
        <span>Instructions for the driver <small>optional</small></span>
        <textarea data-addr="${i}" data-key="instructions" rows="2" placeholder="Buzz 402, side entrance by the bike rack">${esc(a.instructions)}</textarea>
      </label>
    </div>`;
  }).join('');
  $('#addAddress').hidden = state.addresses.length >= MAX_ADDRESSES;
  renderAssignments();
}

function renderAssignments() {
  const card = $('#assignCard');
  card.hidden = state.addresses.length < 2;
  if (card.hidden) return;

  const options = (selected) => state.addresses
    .map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.label || 'Unnamed')}</option>`).join('');

  const meals = mealsByTime();
  $('#assignTable').innerHTML = `
    <thead><tr><th>Day</th>${meals.map((m) => `<th>${esc(m.name)}<small>${fmtTime(m.time)}</small></th>`).join('')}</tr></thead>
    <tbody>${selectedDays().map(([day, short, long]) => `
      <tr><th scope="row">${short}</th>${meals.map((m) => {
        const id = addressFor(day, m.id);
        return `<td><select class="addr-select" data-assign="${day}|${m.id}" style="--addr:${addressColor(id)}" aria-label="${long} ${esc(m.name)} address">${options(id)}</select></td>`;
      }).join('')}</tr>`).join('')}
    </tbody>`;
}

// What the agent types into DoorDash's store search. Kept in sync with the
// chips unless the user has typed their own query.
function derivedSearchQuery() {
  const { cuisines, dietary } = state.prefs;
  const parts = [];
  if (cuisines.length === 1) parts.push(cuisines[0]);
  const diet = dietary.find((d) => SEARCHABLE_DIETS.includes(d));
  if (diet) parts.push(diet);
  parts.push('healthy');
  return parts.join(' ').toLowerCase();
}

function effectiveSearchQuery() {
  const typed = state.prefs.searchQuery.trim();
  return state.prefs.searchQueryEdited && typed ? typed : derivedSearchQuery();
}

function renderPrefs() {
  const chip = (value, on) => `<button type="button" class="chip" data-pref-chip="${esc(value)}" aria-pressed="${on}">${esc(value)}</button>`;
  $('#cuisineChips').innerHTML = CUISINES.map((c) => chip(c, state.prefs.cuisines.includes(c))).join('');
  $('#dietChips').innerHTML = DIETS.map((d) => chip(d, state.prefs.dietary.includes(d))).join('');
  if (document.activeElement !== field('avoid')) field('avoid').value = state.prefs.avoid;
  if (document.activeElement !== field('searchQuery')) field('searchQuery').value = effectiveSearchQuery();
}

function prefsSummary() {
  const { cuisines, dietary, avoid } = state.prefs;
  const bits = [];
  if (cuisines.length) bits.push(cuisines.join(', '));
  if (dietary.length) bits.push(`${dietary.join(', ')} only`);
  if (avoid.trim()) bits.push(`no ${avoid.trim()}`);
  return bits.length ? bits.join(' · ') : 'No restrictions';
}

function renderReview() {
  const m = state.macros;
  const counts = ordersPerAddress();
  const dayNames = selectedDays().map(([, s]) => s).join(', ');
  const addrLines = state.addresses.map((a, i) => `
    <li><span class="addr-dot" style="--addr:${ADDRESS_COLORS[i]}"></span>
    <span><b>${esc(a.label)}</b> · ${esc(`${a.street}${a.apt ? `, ${a.apt}` : ''}, ${a.city}, ${a.state} ${a.zip}`)} · ${a.dropoff === 'door' ? 'Leave at door' : 'Hand to me'} · ${plural(counts[a.id], 'order')}/week</span></li>`).join('');
  const items = [
    ['macros', 'Daily macros', `${calories(m).toLocaleString()} cal`, `${m.protein}g protein · ${m.carbs}g carbs · ${m.fat}g fat`],
    ['meals', 'Meals', `${state.meals.length}/day`, mealsByTime().map((x) => `${esc(x.name)} ${fmtTime(x.time)}`).join(' · ')],
    ['budget', 'Budget', `${money(num(state.budget.amount))}/${state.budget.period}`, `≈ ${money(perOrderBudget())} per order · ${money(foodBudget())} for food · ${state.budget.tipPercent}% tip${state.budget.includesFeesAndTip ? ' · fees included' : ''}`],
    ['days', 'Days', `${ordersPerWeek()} meals/week`, dayNames],
    ['location', 'Deliver to', plural(state.addresses.length, 'address'), `<ul class="addr-lines">${addrLines}</ul>`, 'wide'],
    ['prefs', 'Food', esc(effectiveSearchQuery()), esc(prefsSummary())],
  ];
  $('#review').innerHTML = items.map(([step, title, main, sub, cls = '']) => `
    <div class="card ${cls}">
      <div class="review-head"><h3>${title}</h3><button type="button" class="link" data-goto="${STEPS.findIndex((s) => s.id === step)}">Edit</button></div>
      <div class="review-main">${main}</div>
      <div class="review-sub">${sub}</div>
    </div>`).join('');
}

function render() {
  const stepId = STEPS[current]?.id ?? 'done';
  $$('.step').forEach((s) => s.classList.toggle('active', s.dataset.step === stepId));
  $('#nav').hidden = stepId === 'done';
  $('#back').style.visibility = current === 0 ? 'hidden' : 'visible';
  $('#next').textContent = stepId === 'review' ? 'Launch agent' : stepId === 'prefs' ? 'Review plan' : 'Continue';
  $$('.eyebrow').forEach((e, i) => { e.textContent = `Step ${i + 1} of ${STEPS.length}`; });
  renderStepList();
  ({ macros: renderMacros, meals: renderMeals, budget: renderBudget, days: renderDays, location: renderAddresses, prefs: renderPrefs, review: renderReview }[stepId] || (() => {}))();
}

// ---------- validation ----------
function validate(stepId) {
  $$('.invalid').forEach((el) => el.classList.remove('invalid'));
  const fail = (msg, ...names) => { names.forEach((n) => field(n)?.classList.add('invalid')); return msg; };

  if (stepId === 'macros') {
    const m = state.macros;
    const bad = ['protein', 'carbs', 'fat'].filter((k) => m[k] === '' || num(m[k]) < 0);
    if (bad.length) return fail('Enter a number for each macro (0 is fine).', ...bad);
    if (num(m.protein) <= 0) return fail('Set a protein goal so the agent has something to aim for.', 'protein');
    const cal = calories(m);
    if (cal < 800 || cal > 6000) return fail(`${cal.toLocaleString()} calories a day looks off. Check your numbers.`, 'protein', 'carbs', 'fat');
  }
  if (stepId === 'meals') {
    const mark = (i, key) => $(`#mealRows [data-meal="${i}"][data-key="${key}"]`)?.classList.add('invalid');
    const blankName = state.meals.findIndex((x) => !x.name.trim());
    if (blankName >= 0) { mark(blankName, 'name'); return 'Give every meal a name.'; }
    const blankTime = state.meals.findIndex((x) => !x.time);
    if (blankTime >= 0) { mark(blankTime, 'time'); return `Pick a time for ${state.meals[blankTime].name.trim()}.`; }
    const times = state.meals.map((x) => x.time);
    const dup = times.findIndex((t, i) => times.indexOf(t) !== i);
    if (dup >= 0) { mark(dup, 'time'); return 'Two meals share the same time. Give each one its own time.'; }
  }
  if (stepId === 'budget') {
    if (num(state.budget.amount) <= 0) return fail('Enter a budget above $0.', 'budget');
    if (perOrderBudget() < 5) return fail(`That works out to ${money(perOrderBudget())} per order, which won't cover DoorDash fees. Raise the budget or order fewer meals.`, 'budget');
    if (foodBudget() <= MIN_CART_BUDGET) return fail(`After fees and tip that leaves about ${money(foodBudget())} for the food itself, which won't buy a meal. Raise the budget or order fewer meals a day.`, 'budget');
  }
  if (stepId === 'days' && !state.days.length) return 'Pick at least one day.';
  if (stepId === 'prefs') {
    if (!effectiveSearchQuery().trim()) return fail('Give the agent something to search DoorDash for.', 'searchQuery');
    const conflict = ['Vegan', 'Vegetarian', 'Pescatarian'].filter((d) => state.prefs.dietary.includes(d));
    if (conflict.length > 1) return `${conflict.join(' and ')} can't both apply. Pick the one that fits.`;
  }
  if (stepId === 'location') {
    const mark = (i, ...keys) => keys.forEach((k) => $(`[data-addr="${i}"][data-key="${k}"]`)?.classList.add('invalid'));
    const labels = state.addresses.map((a) => a.label.trim().toLowerCase());
    for (const [i, a] of state.addresses.entries()) {
      const name = a.label.trim() || `Address ${i + 1}`;
      if (!a.label.trim()) { mark(i, 'label'); return `Give address ${i + 1} a name, like Home or Work.`; }
      if (labels.indexOf(labels[i]) !== i) { mark(i, 'label'); return `Two addresses are both called "${a.label.trim()}". Give each one a different name.`; }
      const missing = ['street', 'city', 'state', 'zip'].filter((k) => !a[k].trim());
      if (missing.length) { mark(i, ...missing); return `Fill in the street, city, state and ZIP for ${name}.`; }
      if (!/^([0-9]{5}(-[0-9]{4})?|[A-Za-z][0-9][A-Za-z] ?[0-9][A-Za-z][0-9])$/.test(a.zip.trim())) { mark(i, 'zip'); return `The ZIP or postal code for ${name} doesn't look right.`; }
    }
    const unused = state.addresses.filter((a) => ordersPerAddress()[a.id] === 0);
    if (unused.length) return `${unused.map((a) => a.label).join(' and ')} isn't used for any meal. Assign it in the table below or remove it.`;
  }
  return null;
}

function showError(msg) {
  const el = $('#error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- config output (what the agent reads) ----------
function buildConfig() {
  const meals = mealsByTime().map((x) => ({ name: x.name.trim(), time: x.time, orderAt: minusMinutes(x.time, state.orderLeadMinutes) }));
  const trim = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const addresses = state.addresses.map(trim);
  const schedule = selectedDays().flatMap(([day]) => mealsByTime().map((m) => ({
    day,
    meal: m.name.trim(),
    time: m.time,
    orderAt: minusMinutes(m.time, state.orderLeadMinutes),
    addressId: addressFor(day, m.id),
  })));
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    macros: { calories: calories(state.macros), protein: num(state.macros.protein), carbs: num(state.macros.carbs), fat: num(state.macros.fat) },
    meals,
    orderLeadMinutes: state.orderLeadMinutes,
    budget: { ...state.budget, amount: num(state.budget.amount) },
    days: selectedDays().map(([k]) => k),
    addresses,
    schedule,
    preferences: {
      cuisines: [...state.prefs.cuisines],
      dietary: [...state.prefs.dietary],
      avoid: state.prefs.avoid.trim(),
      searchQuery: effectiveSearchQuery(),
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    derived: {
      perMealMacros: perMealMacros(),
      perOrderBudget: Math.round(perOrderBudget() * 100) / 100,
      ordersPerWeek: ordersPerWeek(),
    },
  };
}

function upcomingOrders(config, count = 5) {
  const now = new Date();
  const out = [];
  for (let d = 0; d < 14 && out.length < count; d++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const day = JS_DAY_TO_KEY[date.getDay()];
    for (const order of config.schedule.filter((o) => o.day === day)) {
      const [h, m] = order.time.split(':').map(Number);
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
      if (at.getTime() - config.orderLeadMinutes * 60000 > now.getTime()) out.push({ at, order });
      if (out.length >= count) break;
    }
  }
  return out;
}

async function launch() {
  const config = buildConfig();
  const btn = $('#next');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let savedToServer = false;
  try {
    const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    savedToServer = res.ok;
  } catch { /* no server, e.g. page opened from file:// */ }
  btn.disabled = false;
  saveDraft();

  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const addrLabel = (id) => config.addresses.find((a) => a.id === id)?.label ?? '';
  $('#upcoming').innerHTML = upcomingOrders(config).map(({ at, order }) => `
    <li><span class="when">${dateFmt.format(at)} · ${fmtTime(order.time)}</span>
    <span class="meta">${esc(order.meal)} to ${esc(addrLabel(order.addressId))} · up to ${money(config.derived.perOrderBudget)} · ordered ${fmtTime(order.orderAt)}</span></li>`).join('');
  $('#doneMsg').textContent = savedToServer
    ? 'Plan saved. Your agent can start ordering from the dashboard.'
    : "Couldn't reach the local server, so the plan is only saved in this browser. Run `npm run ui` and launch again so the agent can read it.";
  $('#openDashboard').hidden = !savedToServer;
  $('#jsonOut').textContent = JSON.stringify(config, null, 2);
  current = STEPS.length;
  render();
}

// ---------- events ----------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const stepId = STEPS[current]?.id;
  if (!stepId) return;
  const err = validate(stepId);
  showError(err);
  if (err) return;
  if (stepId === 'review') { launch(); return; }
  current += 1;
  furthest = Math.max(furthest, current);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#back').addEventListener('click', () => { showError(null); current = Math.max(0, current - 1); render(); });
$('#editPlan').addEventListener('click', () => { current = STEPS.length - 1; render(); });

$('#addAddress').addEventListener('click', () => {
  if (state.addresses.length >= MAX_ADDRESSES) return;
  const used = state.addresses.map((a) => a.label);
  state.addresses.push(newAddress(ADDRESS_NAMES.find((n) => !used.includes(n)) || `Address ${state.addresses.length + 1}`));
  showError(null);
  renderAddresses();
  saveDraft();
  $(`[data-addr="${state.addresses.length - 1}"][data-key="street"]`).focus();
});

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go && !go.disabled) { showError(null); current = +go.dataset.goto; render(); return; }

  const period = e.target.closest('[data-period]');
  if (period) {
    // Convert the amount so switching period keeps the same real budget.
    const perOrder = perOrderBudget();
    const p = period.dataset.period;
    const factor = { meal: 1, day: state.meals.length, week: ordersPerWeek() || state.meals.length }[p];
    state.budget.period = p;
    state.budget.amount = Math.round(perOrder * factor);
    renderBudget();
  }

  const dayBtn = e.target.closest('[data-day]');
  if (dayBtn) {
    const k = dayBtn.dataset.day;
    state.days = state.days.includes(k) ? state.days.filter((d) => d !== k) : [...state.days, k];
    renderDays();
  }
  const daysPreset = e.target.closest('[data-days]');
  if (daysPreset) {
    state.days = { weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], weekends: ['sat', 'sun'], all: DAYS.map(([k]) => k) }[daysPreset.dataset.days];
    renderDays();
  }

  const prefChip = e.target.closest('[data-pref-chip]');
  if (prefChip) {
    const key = prefChip.closest('#dietChips') ? 'dietary' : 'cuisines';
    const value = prefChip.dataset.prefChip;
    const list = state.prefs[key];
    state.prefs[key] = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
    showError(null);
    renderPrefs();
  }

  const drop = e.target.closest('[data-addr-dropoff]');
  if (drop) {
    state.addresses[+drop.dataset.addrDropoff].dropoff = drop.dataset.value;
    $$(`[data-addr-dropoff="${drop.dataset.addrDropoff}"]`).forEach((b) => b.setAttribute('aria-pressed', String(b === drop)));
  }

  const remove = e.target.closest('[data-remove-addr]');
  if (remove) {
    const [gone] = state.addresses.splice(+remove.dataset.removeAddr, 1);
    Object.keys(state.assignments).forEach((k) => { if (state.assignments[k] === gone.id) delete state.assignments[k]; });
    showError(null);
    renderAddresses();
  }
  saveDraft();
});

function setMealCount(n) {
  n = Math.min(MAX_MEALS, Math.max(MIN_MEALS, n));
  // Existing meals (and their edits) are kept; new ones come from MEAL_SEQUENCE.
  state.meals = Array.from({ length: n }, (_, i) =>
    state.meals[i] || { id: uid(), name: MEAL_SEQUENCE[i][0], time: MEAL_SEQUENCE[i][1] });
  renderMeals();
  saveDraft();
}
$('#mealsMinus').addEventListener('click', () => setMealCount(state.meals.length - 1));
$('#mealsPlus').addEventListener('click', () => setMealCount(state.meals.length + 1));

function setTip(pct) {
  state.budget.tipPercent = Math.min(TIP_MAX, Math.max(0, pct));
  renderBudget();
  saveDraft();
}
$('#tipMinus').addEventListener('click', () => setTip(state.budget.tipPercent - TIP_STEP));
$('#tipPlus').addEventListener('click', () => setTip(state.budget.tipPercent + TIP_STEP));

form.addEventListener('input', (e) => {
  const t = e.target;
  t.classList.remove('invalid');
  showError(null);
  if (['protein', 'carbs', 'fat'].includes(t.name)) { state.macros[t.name] = t.value === '' ? '' : +t.value; renderMacros(); }
  else if (t.dataset.meal !== undefined) {
    state.meals[+t.dataset.meal][t.dataset.key] = t.value;
  }
  else if (t.dataset.addr !== undefined) {
    state.addresses[+t.dataset.addr][t.dataset.key] = t.value;
    if (t.dataset.key === 'label') renderAssignments();
  }
  else if (t.dataset.assign) {
    state.assignments[t.dataset.assign] = t.value;
    t.style.setProperty('--addr', addressColor(t.value));
  }
  else if (t.name === 'avoid') state.prefs.avoid = t.value;
  else if (t.name === 'searchQuery') {
    // Once they type their own query, stop overwriting it from the chips.
    state.prefs.searchQuery = t.value;
    state.prefs.searchQueryEdited = true;
  }
  else if (t.name === 'budget') { state.budget.amount = t.value === '' ? '' : +t.value; renderBudget(); }
  else if (t.id === 'budgetRange') { state.budget.amount = +t.value; renderBudget(); }
  else if (t.name === 'includesFees') { state.budget.includesFeesAndTip = t.checked; renderBudget(); }
  saveDraft();
});

render();
