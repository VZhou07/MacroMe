// MacroMe dashboard: starts an agent run, embeds its live browser view, collects
// the order approval the agent is blocking on, and shows what the day added up
// to — today so far, the saved end-of-day digests, and a nudge whenever the
// server finishes something while you were looking elsewhere.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const error = new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const POLL_MS = 1500;
// Digests move once a day; only the live run needs a 1.5s heartbeat.
const DIGEST_POLL_MS = 20000;
const TOAST_MS = 12000;

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

let plan = null;
let lastStatus = null;
let latest = null;      // most recent /api/run payload, for the Reconnect button
let viewerKey = null;   // what the viewer currently shows, so polling doesn't remount it
let decisionPending = false;

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
      <div><dt>Looking for</dt><dd>${esc(preferences?.searchQuery || 'No search filter')}</dd></div>
      ${preferences?.dietary?.length ? `<div><dt>Must be</dt><dd>${esc(preferences.dietary.join(', '))}</dd></div>` : ''}
      <div><dt>Deliver to</dt><dd>${addresses.map((a) => esc(a.label)).join(', ')}</dd></div>
    </dl>`;

}

function renderUpcoming(orders) {
  const addrLabel = (id) => plan.addresses.find((a) => a.id === id)?.label ?? '';
  const dateFmt = new Intl.DateTimeFormat(undefined, { timeZone: plan.timezone || 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeZone: plan.timezone || 'UTC', hour: 'numeric', minute: '2-digit' });
  $('#nextOrderLabel').textContent = orders[0] ? `Next: ${orders[0].meal} · ${dateFmt.format(new Date(orders[0].eatAt))}` : 'No upcoming orders';
  $('#upcoming').innerHTML = orders.map((order) => `
    <li><span class="when">${dateFmt.format(new Date(order.eatAt))} · ${fmtTime(order.time)}</span>
    <span class="meta">${esc(order.meal)} to ${esc(addrLabel(order.addressId))} · order at ${timeFmt.format(new Date(order.orderAt))}</span></li>`).join('')
    || '<li><span class="meta">Nothing scheduled in the next two weeks.</span></li>';
}

// ---------- live browser ----------
const BUSY = ['starting', 'running', 'awaiting-approval', 'placing'];
const ENDED = ['done', 'error', 'cancelled'];

// Steel streams the live session over WebRTC, and that stream can drop while the
// session itself is still healthy — the agent opening and closing a tab per
// restaurant is enough to do it. The frame then sits on "Browser Disconnected"
// until it is remounted, so reloading the iframe is the reconnect.
function mountViewer(url) {
  // The timestamp defeats the cache; without it the browser restores the same
  // dead frame and the reconnect does nothing.
  const src = `${url}${url.includes('?') ? '&' : '?'}interactive=true&t=${Date.now()}`;
  $('#viewerFrame').innerHTML =
    `<iframe src="${esc(src)}" title="The agent's live browser session" allow="clipboard-read; clipboard-write"></iframe>`;
}

function showViewerEnded(state) {
  const link = state.dashboardUrl
    ? ` <a href="${esc(state.dashboardUrl)}" target="_blank" rel="noopener">Watch the recording</a>.`
    : '';
  $('#viewerFrame').innerHTML =
    `<p class="viewer-empty">The agent's browser session has ended.${link}</p>`;
}

function renderViewer(state) {
  const ended = ENDED.includes(state.status);
  // Remount on a new session, and again when the run reaches the approval step
  // so a stream that dropped mid-scrape can't hide the cart you're approving.
  const key = !state.liveViewUrl ? 'empty'
    : ended ? 'ended'
    : `live:${state.liveViewUrl}:${state.status === 'awaiting-approval'}`;

  $('#reconnect').hidden = !state.liveViewUrl || ended;
  $('#popOut').hidden = !state.liveViewUrl;
  if (state.liveViewUrl) $('#popOut').href = state.dashboardUrl || state.liveViewUrl;

  if (key === viewerKey) return;
  viewerKey = key;
  if (key === 'empty') return;              // keep the "appears here once a run starts" placeholder
  if (key === 'ended') return showViewerEnded(state);
  mountViewer(state.liveViewUrl);
}

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
  latest = state;
  const busy = BUSY.includes(state.status);
  $('#runNow').disabled = busy || !state.upcoming?.length;
  if (state.upcoming) renderUpcoming(state.upcoming);
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
      : 'Run now orders the next scheduled meal. Completed orders leave the queue.';
  }

  renderViewer(state);

  // Approval
  const a = state.approval;
  $('#approval').hidden = !a;
  if (a) {
    const m = a.macros || {};
    const items = Array.isArray(a.cartItems) ? a.cartItems : [];
    $('#approve').disabled = decisionPending || !items.length || !a.checkoutTotal || state.status !== 'awaiting-approval';
    $('#reject').disabled = decisionPending || state.status !== 'awaiting-approval';
    $('#approvalBody').innerHTML = `
      <h4>Entire DoorDash cart</h4>
      ${items.length ? `<ul class="approval-cart">${items.map((item) => `
        <li>
          <div class="cart-line"><b>${esc(item.quantity)} × ${esc(item.name)}</b><span>${esc(item.linePrice)}</span></div>
          ${(item.modifiers || []).length ? `<p class="review-sub">${item.modifiers.map(esc).join(' · ')}</p>` : ''}
        </li>`).join('')}</ul>` : '<p>Cart details are unavailable. Start a new run to review the full cart before ordering.</p>'}
      <p class="approval-total">Checkout total <b>${esc(a.checkoutTotal || '—')}</b></p>
      <p class="review-sub">Place order charges the entire cart above, including DoorDash’s fees and tip in this total.</p>
      <div class="approval-item">
        <h4>Agent pick</h4>
        <b>${esc(a.item)}</b>
        <span class="meta">${esc(a.restaurant)} · ${money(a.price)}</span>
        <span class="meta">Macros below are for the agent pick only.</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${m.calories ?? '—'}</b>kcal</div>
        <div class="stat"><b>${m.protein ?? '—'}g</b>protein</div>
        <div class="stat"><b>${m.carbs ?? '—'}g</b>carbs</div>
        <div class="stat"><b>${m.fat ?? '—'}g</b>fat</div>
      </div>
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

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const state = await getJson('/api/run');
    renderRun(state);
    handleNotifications(state);
  } catch (err) {
    $('#nextOrderLabel').textContent = `Unable to load orders: ${err.message}. Retrying…`;
  } finally { polling = false; }
}

// ---------- notifications ----------
const seenNotifications = new Set();
let primed = false;
// The server restarts with a fresh numbering, so old ids must not mask new ones.
let notificationBoot = null;
const SEEN_KEY = 'macrome-seen-notifications';

function loadSeen(boot) {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    return raw.boot === boot && Array.isArray(raw.ids) ? raw.ids : [];
  } catch { return []; }
}

function saveSeen(boot) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ boot, ids: [...seenNotifications].slice(-100) }));
  } catch { /* storage unavailable */ }
}

const TOAST_TONE = { digest: 'digest', 'digest-email': 'digest', missed: 'missed', 'run-error': 'bad', 'order-skipped': 'missed' };
const REFRESHES_DIGEST = ['digest', 'order-placed', 'order-skipped', 'missed', 'run-error'];

function handleNotifications(state) {
  if (!Array.isArray(state.notifications)) return;
  if (state.boot !== notificationBoot) {
    notificationBoot = state.boot;
    seenNotifications.clear();
    for (const id of loadSeen(state.boot)) seenNotifications.add(id);
    primed = false;
  }
  const fresh = [];
  for (const note of state.notifications) {
    if (seenNotifications.has(note.id)) continue;
    seenNotifications.add(note.id);
    // First poll after open/refresh: ingest the backlog silently so old toasts
    // (e.g. payment errors) do not reappear every reload.
    if (!primed) continue;
    fresh.push(note);
  }
  primed = true;
  saveSeen(notificationBoot);
  for (const note of fresh.slice(-3)) showToast(note);
  if (fresh.some((note) => REFRESHES_DIGEST.includes(note.kind))) loadDigests();
}

function showToast(note) {
  const toast = document.createElement('div');
  toast.className = `toast ${TOAST_TONE[note.kind] || ''}`;
  toast.innerHTML = `<button type="button" aria-label="Dismiss">&times;</button>
    <b>${esc(note.title)}</b>${note.body ? `<p>${esc(note.body)}</p>` : ''}`;
  toast.querySelector('button').addEventListener('click', () => {
    seenNotifications.add(note.id);
    saveSeen(notificationBoot);
    toast.remove();
  });
  $('#toasts').appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_MS);
  desktopNotify(note);
}

// Same message again as an OS notification, for when this tab isn't in front.
function desktopNotify(note) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(`MacroMe · ${note.title}`, { body: note.body || '', tag: note.id });
  } catch { /* some browsers only allow these from a service worker */ }
}

function renderAlertsButton() {
  const button = $('#alerts');
  if (!('Notification' in window)) { button.hidden = true; return; }
  button.textContent = { granted: 'Desktop alerts on', denied: 'Desktop alerts blocked' }[Notification.permission] || 'Desktop alerts';
  button.disabled = Notification.permission !== 'default';
}

// ---------- today, and the days before it ----------
const MACROS = [
  { key: 'calories', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g', dot: 'protein' },
  { key: 'carbs', label: 'Carbs', unit: 'g', dot: 'carbs' },
  { key: 'fat', label: 'Fat', unit: 'g', dot: 'fat' },
];
const STATUS_LABEL = { placed: 'Ordered', declined: 'Declined', failed: 'Failed', missed: 'Missed' };
const num = (value) => new Intl.NumberFormat().format(Math.round(Number(value) || 0));

// A date key is a plain calendar day, so read it back in UTC — anything else
// shifts it by a timezone it was never in.
function fmtDateKey(date, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * One ratio against one limit, so each macro is its own meter in a single hue.
 * The label and the value carry which macro it is; the fill only says how far
 * along the day is, and turns over-budget red once it passes the target.
 */
function meter(macro, totals, targets) {
  const value = Number(totals?.[macro.key]) || 0;
  const target = Number(targets?.[macro.key]) || 0;
  const percent = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  const over = target > 0 && value > target;
  return `<div class="meter${over ? ' over' : ''}">
    <span class="meter-label">${macro.dot ? `<i class="dot ${macro.dot}" aria-hidden="true"></i>` : ''}${macro.label}</span>
    <span class="meter-value">${num(value)} of ${num(target)} ${macro.unit}${over ? ` · ${num(value - target)} over` : ''}</span>
    <div class="meter-track" role="progressbar" aria-label="${macro.label}"
         aria-valuenow="${Math.round(value)}" aria-valuemin="0" aria-valuemax="${Math.round(target)}">
      <div class="meter-fill" style="width: ${percent}%"></div>
    </div>
  </div>`;
}

function mealRows(digest) {
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeZone: digest.timezone || 'UTC', hour: 'numeric', minute: '2-digit' });
  return digest.meals.map((meal) => {
    const detail = [
      meal.eatAt ? timeFmt.format(new Date(meal.eatAt)) : null,
      meal.restaurant,
      meal.macros ? `${num(meal.macros.calories)} kcal · ${num(meal.macros.protein)}g protein` : null,
      // The pill already says "Ordered"; a note only earns its place when it
      // explains why something didn't happen.
      meal.status === 'placed' ? null : meal.note,
    ].filter(Boolean).join(' · ');
    return `<li>
      <span class="pill ${meal.status}">${STATUS_LABEL[meal.status] || meal.status}</span>
      <span class="what">${esc(meal.meal)}${meal.item ? ` — ${esc(meal.item)}` : ''}</span>
      <span class="total">${esc(meal.checkoutTotal || '')}</span>
      ${detail ? `<p class="why">${esc(detail)}</p>` : ''}
    </li>`;
  }).join('');
}

let canFinalize = false;
let finalizing = false;

function renderDigests(payload) {
  const digest = payload.today;
  $('#todayTitle').textContent = `Today · ${fmtDateKey(payload.date)}`;
  $('#todaySummary').textContent = digest.meals.length
    ? digest.summary
    : 'Nothing has run today yet.';
  $('#todayTag').className = `tag${payload.final ? ' final' : ''}`;
  $('#todayTag').textContent = payload.final ? 'Final' : `Live · digest at ${fmtTime(payload.digestTime)}`;
  $('#todayMeters').innerHTML = MACROS.map((macro) => meter(macro, digest.totals, digest.targets)).join('');
  $('#todayMeals').innerHTML = mealRows(digest);
  $('#todayEmpty').hidden = digest.meals.length > 0;
  canFinalize = !payload.final && digest.meals.length > 0;
  const summarise = $('#summarise');
  // Once Final exists, hide the action — a disabled lookalike with no click feedback was confusing.
  summarise.hidden = Boolean(payload.final);
  summarise.disabled = finalizing || !canFinalize;
  if (!finalizing) summarise.textContent = "Save today’s digest (finalize)";
  const help = payload.final
    ? 'Final digest saved for today. It was written at end of day (or earlier) and will not change.'
    : digest.meals.length
      ? 'Live preview — not saved yet. A Final digest is written automatically when due. You can also save one early.'
      : 'Live preview — nothing logged yet, so there is no digest to save. A Final is written automatically when due if a meal outcome is logged.';
  $('#finalizeHelp').textContent = help;
  summarise.title = canFinalize
    ? 'Save today’s digest as Final now'
    : payload.final
      ? 'Already saved as Final'
      : 'Nothing to save until a meal is logged';
  summarise.setAttribute('aria-label', summarise.title);

  $('#historyCard').hidden = !payload.history.length;
  $('#history').innerHTML = payload.history.map((day) => `
    <li><details>
      <summary><b>${fmtDateKey(day.date)}</b><span>${esc(day.summary)}</span></summary>
      <ul class="day-meals">${mealRows(day)}</ul>
    </details></li>`).join('');
}

let loadingDigests = false;
async function loadDigests() {
  if (loadingDigests) return;
  loadingDigests = true;
  try {
    renderDigests(await getJson('/api/digests'));
  } catch (err) {
    $('#todaySummary').textContent = `Unable to load summary: ${err.message}. Retrying…`;
  } finally { loadingDigests = false; }
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
  viewerKey = null;
  $('#result').hidden = true;
  try {
    renderRun(await post('/api/run'));
  } catch (err) {
    showError(err.message);
    $('#runNow').disabled = false;
  }
});

$('#reconnect').addEventListener('click', () => {
  if (!latest?.liveViewUrl) return;
  viewerKey = `live:${latest.liveViewUrl}:manual:${Date.now()}`;
  mountViewer(latest.liveViewUrl);
});

$('#stopRun').addEventListener('click', () => post('/api/run/stop').catch((e) => showError(e.message)));

$('#alerts').addEventListener('click', async () => {
  // Browsers only grant this from a click, which is why it is a button.
  await Notification.requestPermission();
  renderAlertsButton();
});

$('#summarise').addEventListener('click', async () => {
  if (finalizing) return;
  if (!canFinalize) {
    showError($('#summarise').title || $('#finalizeHelp').textContent);
    return;
  }
  finalizing = true;
  const btn = $('#summarise');
  const previous = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await post('/api/digests');
    await loadDigests();
  } catch (err) {
    showError(err.message);
    btn.textContent = previous;
    btn.disabled = !canFinalize;
  } finally {
    finalizing = false;
  }
});
$('#approve').addEventListener('click', () => decide(true));
$('#reject').addEventListener('click', () => decide(false));

async function decide(approve) {
  decisionPending = true;
  $('#approve').disabled = $('#reject').disabled = true;
  try {
    await post('/api/run/approve', { approve });
    $('#approval').hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    decisionPending = false;
    await poll();
  }
}

(async function init() {
  try {
    plan = await getJson('/api/config');
    renderPlan();
    renderAlertsButton();
  } catch (err) {
    if (err.status === 404) { window.location.href = '/setup'; return; }
    showError(`Unable to load your plan: ${err.message}. Retrying…`);
    setTimeout(init, 5000);
    return;
  }
  showError(null);
  poll();
  loadDigests();
  setInterval(poll, POLL_MS);
  setInterval(loadDigests, DIGEST_POLL_MS);
})();
