import { mkdirSync, writeFileSync } from "fs";
import type { MealMacros, PickedMeal } from "./types.js";

export interface RunReport {
  mealName: string;
  target: MealMacros;
  storesScraped: { name: string; itemCount: number }[];
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  candidates: PickedMeal[]; // ranked, best first
  chosenItemId: string | null;
  skipped: { item: string; reason: string; details?: unknown }[];
  addAttempts?: unknown[];
  checkoutRecovery?: unknown;
  checkoutTotal: string | null;
  approved: boolean | null;
  timestamp: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function macroRow(label: string, m: MealMacros): string {
  return `<tr><td>${esc(label)}</td><td>${m.calories} kcal</td><td>${m.protein}g protein</td><td>${m.carbs}g carbs</td><td>${m.fat}g fat</td></tr>`;
}

function candidateCard(c: PickedMeal, rank: number, isChosen: boolean): string {
  const sourceBadge = c.source === "usda"
    ? `<span class="badge badge-usda">USDA verified</span>`
    : `<span class="badge badge-estimated">LLM estimate</span>`;
  const consistencyBadge = c.macroConsistent
    ? ""
    : `<span class="badge badge-warn">macros don't add up to stated calories</span>`;
  return `
    <div class="card${isChosen ? " chosen" : ""}">
      <h3>#${rank} ${esc(c.item)} ${isChosen ? "&mdash; ADDED TO CART" : ""}</h3>
      <p class="meta">${esc(c.restaurant)} &middot; $${c.price.toFixed(2)} &middot; score ${c.score.toFixed(3)} (lower is better)</p>
      <p>${sourceBadge} ${consistencyBadge}</p>
      <table class="macros">${macroRow("Estimated/verified", c.estimatedMacros)}</table>
      <p>${esc((c.selectedOptions ?? c.components?.flatMap(c => c.selectedOptions ?? []) ?? []).join(", "))}</p>
      <p class="reasoning">"${esc(c.reasoning)}"</p>
    </div>`;
}

export function writeReport(run: RunReport): string {
  const chosen = run.candidates.find((c) => (c.selectionId ?? c.itemId) === run.chosenItemId);
  const others = run.candidates.filter((c) => (c.selectionId ?? c.itemId) !== run.chosenItemId);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(run.mealName)} decision report — ${esc(run.timestamp)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  table.macros { border-collapse: collapse; margin: 0.5rem 0; font-size: 0.9rem; }
  table.macros td { padding: 2px 10px 2px 0; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin: 0.75rem 0; background: white; }
  .card.chosen { border-color: #2a8a3e; border-width: 2px; background: #f2fbf3; }
  .meta { color: #555; font-size: 0.85rem; margin: 0.2rem 0; }
  .reasoning { font-style: italic; color: #333; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; margin-right: 6px; }
  .badge-usda { background: #d7f0da; color: #175c26; }
  .badge-estimated { background: #eee; color: #555; }
  .badge-warn { background: #fbe6c8; color: #8a4b00; }
  ul.skipped li { margin: 0.2rem 0; }
  details { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; margin-top: 0.5rem; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; background: #f4f4f4; padding: 0.75rem; border-radius: 6px; }
  .status { font-weight: 600; }
</style>
</head>
<body>
  <h1>${esc(run.mealName)} — decision report</h1>
  <p class="meta">${esc(run.timestamp)} &middot; stores scraped: ${run.storesScraped.map((s) => `${esc(s.name)} (${s.itemCount} items)`).join(", ") || "none"}</p>

  <h2>Macro target for this meal</h2>
  <table class="macros">${macroRow("Target", run.target)}</table>

  <h2>Final pick</h2>
  ${chosen ? candidateCard(chosen, run.candidates.indexOf(chosen) + 1, true) : "<p>No item was successfully added to the cart.</p>"}

  ${others.length ? `<h2>Other candidates considered</h2>${others.map((c) => candidateCard(c, run.candidates.indexOf(c) + 1, false)).join("")}` : ""}

  ${run.skipped.length ? `<h2>Items that couldn't be added to cart</h2><ul class="skipped">${run.skipped.map((s) => `<li><strong>${esc(s.item)}</strong>: ${esc(s.reason)}</li>`).join("")}</ul>` : ""}

  <h2>Checkout</h2>
  <p class="status">
    ${run.checkoutTotal ? `Total: ${esc(run.checkoutTotal)} &middot; ` : ""}
    ${run.approved === null ? "Not reached / not yet decided" : run.approved ? "Order placed" : "Declined — item left in cart"}
  </p>

  <details><summary>Cart and option evidence</summary><pre>${esc(JSON.stringify({ adds: run.addAttempts, recovery: run.checkoutRecovery, failures: run.skipped }, null, 2))}</pre></details>
  <h2>Raw model prompt and response</h2>
  <details>
    <summary>System prompt</summary>
    <pre>${esc(run.systemPrompt)}</pre>
  </details>
  <details>
    <summary>User prompt (scraped menu sent to the model)</summary>
    <pre>${esc(run.userPrompt)}</pre>
  </details>
  <details open>
    <summary>Raw model response</summary>
    <pre>${esc(run.rawResponse)}</pre>
  </details>
</body>
</html>`;

  mkdirSync("reports", { recursive: true });
  const safeMeal = run.mealName.replace(/[^a-z0-9]+/gi, "-");
  const path = `reports/${run.timestamp.replace(/[:.]/g, "-")}-${safeMeal}.html`;
  writeFileSync(path, html);
  writeFileSync(path.replace(/\.html$/, ".json"), JSON.stringify(run, null, 2));
  return path;
}
