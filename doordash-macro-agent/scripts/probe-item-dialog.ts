import 'dotenv/config';
import Steel from 'steel-sdk';
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { scrapeMenu } from '../src/doordash.js';
import { navigate, bounded } from '../src/browser-work.js';
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
const pick=report.candidates[Number(process.argv[3]??1)];
const client=new Steel({steelAPIKey:process.env.STEEL_API_KEY,timeout:20000,maxRetries:0});
let session:any,browser:any;
try{
 session=await client.sessions.create({profileId:process.env.STEEL_PROFILE_ID,persistProfile:false,timeout:240000});
 browser=await chromium.connectOverCDP(session.websocketUrl,{timeout:20000});
 const page=await browser.contexts()[0].newPage();
 if(process.argv.includes('--menu')) {
   const menu=await scrapeMenu(page,{name:pick.restaurant,url:pick.storeUrl},50);
   writeFileSync('reports/customizable-menu.json',JSON.stringify(menu,null,2));
   console.log(JSON.stringify(menu.items.map(item=>({id:item.id,name:item.name,price:item.price}))));
 }
 await navigate(page,pick.storeUrl,['[data-testid="storeInfo"]','[data-testid="MenuItem"]'],'read-only item probe',{attemptMs:35000});
 const card=page.locator(`[data-testid="MenuItem"][data-item-id="${pick.itemId}"]`);
 for(let i=0;i<30&&await card.count()===0;i++){await page.mouse.wheel(0,1000);await page.waitForTimeout(400);}
 await card.locator('[role="button"]').first().click({timeout:10000});
 await page.locator('[data-testid^="AddToCartButton"]').first().waitFor({timeout:10000});
 await page.waitForTimeout(2500);
 const evidence=await page.evaluate(()=>{
   const root=document.querySelector('[data-testid^="AddToCartButton"]')?.closest('[role="dialog"], [aria-modal="true"]');
   if(!root)return {error:'no dialog'};
   const clone=root.cloneNode(true) as Element;
   clone.querySelectorAll('script,style,svg,img,picture,link').forEach(el=>el.remove());
   for(const el of [clone,...clone.querySelectorAll('*')])for(const attr of [...el.attributes])if(!/^(role|type|name|for|id|disabled|checked|selected|aria-.+|data-testid|data-state|data-selected)$/.test(attr.name))el.removeAttribute(attr.name);
   return {text:(root as HTMLElement).innerText,html:clone.outerHTML,controls:[...root.querySelectorAll('input,label,[role="radio"],[role="checkbox"]')].map(el=>({tag:el.tagName,type:el.getAttribute('type'),role:el.getAttribute('role'),display:getComputedStyle(el).display,rects:el.getClientRects().length,parentTag:el.parentElement?.tagName,parentRole:el.parentElement?.getAttribute('role')}))};
 });
 writeFileSync('reports/item-dialog-probe.json',JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({item:pick.item,controls:evidence.controls?.length,text:evidence.text?.slice(0,3500)}));
} catch(error){console.log(String(error).split('\n')[0]);}
finally{if(session)await client.sessions.release(session.id).catch(()=>{});if(browser)await bounded(browser.close(),5000,'probe close').catch(()=>{});}
