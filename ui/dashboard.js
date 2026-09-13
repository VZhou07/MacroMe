// MacroMe dashboard: starts an agent run, embeds its live browser view, and
// collects the order approval the agent is blocking on.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;
const JS_DAY_TO_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const POLL_MS = 1500;

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

let plan = null;
let lastStatus = null;
let liveUrlShown = null;

function showError(msg) {
  $('#error').textContent = msg || '';
  $('#error').hidden = !msg;
}

// ---------- plan ----------
function renderPlan() {
  const { macros, derived, preferences, addresses, days, meals } = plan;
  $('#railPlan').innerHTML = `
    <dl class="rail-stats">
      <div><dt>Daily macros</dt><dd>${macros.calories} kcal · ${macros.protein}P / ${macros.carbs}C / ${macros.fat}F</dd></div>
      <div><dt>Per meal</dt><dd>${derived.perMealMacros.calories} kcal · up to ${money(derived.perOrderBudget)}${plan.budget.includesFeesAndTip ? ' all-in' : ' of food'}</dd></div>
      <div><dt>Schedule</dt><dd>${meals.length} meals · ${days.length} days · ${derived.ordersPerWeek} orders/week</dd></div>
      <div><dt>Looking for</dt><dd>${esc(preferences?.searchQuery || 'healthy')}</dd></div>
      ${preferences?.dietary?.length ? `<div><dt>Must be</dt><dd>${esc(preferences.dietary.join(', '))}</dd></div>` : ''}
      <div><dt>Deliver to</dt><dd>${addresses.map((a) => esc(a.label)).join(', ')}</dd></div>
    </dl>`;

  $('#mealPick').innerHTML = meals
    .map((m) => `<option value="${esc(m.name)}">${esc(m.name)} · eat ${fmtTime(m.time)}</option>`).join('');

  const addrLabel = (id) => plan.addresses.find((a) => a.id === id)?.label ?? '';
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const now = new Date();
  const out = [];
  for (let d = 0; d < 14 && out.length < 5; d++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const day = JS_DAY_TO_KEY[date.getDay()];
    for (const order of plan.schedule.filter((o) => o.day === day)) {
      const [h, m] = order.time.split(':').map(Number);
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
      if (at.getTime() - plan.orderLeadMinutes * 60000 > now.getTime()) out.push({ at, order });
      if (out.length >= 5) break;
    }
  }
  $('#upcoming').innerHTML = out.map(({ at, order }) => `
    <li><span class="when">${dateFmt.format(at)} · ${fmtTime(order.time)}</span>
    <span class="meta">${esc(order.meal)} to ${esc(addrLabel(order.addressId))} · ordered ${fmtTime(order.orderAt || order.time)}</span></li>`).join('')
    || '<li><span class="meta">Nothing scheduled in the next two weeks.</span></li>';
}

// ---------- run ----------
const BUSY = ['starting', 'running', 'awaiting-approval', 'placing'];

const STATUS_TEXT = {
  starting: 'Starting the browser…',
  running: 'Working…',
  'awaiting-approval': 'Waiting for you to approve the order',
  placing: 'Placing the order…',
  done: 'Finished',
  error: 'Something went wrong',
  cancelled: 'Stopped',
};

function renderRun(state) {
  const busy = BUSY.includes(state.status);
  $('#runNow').disabled = busy;
  $('#mealPick').disabled = busy;
  $('#stopRun').hidden = !busy;
  $('#statusStrip').hidden = state.status === 'idle';
  $('#statusDot').className = `pulse ${busy ? 'live' : state.status === 'error' ? 'bad' : 'done'}`;

  // Prefer the agent's own status messages — raw stdout is too noisy to show here.
  $('#statusText').textContent = state.status === 'running' && state.statusMessage
    ? state.statusMessage
    : (STATUS_TEXT[state.status] || state.status);

  if (state.status !== 'idle') {
    $('#dashTitle').textContent = busy ? `Ordering ${state.meal || 'your meal'}…` : 'Your agent is ready.';
    $('#dashSub').textContent = busy
      ? 'Follow along in the live browser below.'
      : 'Pick a meal and it will order it on DoorDash for you.';
  }

  // Live view — only reset the src when the URL actually changes, or the iframe
  // would reload on every poll and flicker.
  if (state.liveViewUrl && state.liveViewUrl !== liveUrlShown) {
    liveUrlShown = state.liveViewUrl;
    $('#viewerFrame').innerHTML =
      `<iframe src="${esc(state.liveViewUrl)}" title="The agent's live browser session" allow="clipboard-read; clipboard-write"></iframe>`;
    // Link out to the Steel dashboard page, which can't be framed.
    $('#popOut').href = state.dashboardUrl || state.liveViewUrl;
    $('#popOut').hidden = false;
  }

  // Approval
  const a = state.approval;
  $('#approval').hidden = !a;
  if (a) {
    const m = a.macros || {};
    $('#approvalBody').innerHTML = `
      <div class="approval-item">
        <b>${esc(a.item)}</b>
        <span class="meta">${esc(a.restaurant)} · ${money(a.price)}</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${m.calories ?? '—'}</b>kcal</div>
        <div class="stat"><b>${m.protein ?? '—'}g</b>protein</div>
        <div class="stat"><b>${m.carbs ?? '—'}g</b>carbs</div>
        <div class="stat"><b>${m.fat ?? '—'}g</b>fat</div>
      </div>
      <p class="approval-total">Checkout total <b>${esc(a.checkoutTotal || '—')}</b> <span class="meta">(everything in the cart, including fees)</span></p>
      <p class="review-sub">${esc(a.reasoning || '')}</p>`;
  }

  // Outcome
  const done = state.result || state.error;
  $('#result').hidden = !done;
  if (done) {
    $('#result').className = `card result ${state.error ? 'bad' : state.result.placed ? 'good' : ''}`;
    $('#result').innerHTML = state.error
      ? `<h3>The run stopped</h3><p class="review-sub">${esc(state.error)}</p>`
      : `<h3>${state.result.placed ? 'Order placed' : 'No order placed'}</h3><p class="review-sub">${esc(state.result.message)}</p>`;
  }

  if (state.log) {
    $('#logOut').textContent = state.log.map((l) => l.line).join('\n');
    if (state.status !== lastStatus) $('#logOut').scrollTop = $('#logOut').scrollHeight;
  }
  lastStatus = state.status;
}

async function poll() {
  try {
    const state = await (await fetch('/api/run')).json();
    renderRun(state);
  } catch { /* server restarting; the next tick picks it back up */ }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}

$('#runNow').addEventListener('click', async () => {
  showError(null);
  $('#runNow').disabled = true;
  liveUrlShown = null;
  $('#result').hidden = true;
  try {
    renderRun(await post('/api/run', { meal: $('#mealPick').value }));
  } catch (err) {
    showError(err.message);
    $('#runNow').disabled = false;
  }
});

$('#stopRun').addEventListener('click', () => post('/api/run/stop').catch((e) => showError(e.message)));
$('#approve').addEventListener('click', () => decide(true));
$('#reject').addEventListener('click', () => decide(false));

async function decide(approve) {
  $('#approve').disabled = $('#reject').disabled = true;
  try {
    await post('/api/run/approve', { approve });
    $('#approval').hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    $('#approve').disabled = $('#reject').disabled = false;
  }
}

(async function init() {
  const res = await fetch('/api/config');
  if (!res.ok) { window.location.href = '/setup'; return; }
  plan = await res.json();
  renderPlan();
  await poll();
  setInterval(poll, POLL_MS);
})();
