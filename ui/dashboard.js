// MacroMe dashboard: starts an agent run, embeds its live browser view, and
// collects the order approval the agent is blocking on.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;
const POLL_MS = 1500;

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
      <div><dt>Looking for</dt><dd>${esc(preferences?.searchQuery || 'healthy')}</dd></div>
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
  const res = await fetch('/api/config');
  if (!res.ok) { window.location.href = '/setup'; return; }
  plan = await res.json();
  renderPlan();
  await poll();
  setInterval(poll, POLL_MS);
})();
