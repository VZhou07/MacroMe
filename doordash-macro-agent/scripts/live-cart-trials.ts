/** Cart-only validation. Never invokes approval, notifier, scheduler or placeOrder. */
import 'dotenv/config';
import Steel from 'steel-sdk';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { findStores, scrapeMenu, addItemToCart, goToCheckout, clearCart, inspectCart } from '../src/doordash.js';
import { addMealToCart, cartContainsMeal } from '../src/meal-components.js';
import { bounded, closePage, withStorePage, navigate } from '../src/browser-work.js';
import { reconcileUncertainAdd } from '../src/cart-reconciliation.js';
import { loadPlan } from '../src/plan.js';
import { cartCost } from '../src/recovery.js';
import { pickMeals } from '../src/macro-picker.js';
const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY, timeout: 20000, maxRetries: 0 });
const report: any = { startedAt: new Date().toISOString(), requested: 20, attempts: [], discovery: [], purchases: 0 };
mkdirSync('reports', { recursive: true });
const reportPath = `reports/cart-trials-${report.startedAt.replace(/[:.]/g,'-')}.json`;
const save = () => writeFileSync(reportPath, JSON.stringify(report,null,2));
let session: any, browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  report.interruptedAt = new Date().toISOString();
  report.blocked = 'Trial interrupted; reconcile the last cart before resuming.';
  save();
  void browser?.close().catch(() => {});
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const plan=loadPlan();
  const share=plan.config.meals[0].macroShare;
  const target={calories:Math.round(plan.config.macros.calories*share),protein:Math.round(plan.config.macros.protein*share),carbs:Math.round(plan.config.macros.carbs*share),fat:Math.round(plan.config.macros.fat*share)};
  session=await client.sessions.create({profileId:process.env.STEEL_PROFILE_ID,persistProfile:false,timeout:900000});
  browser=await chromium.connectOverCDP(session.websocketUrl,{timeout:20000});
  let context=browser.contexts()[0];
  let page=await context.newPage();
  const previousPath = process.argv.find(arg => arg.startsWith('--from='))?.slice(7);
  const previousCandidates = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')).candidates : [];
  const stores=previousCandidates?.length >= 5 ? [] : await findStores(page,'bowls',8);
  await closePage(page,'trial discovery');
  report.stores=stores.map(s=>s.name); save();
  const candidates=previousCandidates ?? [];
  report.candidates=candidates;
  for(const store of stores){
    try {
      const menu=await withStorePage(context, `trial menu ${store.name}`, 65000, tab=>scrapeMenu(tab,store,plan.config.budgetPerMeal));
      const picks=await pickMeals([menu],plan.config.meals[0],plan.config.macros,plan.config.budgetPerMeal,plan.briefFor(plan.config.meals[0].name),undefined,undefined,plan.raw.preferences);
      if(picks.picks[0]) candidates.push(picks.picks[0]);
    } catch(error){report.discovery.push({store:store.name,reason:String(error).split('\n')[0]});}
    report.candidates=candidates; save();if(candidates.length>=5) break;
  }
  if(candidates.length<5) throw new Error(`Only ${candidates.length} eligible restaurants; five-restaurant trial coverage unavailable`);
  for(let attempt=0;attempt<20;attempt++){
    if (stopping) break;
    if (attempt > 0 && attempt % 5 === 0) {
      await client.sessions.release(session.id);
      await bounded(browser.close(), 5000, 'close completed trial session').catch(()=>{});
      session=await client.sessions.create({profileId:process.env.STEEL_PROFILE_ID,persistProfile:false,timeout:900000});
      browser=await chromium.connectOverCDP(session.websocketUrl,{timeout:20000});
      context=browser.contexts()[0];
    }
    page=await context.newPage();
    const pick=structuredClone(candidates[attempt%5]);
    const trial:any={attempt:attempt+1,restaurant:pick.restaurant,item:pick.item,cartVerified:false,checkoutReady:false};
    report.attempts.push(trial);save();
    try {
      let result;
      try { result=await bounded(addMealToCart(page,pick,addItemToCart,{preferences:plan.raw.preferences,budget:plan.config.budgetPerMeal,target}),120000,'trial add'); }
      catch(error){result={ok:false,status:'uncertain',reason:String(error).split('\n')[0]};}
      trial.add=result; trial.cartVerified=result.ok; save();
      if (!result.ok && result.status === 'failed') {
        trial.reason = result.reason;
        console.log(`Trial ${attempt+1}: ${pick.restaurant}: rejected before Add (${result.reason})`);
        continue;
      }
      if(!result.ok && result.status==='uncertain'){
        const reconciled=await reconcileUncertainAdd(page,pick);
        page=reconciled.page;trial.reconciliation=reconciled.cart;
        trial.cartVerified=reconciled.matched;
        if(!reconciled.matched){trial.reason=result.reason;continue;}
      }
      const cart=await bounded(goToCheckout(page),45000,'trial checkout');
      if(!cart) throw new Error('cart-unreadable; stopping trials before another mutation');
      trial.cart=cart;trial.cartVerified=cartContainsMeal(cart,pick);trial.checkoutReadable=trial.cartVerified && !!cart.checkoutTotal;trial.checkoutReady=trial.checkoutReadable && cartCost(cart,plan.raw.budget.includesFeesAndTip)<=plan.raw.derived.perOrderBudget && await page.locator('[data-testid="PlaceOrderButton"]').first().isEnabled().catch(()=>false);
      // A fresh drawer avoids fragile checkout-to-store transitions during cleanup.
      await closePage(page, 'trial checkout inspected');
      page=await context.newPage();
      await navigate(page,pick.storeUrl,['[data-testid="storeInfo"]','[data-testid="MenuItem"]'],'trial cleanup',{attemptMs:35000});
      const cleanupCart=await bounded(inspectCart(page),45000,'trial cleanup inspection');
      if(!cleanupCart)throw Error('cleanup-cart-unreadable; no further mutations');
      trial.cleanupCart=cleanupCart;
      if(cleanupCart.cartItems.length)await clearCart(page,cleanupCart);
      trial.cleared=true;
      console.log(`Trial ${attempt+1}: ${pick.restaurant}: cart=${trial.cartVerified}, checkout=${trial.checkoutReady}`);
    }catch(error){trial.reason=String(error).split('\n')[0];save();throw error;}
    finally{save();await closePage(page,'trial finished');}
  }
}catch(error){if(!stopping)report.blocked=String(error).split('\n')[0];console.log(report.blocked);}
finally{report.finishedAt=new Date().toISOString();report.verifiedCarts=report.attempts.filter((a:any)=>a.cartVerified).length;report.checkoutReady=report.attempts.filter((a:any)=>a.checkoutReady).length;save();if(session)await client.sessions.release(session.id).catch(()=>{});if(browser)await bounded(browser.close(),5000,'release browser').catch(()=>{});console.log(`Trial report: ${reportPath}`);}
