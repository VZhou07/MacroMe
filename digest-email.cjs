// Optional: mail the end-of-day digest.
//
// Off unless both RESEND_API_KEY and DIGEST_EMAIL are set, and it never throws
// — the digest is already saved to disk and shown on the dashboard by the time
// this runs, so a mail outage must not look like a failed day.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;

const STATUS_LABEL = { placed: 'Ordered', declined: 'Declined', failed: 'Failed', missed: 'Missed' };

function configured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.DIGEST_EMAIL);
}

function mealLine(meal) {
  const what = meal.item ? `${meal.item}${meal.restaurant ? ` (${meal.restaurant})` : ''}` : meal.note || '—';
  const total = meal.checkoutTotal ? ` — ${meal.checkoutTotal}` : '';
  return `${meal.meal}: ${STATUS_LABEL[meal.status] || meal.status} — ${what}${total}`;
}

function renderText(digest) {
  const macros = ['calories', 'protein', 'carbs', 'fat']
    .map((key) => `${key}: ${digest.totals[key]} of ${digest.targets[key]}`).join('\n  ');
  return [
    `MacroMe — ${digest.date}`,
    '',
    digest.summary,
    '',
    'Macros (from the agent pick in each placed order)',
    `  ${macros}`,
    '',
    'Meals',
    ...digest.meals.map((meal) => `  ${mealLine(meal)}`),
    '',
    digest.spend.orders ? `Spent: ${digest.spend.currency}${digest.spend.amount.toFixed(2)} across ${digest.spend.orders} order(s).` : 'Nothing was charged today.',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(digest) {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#1E2B22">
  <h1 style="font-size:20px;margin:0 0 4px">MacroMe — ${escapeHtml(digest.date)}</h1>
  <p style="color:#687064;margin:0 0 18px">${escapeHtml(digest.summary)}</p>
  <ul style="padding-left:18px;margin:0 0 18px">${digest.meals.map((meal) => `<li>${escapeHtml(mealLine(meal))}</li>`).join('')}</ul>
  <p style="color:#687064;font-size:13px">Macro totals cover the agent pick in each placed order, not every line in the cart.</p>
</div>`;
}

/** Fire-and-forget: always resolves, and says why when it didn't send. */
async function sendDigest(digest, options = {}) {
  const to = options.to || process.env.DIGEST_EMAIL;
  const key = options.apiKey || process.env.RESEND_API_KEY;
  if (!to || !key) return { sent: false, reason: 'DIGEST_EMAIL and RESEND_API_KEY are not both set' };
  try {
    const response = await fetch(options.endpoint || RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MACROME_EMAIL_FROM || 'MacroMe <onboarding@resend.dev>',
        to: to.split(',').map((address) => address.trim()).filter(Boolean),
        subject: `MacroMe — ${digest.date}: ${digest.summary}`,
        text: renderText(digest),
        html: renderHtml(digest),
      }),
      signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { sent: false, reason: body.message || `Resend replied ${response.status}` };
    return { sent: true, id: body.id || null };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = { configured, sendDigest, renderText, renderHtml };
