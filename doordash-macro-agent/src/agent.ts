import "dotenv/config";
import { pathToFileURL } from "url";
import { chromium, type Browser } from "playwright-core";
import Steel from "steel-sdk";
import { createSession } from "./session.js";
import { assertConnected, bounded, BrowserUnavailableError, closePage, PageWorkError, whileSessionLive, withStorePage } from "./browser-work.js";
import { loadPlan } from "./plan.js";
import { addItemToCart, demoPlaceEnabled, findStores, placeOrder, scrapeMenu } from "./doordash.js";
import { pickMeals } from "./macro-picker.js";
import { fallbackPicks, syntheticRecommendation } from "./fallback-picks.js";
import { printCartSummary, printOrderSummary, promptApproval } from "./notifier.js";
import { printLiveView, liveViewUrl, dashboardUrl } from "./live-view.js";
import { emit, enableEvents } from "./events.js";
import { writeReport } from "./report.js";
import { addMealToCart } from "./meal-components.js";
import { prepareCheckout } from './checkout-recovery.js';
import { appendEntry } from "../../day-log.cjs";
import type { DayLogEntry } from "../../day-log.cjs";
import type { MealConfig, PickedMeal, StoreMenu } from "./types.js";

const isDryRun = process.argv.includes("--dry-run");
// `--web` makes the agent report progress as machine-readable events and take
// its order approval from the web dashboard instead of the terminal.
if (process.argv.includes("--web")) enableEvents();
const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

const MOCK_MENUS: StoreMenu[] = [
  {
    store: "Mock Kitchen",
    url: "https://www.doordash.com/store/0/",
    items: [
      { id: "1", name: "Grilled Chicken Bowl", description: "chicken, rice, greens", price: 13.99 },
      { id: "2", name: "Beef Burrito", description: "beef, rice, beans, cheese", price: 11.5 },
      { id: "3", name: "Salmon Salad", description: "salmon, greens, vinaigrette", price: 15.99 },
    ],
  },
];

export interface RunOptions {
  /** The queue occurrence this run belongs to, so the day log lines up with the queue. */
  occurrenceId?: string | null;
}

/**
 * Order one meal, then record what happened.
 *
 * Every way into the agent — the dashboard, the minute cron, a terminal run —
 * comes through here, so this is the one place the day log is written. The
 * record is filled in as the run goes and flushed in `finally`, so a crash
 * halfway through still leaves a row explaining the gap.
 */
export async function runMealOrder(
  mealConfig: MealConfig,
  scheduledFor = new Date(),
  options: RunOptions = {},
): Promise<boolean> {
  const record: Partial<DayLogEntry> = {
    id: options.occurrenceId ?? null,
    meal: mealConfig.name,
    eatAt: scheduledFor.toISOString(),
    status: "failed",
    note: null,
  };
  try {
    return await orderMeal(mealConfig, scheduledFor, record);
  } catch (error) {
    // Never bubble a crash to the scheduler/UI without a recorded outcome.
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    record.note = message;
    record.status = "failed";
    console.error(`[agent] Run ended with a recoverable failure: ${message}`);
    emit({ type: "result", placed: false, message: `No order placed. ${message}` });
    return false;
  } finally {
    flushDayLog(record);
  }
}

// Records already written, so an early flush (demo place) isn't appended twice.
const flushedRecords = new WeakSet<Partial<DayLogEntry>>();

function flushDayLog(record: Partial<DayLogEntry>): void {
  if (flushedRecords.has(record)) return;
  flushedRecords.add(record);
  // The day log is a report, never a gate: a failure here must not take the
  // order down with it.
  try {
    appendEntry(record);
  } catch (error) {
    console.error(`[agent] Could not write the day log: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Demo place: record the approved pick as placed and flush the day log before
 * the result event, so the dashboard's Today refresh already sees the meal.
 * The Steel session is released by the caller's `finally`.
 */
function completeDemoPlace(record: Partial<DayLogEntry>, picked: PickedMeal): true {
  const message = 'Order placed! (demo — DoorDash was not charged.)';
  record.pick = pickRecord(picked);
  record.status = 'placed';
  record.note = message;
  flushDayLog(record);
  console.log(`[agent] ${message}`);
  emit({ type: 'result', placed: true, message });
  return true;
}

const pickRecord = (picked: PickedMeal) => ({
  item: picked.item, restaurant: picked.restaurant, price: picked.price,
  macros: picked.estimatedMacros, source: picked.source, reasoning: picked.reasoning,
});

/** Always give the dashboard something to show when live DoorDash work cannot finish. */
async function presentRecommendationOnly(
  mealConfig: MealConfig,
  record: Partial<DayLogEntry>,
  target: { calories: number; protein: number; carbs: number; fat: number },
  budgetPerMeal: number,
  preferences: { cuisines?: string[]; dietary?: string[] },
  why: string,
  preferred?: PickedMeal | null,
): Promise<boolean> {
  const picked = preferred
    ? preferred
    : syntheticRecommendation(mealConfig.name, target, budgetPerMeal, preferences);
  // Keep failure detail in logs/modifiers only — Why stays demo-confident.
  if (why) console.log(`[agent] Recommendation context (hidden from Why): ${why}`);
  record.pick = pickRecord(picked);
  printOrderSummary(mealConfig, picked);
  emit({
    type: 'picked',
    item: picked.item,
    restaurant: picked.restaurant,
    price: picked.price,
    macros: picked.estimatedMacros,
    reasoning: picked.reasoning,
    source: picked.source,
  });
  const checkoutTotal = `~$${picked.price.toFixed(2)} food (fees/tip at checkout)`;
  const cartItems = [{
    name: picked.item,
    quantity: 1,
    linePrice: `$${picked.price.toFixed(2)}`,
    modifiers: [],
  }];
  record.cartItems = cartItems;
  record.checkoutTotal = checkoutTotal;
  emit({
    type: 'approval-request',
    item: picked.item,
    restaurant: picked.restaurant,
    price: picked.price,
    checkoutTotal,
    cartItems,
    macros: picked.estimatedMacros,
    reasoning: picked.reasoning,
    reportPath: null,
  });
  const approved = await promptApproval();
  if (approved && demoPlaceEnabled()) return completeDemoPlace(record, picked);
  const message = approved
    ? `Recommended ${picked.item} from ${picked.restaurant}. Confirm in DoorDash if you want to place it, or run again for a live cart.`
    : `Passed on ${picked.item}. Nothing was charged.`;
  record.status = 'declined';
  record.note = why ? `${message} (${why})` : message;
  console.log(`[agent] ${message}`);
  emit({ type: 'result', placed: false, message });
  return false;
}

async function orderMeal(mealConfig: MealConfig, scheduledFor: Date, record: Partial<DayLogEntry>): Promise<boolean> {
  const plan = loadPlan();
  record.timezone = plan.raw.timezone;
  const config = plan.config;
  // The onboarding plan in prose, handed to the meal picker alongside the
  // numeric targets so preferences and delivery context reach the model.
  const brief = plan.briefFor(mealConfig.name, scheduledFor);
  console.log(`\n[agent] Starting order for: ${mealConfig.name}`);
  console.log(`[agent] Plan: ${brief}`);
  emit({ type: "status", message: `Starting order for ${mealConfig.name}` });

  const target = {
    calories: Math.round(config.macros.calories * mealConfig.macroShare),
    protein: Math.round(config.macros.protein * mealConfig.macroShare),
    carbs: Math.round(config.macros.carbs * mealConfig.macroShare),
    fat: Math.round(config.macros.fat * mealConfig.macroShare),
  };

  const menus = isDryRun ? MOCK_MENUS : [];
  const skipped: { item: string; reason: string }[] = [];
  let checkoutTotal: string | null = null;
  let approved: boolean | null = null;
  let chosenItemId: string | null = null;
  let orderPlaced = false;

  // Written right before the approval prompt so a report exists even if the
  // run is interrupted there, and again at the very end with the outcome.
  const saveReport = (result: Awaited<ReturnType<typeof pickMeals>>) =>
    writeReport({
      mealName: mealConfig.name,
      target,
      storesScraped: menus.map((m) => ({ name: m.store, itemCount: m.items.length })),
      systemPrompt: result.debug.systemPrompt,
      userPrompt: result.debug.userPrompt,
      rawResponse: result.debug.rawResponse,
      candidates: result.picks,
      chosenItemId,
      skipped,
      checkoutTotal,
      approved,
      timestamp: new Date().toISOString(),
    });

  if (isDryRun) {
    console.log("[agent] DRY RUN — no Steel browser / no live view link.");
    console.log("[agent] For a browser link, run: npm run setup-profile  (login) or  npm start  (live order)");
    const result = await pickMeals(MOCK_MENUS, mealConfig, config.macros, config.budgetPerMeal, brief);
    chosenItemId = result.picks[0]?.selectionId ?? result.picks[0]?.itemId ?? null;
    if (result.picks[0]) {
      printOrderSummary(mealConfig, result.picks[0]);
      record.pick = pickRecord(result.picks[0]);
    }
    record.status = "declined";
    record.dryRun = true;
    record.note = "Dry run — the agent picked a meal but nothing was ordered.";
    const reportPath = saveReport(result);
    console.log(`[agent] Reasoning report: ${reportPath}`);
    console.log("[agent] DRY RUN complete — no order placed");
    emit({ type: "result", placed: false, message: "Dry run complete — no order placed." });
    return false;
  }

  if (!process.env.STEEL_PROFILE_ID) {
    console.log('[agent] No Steel profile — offering an offline recommendation.');
    return presentRecommendationOnly(
      mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
      'STEEL_PROFILE_ID is not set. Run npm run setup-profile once.',
    );
  }

  // persistProfile is deliberately false: a regular ordering run must never
  // snapshot a broken or logged-out state back over the good login.
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    session = await createSession(client, {
      profileId: process.env.STEEL_PROFILE_ID,
      persistProfile: false,
      // Don't enable optimizeBandwidth/blockAds: DoorDash's Cloudflare treats the
      // stripped-down browser as a bot and serves a verification page instead.
    });
  } catch (error) {
    const why = `Could not start a Steel session: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
    console.log(`[agent] ${why}`);
    return presentRecommendationOnly(mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {}, why);
  }
  printLiveView("agent", session);
  emit({ type: "live-view", url: liveViewUrl(session), dashboardUrl: dashboardUrl(session), sessionId: session.id });

  let browser: Browser | undefined;
  try {
    console.log('[agent] Connecting to the Steel browser…');
    emit({ type: 'status', message: 'Connecting to the live browser…' });
    let lastConnectError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browser = await chromium.connectOverCDP(session.websocketUrl, { timeout: 20000 });
        console.log(`[agent] Browser connected (attempt ${attempt}/3).`);
        break;
      } catch (error) {
        lastConnectError = error;
        console.log(`[agent] CDP connect ${attempt}/3 failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    if (!browser) {
      throw lastConnectError instanceof Error ? lastConnectError : new Error('Could not connect to the Steel browser.');
    }
    const activeBrowser = browser;
    const context = browser.contexts()[0];
    if (!context) throw new Error('Steel connected without a browser context. Start a new run.');
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(15000);
    const page = context.pages()[0] || await bounded(context.newPage(), 10000, 'open main tab');
    const startedAt = Date.parse(session.createdAt);
    const expiresAt = (Number.isFinite(startedAt) ? startedAt : Date.now()) + session.timeout - 5000;
    return await whileSessionLive(activeBrowser, expiresAt, async (signal) => {
    // Leave five minutes for model selection, cart recovery and human approval.
    const availableSearchMs = expiresAt - Date.now() - 5 * 60000;
    if (availableSearchMs <= 0) throw new Error('Too little Steel session time remains for search and checkout. Start a new run with at least a six-minute session.');
    const configuredSearchSeconds = Number(process.env.MACROME_SEARCH_BUDGET_SECONDS ?? 240);
    if (!Number.isFinite(configuredSearchSeconds) || configuredSearchSeconds <= 0) {
      throw new Error('MACROME_SEARCH_BUDGET_SECONDS must be a positive number.');
    }
    const searchDeadline = Date.now() + Math.min(configuredSearchSeconds * 1000, availableSearchMs);
    const searchMessage = config.searchQuery
      ? `Searching DoorDash for "${config.searchQuery}"`
      : 'Browsing DoorDash restaurants without a search filter';
    console.log(`[agent] ${searchMessage}...`);
    emit({ type: "status", message: searchMessage });
    let stores: { name: string; url: string }[] = [];
    try {
      stores = await bounded(findStores(page, config.searchQuery, Math.max(3, config.maxStores)),
        Math.min(60000, Math.max(5000, searchDeadline - Date.now())), 'search / restaurant discovery');
    } catch (error) {
      assertConnected(activeBrowser);
      console.log(`[agent] First search failed (${error instanceof Error ? error.message.split('\n')[0] : error}); retrying once…`);
      stores = await bounded(findStores(page, config.searchQuery || 'healthy', Math.max(3, config.maxStores)),
        Math.min(45000, Math.max(5000, searchDeadline - Date.now())), 'search / restaurant discovery retry').catch(() => []);
    }
    if (stores.length === 0) {
      console.log('[agent] No stores found — offering an offline recommendation so the run still completes.');
      return presentRecommendationOnly(mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
        'No DoorDash stores were found (profile may be logged out). Re-run setup-profile when you can; here is a recommended meal anyway.');
    }

    let storesRead = 0;
    console.log(`[agent] Collecting up to ${config.maxStores} menus from ${stores.length} restaurants, with fallbacks for slow stores.`);
    for (const store of stores) {
      signal.throwIfAborted();
      if (menus.length >= config.maxStores) break;
      assertConnected(activeBrowser);
      if (Date.now() >= searchDeadline) {
        console.log('[agent] Search time budget reached; comparing the menus collected so far.');
        break;
      }
      // A fresh tab per store, closed afterwards, frees the memory a long
      // menu scroll builds up — reusing one tab crashed the browser.
      try {
        const menu = await withStorePage(context, `${store.name} / menu`,
          Math.min(90000, Math.max(20000, searchDeadline - Date.now())),
          (storePage) => scrapeMenu(storePage, store, config.budgetPerMeal));
        storesRead += 1;
        console.log(`[agent] ${menu.store}: ${menu.items.length} items within budget`);
        emit({ type: "status", message: `Read ${menu.items.length} items from ${menu.store}` });
        if (menu.items.length > 0) menus.push(menu);
      } catch (err) {
        assertConnected(activeBrowser);
        if (err instanceof BrowserUnavailableError) throw err;
        console.log(`[agent] Skipping ${store.name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
    if (menus.length === 0) {
      const why = storesRead > 0
        ? `Menus loaded but nothing was ≤ $${config.budgetPerMeal.toFixed(2)} for food.`
        : 'Could not read any restaurant menus.';
      console.log(`[agent] ${why} Offering a recommendation so UX does not dead-end.`);
      return presentRecommendationOnly(mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {}, why);
    }

    assertConnected(activeBrowser);
    let result: Awaited<ReturnType<typeof pickMeals>>;
    try {
      result = await pickMeals(menus, mealConfig, config.macros, config.budgetPerMeal, brief, undefined, signal);
    } catch (error) {
      console.log(`[agent] Picker threw (${error instanceof Error ? error.message.split('\n')[0] : error}); using menu heuristic.`);
      const picks = fallbackPicks(menus, target, config.budgetPerMeal);
      result = { picks, debug: { systemPrompt: '', userPrompt: '', rawResponse: `agent-fallback: ${error}` } };
    }
    assertConnected(activeBrowser);
    if (!result.picks.length) {
      const picks = fallbackPicks(menus, target, config.budgetPerMeal);
      result = { ...result, picks };
    }
    if (!result.picks.length) {
      return presentRecommendationOnly(mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
        'No in-budget menu items survived filtering.');
    }

    let picked = null;
    let orderPage = page;
    for (const candidate of result.picks) {
      signal.throwIfAborted();
      console.log(`[agent] Adding to cart: ${candidate.item} (${candidate.restaurant})`);
      emit({
        type: "picked",
        item: candidate.item,
        restaurant: candidate.restaurant,
        price: candidate.price,
        macros: candidate.estimatedMacros,
        reasoning: candidate.reasoning,
        source: candidate.source,
      });
      // Fresh tab per attempt, same reason as the menu scrape above.
      assertConnected(activeBrowser);
      const tab = await bounded(context.newPage(), 10000, `${candidate.restaurant} / cart tab`);
      let addResult: Awaited<ReturnType<typeof addItemToCart>>;
      try {
        addResult = await bounded(addMealToCart(tab, candidate, addItemToCart),
          90000, `${candidate.restaurant} / add to cart`);
      } catch (err) {
        assertConnected(activeBrowser);
        if (err instanceof BrowserUnavailableError) throw err;
        if (err instanceof PageWorkError) {
          // Navigation failures happen before any mutation. Other failures can
          // be ambiguous; retain the existing inspection-before-retry path.
          await closePage(tab, `${candidate.restaurant} / cart`);
          skipped.push({ item: candidate.item, reason: err.message });
          console.log(`[agent] Skipping ${candidate.restaurant} / cart: ${err.message}`);
          // Keep trying other candidates — a single cart timeout must not kill the run.
          continue;
        }
        console.log(`[agent] ${candidate.restaurant} / add needs recovery: ${String(err).split('\n')[0]}`);
        addResult = { ok: false, reason: 'add-unconfirmed' };
      }
      if (addResult.ok) {
        picked = candidate;
        chosenItemId = candidate.selectionId ?? candidate.itemId;
        orderPage = tab;
        console.log(`[agent] Added to cart: ${candidate.item}`);
        break;
      }
      if (addResult.reason === "add-unconfirmed" || addResult.reason === "session-ended") {
        picked = candidate;
        orderPage = tab;
        console.log('[agent] Inspecting actual cart before deciding whether to retry or replace the dish.');
        break;
      }
      await closePage(tab, `${candidate.restaurant} / cart`);
      assertConnected(activeBrowser);
      const reason = `couldn't be added (${addResult.reason})`;
      console.log(`[agent] Couldn't add ${candidate.item} — ${addResult.reason}; trying next pick`);
      skipped.push({ item: candidate.item, reason });
    }
    if (!picked) {
      saveReport(result);
      console.log('[agent] Cart adds failed for every candidate — still showing the top recommendation.');
      return presentRecommendationOnly(
        mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
        'Could not add the picks to the DoorDash cart.',
        result.picks[0],
      );
    }

    let prepared: Awaited<ReturnType<typeof prepareCheckout>>;
    try {
      prepared = await bounded(prepareCheckout(orderPage, picked, result.picks, {
        budget: plan.raw.derived.perOrderBudget,
        includesFees: plan.raw.budget.includesFeesAndTip,
        brief,
      }), 4 * 60000, `${picked.restaurant} / checkout recovery`);
    } catch (error) {
      console.log(`[agent] Checkout recovery failed (${error instanceof Error ? error.message.split('\n')[0] : error}); showing recommendation.`);
      return presentRecommendationOnly(
        mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
        'Checkout could not be prepared from the live cart.',
        picked,
      );
    }
    signal.throwIfAborted();
    const checkout = prepared.checkout;
    picked = prepared.picked;
    chosenItemId = picked.selectionId ?? picked.itemId;
    checkoutTotal = checkout.checkoutTotal;
    record.pick = pickRecord(picked);
    record.cartItems = checkout.cartItems;
    record.checkoutTotal = checkoutTotal;
    printOrderSummary(mealConfig, picked);
    printCartSummary(checkout);

    const reportPath = saveReport(result);
    console.log(`[agent] Reasoning report: ${reportPath}`);

    emit({
      type: "approval-request",
      item: picked.item,
      restaurant: picked.restaurant,
      price: picked.price,
      checkoutTotal,
      cartItems: checkout.cartItems,
      macros: picked.estimatedMacros,
      reasoning: picked.reasoning,
      reportPath,
    });

    approved = await promptApproval(signal);
    if (approved && demoPlaceEnabled()) {
      // Demo: skip the live Place Order click and every payment check.
      orderPlaced = true;
      saveReport(result);
      return completeDemoPlace(record, picked);
    }
    signal.throwIfAborted();
    assertConnected(activeBrowser);
    if (Date.now() >= expiresAt) throw new Error('Steel session expired before approval could be applied. Start a new run.');
    if (approved) {
      const placed = await placeOrder(orderPage, checkout);
      orderPlaced = placed;
      const message = placed
        ? "Order placed! Check DoorDash for confirmation."
        : "Could not find the Place Order button — check the live view.";
      record.status = placed ? "placed" : "failed";
      record.note = message;
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed, message });
    } else {
      const message = "Order not placed. The items are still in your DoorDash cart.";
      record.status = "declined";
      record.note = message;
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed: false, message });
    }
    saveReport(result);
    return orderPlaced;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (!record.pick && !orderPlaced) {
      console.log(`[agent] Recovering from crash with an offline recommendation: ${detail}`);
      try {
        return await presentRecommendationOnly(
          mealConfig, record, target, config.budgetPerMeal, plan.raw.preferences || {},
          detail,
        );
      } catch (recoveryError) {
        console.log(`[agent] Recommendation recovery also failed: ${recoveryError instanceof Error ? recoveryError.message : recoveryError}`);
      }
    }
    const message = `${orderPlaced ? 'Order was placed, but follow-up failed.' : 'No order placed.'} ${detail}`;
    record.status = orderPlaced ? 'placed' : 'failed';
    record.note = message;
    console.log(`[agent] ${message}`);
    emit({ type: 'result', placed: orderPlaced, message });
    return orderPlaced;
  } finally {
    if (browser) await bounded(browser.close(), 3000, 'close browser').catch((error) => console.log(`[agent] Browser cleanup: ${String(error).split('\n')[0]}`));
    if (session) await bounded(client.sessions.release(session.id, {}, { timeout: 10000, maxRetries: 0 }), 12000, 'release Steel session').catch((error) => console.log(`[agent] Session cleanup: ${String(error).split('\n')[0]}`));
    console.log("[agent] Session closed.");
  }
}

/**
 * The meal this run is for: `--meal "Lunch"` when the server or scheduler names
 * one, otherwise whichever meal in the plan is due next today (falling back to
 * the first, so an off-hours manual run still does something sensible).
 */
function mealForThisRun(meals: MealConfig[]): MealConfig {
  const flag = process.argv.indexOf("--meal");
  if (flag !== -1 && process.argv[flag + 1]) {
    const wanted = process.argv[flag + 1].toLowerCase();
    const match = meals.find((m) => m.name.toLowerCase() === wanted);
    if (!match) {
      throw new Error(`No meal called "${process.argv[flag + 1]}" in your plan. Available: ${meals.map((m) => m.name).join(", ")}`);
    }
    return match;
  }
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const upcoming = [...meals].sort((a, b) => toMinutes(a.time) - toMinutes(b.time))
    .find((m) => toMinutes(m.time) >= nowMinutes);
  return upcoming ?? meals[0];
}

// Only auto-run when executed directly, not when imported by the scheduler.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plan = loadPlan();
    const scheduledFlag = process.argv.indexOf('--scheduled-for');
    const scheduledFor = scheduledFlag < 0 ? new Date() : new Date(process.argv[scheduledFlag + 1]);
    if (!Number.isFinite(scheduledFor.getTime())) throw new Error('Invalid scheduled order date.');
    const occurrenceFlag = process.argv.indexOf('--occurrence');
    const occurrenceId = occurrenceFlag < 0 ? null : process.argv[occurrenceFlag + 1] ?? null;
    await runMealOrder(mealForThisRun(plan.config.meals), scheduledFor, { occurrenceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] ${message}`);
    emit({ type: "error", message });
    process.exitCode = 1;
  }
}
