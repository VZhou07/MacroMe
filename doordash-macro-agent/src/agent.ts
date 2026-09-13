import "dotenv/config";
import { pathToFileURL } from "url";
import { chromium } from "playwright-core";
import Steel from "steel-sdk";
import { loadPlan } from "./plan.js";
import { addItemToCart, findStores, goToCheckout, placeOrder, scrapeMenu } from "./doordash.js";
import { pickMeals } from "./macro-picker.js";
import { printOrderSummary, promptApproval } from "./notifier.js";
import { printLiveView, liveViewUrl, dashboardUrl } from "./live-view.js";
import { emit, enableEvents } from "./events.js";
import { writeReport } from "./report.js";
import type { MealConfig, StoreMenu } from "./types.js";

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

export async function runMealOrder(mealConfig: MealConfig): Promise<void> {
  const plan = loadPlan();
  const config = plan.config;
  // The onboarding plan in prose, handed to the meal picker alongside the
  // numeric targets so preferences and delivery context reach the model.
  const brief = plan.briefFor(mealConfig.name);
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
    chosenItemId = result.picks[0]?.itemId ?? null;
    if (result.picks[0]) printOrderSummary(mealConfig, result.picks[0]);
    const reportPath = saveReport(result);
    console.log(`[agent] Reasoning report: ${reportPath}`);
    console.log("[agent] DRY RUN complete — no order placed");
    emit({ type: "result", placed: false, message: "Dry run complete — no order placed." });
    return;
  }

  if (!process.env.STEEL_PROFILE_ID) {
    throw new Error(
      "STEEL_PROFILE_ID is not set. Run `npm run setup-profile` once to log into " +
        "DoorDash interactively and save a reusable Steel profile."
    );
  }

  // persistProfile is deliberately false: a regular ordering run must never
  // snapshot a broken or logged-out state back over the good login.
  const session = await client.sessions.create({
    profileId: process.env.STEEL_PROFILE_ID,
    persistProfile: false,
    // Default is 5 min; scraping several menus plus waiting on approval takes
    // longer. The current Steel plan caps sessions at 15 min.
    timeout: 14 * 60 * 1000,
    // Don't enable optimizeBandwidth/blockAds: DoorDash's Cloudflare treats the
    // stripped-down browser as a bot and serves a verification page instead.
  });
  printLiveView("agent", session);
  emit({ type: "live-view", url: liveViewUrl(session), dashboardUrl: dashboardUrl(session), sessionId: session.id });

  const browser = await chromium.connectOverCDP(session.websocketUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  let closing = false;
  page.on("crash", () => console.error("[agent] Browser tab crashed (likely out of memory)."));
  browser.on("disconnected", () => {
    if (!closing) console.error("[agent] Lost connection to the Steel browser.");
  });

  try {
    console.log(`[agent] Searching DoorDash for "${config.searchQuery}"...`);
    emit({ type: "status", message: `Searching DoorDash for "${config.searchQuery}"` });
    const stores = await findStores(page, config.searchQuery, config.maxStores);
    if (stores.length === 0) throw new Error("No stores found — the saved profile may be logged out. Re-run `npm run setup-profile`.");

    let storesRead = 0;
    for (const store of stores) {
      // A fresh tab per store, closed afterwards, frees the memory a long
      // menu scroll builds up — reusing one tab crashed the browser.
      const storePage = await context.newPage();
      try {
        const menu = await scrapeMenu(storePage, store, config.budgetPerMeal);
        storesRead += 1;
        console.log(`[agent] ${menu.store}: ${menu.items.length} items within budget`);
        emit({ type: "status", message: `Read ${menu.items.length} items from ${menu.store}` });
        if (menu.items.length > 0) menus.push(menu);
      } catch (err) {
        if (!browser.isConnected()) throw err;
        console.log(`[agent] Skipping ${store.name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      } finally {
        await storePage.close().catch(() => {});
      }
    }
    if (menus.length === 0) {
      // Distinguish "the scrape failed" from "the scrape worked but nothing was
      // affordable" — they need completely different fixes from the user.
      if (storesRead > 0) {
        const perOrder = plan.raw.derived.perOrderBudget;
        throw new Error(
          `Nothing on the menus costs $${config.budgetPerMeal.toFixed(2)} or less, so there was nothing to pick. ` +
          `Your budget works out to $${perOrder.toFixed(2)} per order` +
          (plan.raw.budget.includesFeesAndTip
            ? `, and because that has to cover delivery, service fees and a ${plan.raw.budget.tipPercent}% tip, only $${config.budgetPerMeal.toFixed(2)} of it is left for food. `
            : `. `) +
          `Raise the budget, order fewer meals a day, or untick "budget includes fees and tip" in the setup.`
        );
      }
      throw new Error("Couldn't read any restaurant menus.");
    }

    const result = await pickMeals(menus, mealConfig, config.macros, config.budgetPerMeal, brief);

    let picked = null;
    let orderPage = page;
    for (const candidate of result.picks) {
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
      const tab = await context.newPage();
      if (await addItemToCart(tab, candidate.storeUrl, candidate.itemId).catch(() => false)) {
        picked = candidate;
        chosenItemId = candidate.itemId;
        orderPage = tab;
        break;
      }
      await tab.close().catch(() => {});
      if (!browser.isConnected()) throw new Error("Lost the Steel browser while adding to cart.");
      const reason = "couldn't be added (it may need required options like size or sides)";
      console.log(`[agent] Couldn't add ${candidate.item} — trying next pick`);
      skipped.push({ item: candidate.item, reason });
    }
    if (!picked) {
      saveReport(result);
      throw new Error("None of the picked items could be added to the cart.");
    }

    checkoutTotal = await goToCheckout(orderPage);
    if (!checkoutTotal) {
      saveReport(result);
      throw new Error("Couldn't reach the DoorDash checkout page.");
    }
    printOrderSummary(mealConfig, picked);
    console.log(`  Checkout total: ${checkoutTotal} (everything in the cart, including fees)`);

    const reportPath = saveReport(result);
    console.log(`[agent] Reasoning report: ${reportPath}`);

    emit({
      type: "approval-request",
      item: picked.item,
      restaurant: picked.restaurant,
      price: picked.price,
      checkoutTotal,
      macros: picked.estimatedMacros,
      reasoning: picked.reasoning,
      reportPath,
    });

    approved = await promptApproval();
    if (approved) {
      const placed = await placeOrder(orderPage);
      const message = placed
        ? "Order placed! Check DoorDash for confirmation."
        : "Could not find the Place Order button — check the live view.";
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed, message });
    } else {
      const message = "Order not placed. The item is still in your DoorDash cart.";
      console.log(`[agent] ${message}`);
      emit({ type: "result", placed: false, message });
    }
    saveReport(result);
  } finally {
    closing = true;
    await browser.close();
    await client.sessions.release(session.id);
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
    await runMealOrder(mealForThisRun(plan.config.meals));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] ${message}`);
    emit({ type: "error", message });
    process.exitCode = 1;
  }
}
