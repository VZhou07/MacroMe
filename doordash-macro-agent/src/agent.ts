import { reconcileUncertainAdd } from './cart-reconciliation.js';
import "dotenv/config";
import { pathToFileURL } from "url";
import { chromium, type Browser } from "playwright-core";
import Steel from "steel-sdk";
import { createSession } from "./session.js";
import { assertConnected, bounded, BrowserUnavailableError, closePage, PageWorkError, whileSessionLive, withStorePage } from "./browser-work.js";
import { loadPlan } from "./plan.js";
import { addItemToCart, demoPlaceEnabled, findStores, placeOrder, scrapeMenu } from "./doordash.js";
import { pickMeals } from "./macro-picker.js";
import { fallbackPicks } from "./fallback-picks.js";
import { printCartSummary, printOrderSummary, promptApproval } from "./notifier.js";
import { printLiveView, liveViewUrl, dashboardUrl } from "./live-view.js";
import { emit, enableEvents } from "./events.js";
import { writeReport } from "./report.js";
import { addMealToCart } from "./meal-components.js";
import { prepareCheckout } from './checkout-recovery.js';
import { shuffled } from "./shuffle.js";
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
    flushDayLog(record);
    emit({ type: "result", placed: false, message: `No order placed. ${message}` });
    return false;
  } finally {
    flushDayLog(record);
  }
}

const pickRecord = (picked: PickedMeal) => ({
  item: picked.item, restaurant: picked.restaurant, price: picked.price,
  macros: picked.estimatedMacros, source: picked.source, reasoning: picked.reasoning,
});

// Records already written, so an early flush (demo place) isn't appended twice.
const flushedRecords = new WeakSet<Partial<DayLogEntry>>();

function flushDayLog(record: Partial<DayLogEntry>): void {
  if (flushedRecords.has(record)) return;
  flushedRecords.add(record);
  try {
    appendEntry(record);
  } catch (error) {
    console.error(`[agent] Could not write the day log: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Demo place: record the approved pick as placed and flush the day log before
 * the result event, so the dashboard's Today refresh already sees the meal.
 */
function completeDemoPlace(record: Partial<DayLogEntry>, picked: PickedMeal, label?: string): true {
  const message = label
    || `Order placed! (demo — ${picked.item} from ${picked.restaurant}; DoorDash was not charged.)`;
  record.pick = pickRecord(picked);
  record.status = 'placed';
  record.note = message;
  flushDayLog(record);
  console.log(`[agent] ${message}`);
  emit({ type: 'result', placed: true, message });
  return true;
}

/** Report a failed preparation without offering a checkout approval for an unverified cart. */
async function reportNoOrder(
  mealConfig: MealConfig,
  record: Partial<DayLogEntry>,
  why: string,
  preferred?: PickedMeal | null,
): Promise<boolean> {
  if (preferred) record.pick = pickRecord(preferred);
  const message = `No order placed for ${mealConfig.name}. ${why}`;
  record.status = 'failed';
  record.note = message;
  flushDayLog(record);
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
  const skipped: { item: string; reason: string; details?: unknown }[] = [];
  const addAttempts: unknown[] = [];
  let checkoutRecovery: unknown = null;
  let checkoutTotal: string | null = null;
  let approved: boolean | null = null;
  let chosenItemId: string | null = null;
  let orderPlaced = false;
  let orderSubmissionAttempted = false;

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
      skipped, addAttempts, checkoutRecovery,
      checkoutTotal,
      approved,
      timestamp: new Date().toISOString(),
    });

  if (isDryRun) {
    console.log("[agent] DRY RUN — no Steel browser / no live view link.");
    console.log("[agent] For a browser link, run: npm run setup-profile  (login) or  npm start  (live order)");
    const result = await pickMeals(MOCK_MENUS, mealConfig, config.macros, config.budgetPerMeal, brief, undefined, undefined, plan.raw.preferences);
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
    console.log('[agent] No Steel profile; no order can be prepared.');
    return reportNoOrder(
      mealConfig, record,
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
    return reportNoOrder(mealConfig, record, why);
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
    // A small pool of top results, shuffled: runs vary which restaurants get
    // compared without wandering far down the results, and the extras double
    // as fallbacks for slow stores.
    const storePool = config.maxStores + 3;
    try {
      stores = await bounded(findStores(page, config.searchQuery, storePool),
        Math.min(60000, Math.max(5000, searchDeadline - Date.now())), 'search / restaurant discovery');
    } catch (error) {
      assertConnected(activeBrowser);
      console.log(`[agent] First search failed (${error instanceof Error ? error.message.split('\n')[0] : error}); retrying once…`);
      stores = await bounded(findStores(page, config.searchQuery || 'healthy', storePool),
        Math.min(45000, Math.max(5000, searchDeadline - Date.now())), 'search / restaurant discovery retry').catch(() => []);
    }
    stores = shuffled(stores);
    if (stores.length === 0) {
      console.log('[agent] No stores found; no order can be prepared.');
      return reportNoOrder(mealConfig, record,
        'No DoorDash stores were found (profile may be logged out). Re-run setup-profile before retrying.');
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
      console.log(`[agent] ${why}`);
      return reportNoOrder(mealConfig, record, why);
    }

    assertConnected(activeBrowser);
    let result: Awaited<ReturnType<typeof pickMeals>>;
    try {
      result = await pickMeals(menus, mealConfig, config.macros, config.budgetPerMeal, brief, undefined, signal, plan.raw.preferences);
    } catch (error) {
      console.log(`[agent] Picker threw (${error instanceof Error ? error.message.split('\n')[0] : error}); using menu heuristic.`);
      const picks = fallbackPicks(menus, target, config.budgetPerMeal, '', 3, plan.raw.preferences);
      result = { picks, debug: { systemPrompt: '', userPrompt: '', rawResponse: `agent-fallback: ${error}` } };
    }
    assertConnected(activeBrowser);
    if (!result.picks.length) {
      const picks = fallbackPicks(menus, target, config.budgetPerMeal, '', 3, plan.raw.preferences);
      result = { ...result, picks };
    }
    if (!result.picks.length) {
      return reportNoOrder(mealConfig, record,
        'No in-budget menu items survived filtering.');
    }

    // Stick to a short ranked list — stacking many adds was blowing past budget
    // when leftovers stayed in the DoorDash cart.
    console.log(`[agent] Will try up to ${result.picks.length} cart candidate(s).`);

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
      let tab = await bounded(context.newPage(), 10000, `${candidate.restaurant} / cart tab`);
      let addResult: Awaited<ReturnType<typeof addItemToCart>>;
      try {
        addResult = await bounded(addMealToCart(tab, candidate, addItemToCart, { target, preferences: plan.raw.preferences, budget: config.budgetPerMeal }),
          150000, `${candidate.restaurant} / add to cart`);
      } catch (err) {
        assertConnected(activeBrowser);
        if (err instanceof BrowserUnavailableError) throw err;
        console.log(`[agent] Add requires reconciliation: ${String(err).split('\n')[0]}`);
        addResult = { ok: false, status: 'uncertain', phase: 'timeout', reason: String(err).split('\n')[0] };
      }
      addAttempts.push({ item: candidate.item, result: addResult });
      if (!addResult.ok && addResult.status === 'uncertain') {
        try {
          const reconciled = await reconcileUncertainAdd(tab, candidate);
          tab = reconciled.page;
          if (reconciled.matched) addResult = { ...addResult, ok: true, status: 'confirmed', phase: 'reconciled' };
        } catch (error) {
          skipped.push({ item: candidate.item, reason: String(error).split('\n')[0], details: addResult });
          break;
        }
      }

      if (addResult.ok) {
        picked = candidate;
        chosenItemId = candidate.selectionId ?? candidate.itemId;
        orderPage = tab;
        console.log(`[agent] Added to cart: ${candidate.item}`);
        break;
      }
      // Never proceed to checkout on an unconfirmed add — that left stale carts
      // stuck in recovery. Close the tab and try the next pick instead.
      await closePage(tab, `${candidate.restaurant} / cart`);
      assertConnected(activeBrowser);
      if (addResult.reason === 'session-ended') {
        console.log('[agent] Steel session ended during add; stopping further cart attempts.');
        skipped.push({ item: candidate.item, reason: 'session ended' });
        break;
      }
      const reason = `couldn't be added (${addResult.reason})`;
      console.log(`[agent] Couldn't add ${candidate.item} — ${addResult.reason}; trying next pick`);
      skipped.push({ item: candidate.item, reason, details: addResult });
    }
    if (!picked) {
      saveReport(result);
      console.log('[agent] Cart adds failed for every candidate; no approval will be offered.');
      return reportNoOrder(
        mealConfig, record,
        `Could not verify a cart: ${skipped.map(s => s.reason).join('; ')}`,
        result.picks[0],
      );
    }

    let prepared: Awaited<ReturnType<typeof prepareCheckout>>;
    try {
      prepared = await bounded(prepareCheckout(orderPage, picked, result.picks, {
        budget: plan.raw.derived.perOrderBudget,
        includesFees: plan.raw.budget.includesFeesAndTip,
        brief, target, preferences: plan.raw.preferences, onPage: page => { orderPage = page; },
      }), 4 * 60000, `${picked.restaurant} / checkout recovery`);
    } catch (error) {
      checkoutRecovery = error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : { phase: 'checkout', reason: String(error).split('\n')[0] };
      skipped.push({ item: picked.item, reason: `checkout-recovery: ${String(error).split('\n')[0]}` });
      saveReport(result);
      await closePage(orderPage, 'checkout recovery failed');
      console.log(`[agent] Checkout recovery failed (${error instanceof Error ? error.message.split('\n')[0] : error}).`);
      return reportNoOrder(
        mealConfig, record,
        `Checkout could not be prepared: ${String(error).split('\n')[0]}`,
        picked,
      );
    }
    signal.throwIfAborted();
    const checkout = prepared.checkout;
    checkoutRecovery = prepared.evidence;
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
      orderPlaced = true;
      saveReport(result);
      return completeDemoPlace(record, picked);
    }
    signal.throwIfAborted();
    assertConnected(activeBrowser);
    if (Date.now() >= expiresAt) throw new Error('Steel session expired before approval could be applied. Start a new run.');
    if (approved) {
      const placed = await placeOrder(orderPage, checkout, { onSubmit: () => { orderSubmissionAttempted = true; } });
      orderPlaced = placed;
      const message = placed
        ? "Order placed! Check DoorDash for confirmation."
        : "Could not find the Place Order button — check the live view.";
      record.status = placed ? "placed" : "failed";
      record.note = message;
      flushDayLog(record);
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed, message });
    } else {
      const message = "Order not placed. The items are still in your DoorDash cart.";
      record.status = "declined";
      record.note = message;
      flushDayLog(record);
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed: false, message });
    }
    saveReport(result);
    return orderPlaced;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (!record.pick && !orderPlaced) {
      console.log(`[agent] Recording failed order preparation: ${detail}`);
      try {
        return await reportNoOrder(
          mealConfig, record,
          detail,
        );
      } catch (recoveryError) {
        console.log(`[agent] Failure recording also failed: ${recoveryError instanceof Error ? recoveryError.message : recoveryError}`);
      }
    }
    const message = orderPlaced
      ? `Order was placed, but follow-up failed. ${detail}`
      : orderSubmissionAttempted
        ? `Order submission was attempted, but confirmation is unavailable. Check DoorDash order history before retrying. ${detail}`
        : `No order placed. ${detail}`;
    record.status = orderPlaced ? 'placed' : 'failed';
    record.note = message;
    flushDayLog(record);
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
