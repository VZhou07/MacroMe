import 'dotenv/config';
import Steel from 'steel-sdk';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectCart, clearCart } from '../src/doordash.js';
import { bounded, closePage, navigate } from '../src/browser-work.js';
const file=process.argv[2];
const prior=JSON.parse(readFileSync(file,'utf8'));
const pick=prior.candidates.find((candidate:any)=>candidate.restaurant===prior.attempts.at(-1)?.restaurant) ?? prior.candidates[0];
const client=new Steel({steelAPIKey:process.env.STEEL_API_KEY,timeout:20000,maxRetries:0});
let session:any,browser:any,page:any;
const evidence:any={startedAt:new Date().toISOString(),restaurant:pick.restaurant,cleared:false};
try{
  session=await client.sessions.create({profileId:process.env.STEEL_PROFILE_ID,persistProfile:false,timeout:300000});
  browser=await chromium.connectOverCDP(session.websocketUrl,{timeout:20000});
  const context=browser.contexts()[0];
  page=await context.newPage();
  await navigate(page,pick.storeUrl,['[data-testid="storeInfo"]','[data-testid="MenuItem"]'],'trial reconciliation',{attemptMs:35000});
  const cart=await bounded(inspectCart(page),45000,'reconcile previous trial');
  if(!cart)throw Error('Cart unreadable');
  evidence.cart=cart;
  if(cart.cartItems.length)await clearCart(page,cart);evidence.cleared=true;
}catch(error){evidence.reason=String(error).split('\n').filter(line => !/https?:/.test(line)).slice(0,8).join('\n');}
finally{
  if(page)await closePage(page,'reconcile cleanup').catch(()=>{});
  if(session)await client.sessions.release(session.id).catch(()=>{});
  await browser?.close().catch(()=>{});
  writeFileSync(file.replace('.json',`-reconciliation-${evidence.startedAt.replace(/[:.]/g,'-')}.json`),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}
