import 'dotenv/config';
import Steel from 'steel-sdk';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { goToCheckout } from '../src/doordash.js';

const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
const storeUrl = process.argv.find((arg) => arg.startsWith('https://www.doordash.com/store/'));
if (!storeUrl) throw new Error('Usage: node --import tsx scripts/inspect-cart.ts https://www.doordash.com/store/STORE_ID/ [--drawer]');
const session = await client.sessions.create({ profileId: process.env.STEEL_PROFILE_ID, persistProfile: false, timeout: 180000 });
let browser;
try {
  browser = await chromium.connectOverCDP(session.websocketUrl);
  const page = browser.contexts()[0].pages()[0];
  await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(4000);
  const checkout = await goToCheckout(page).catch((error) => console.log(String(error).split('\n')[0]));
  if (checkout) console.log(JSON.stringify(checkout));
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/checkout-dom.html', await page.content());
  writeFileSync('reports/checkout-text.txt', await page.locator('body').innerText());
  if (process.argv.includes('--drawer')) {
    await page.getByRole('link', { name: 'Back to Store' }).click();
    await page.waitForTimeout(4000);
    await page.locator('[data-testid="OrderCartIconButton"]').click();
    await page.locator('[data-testid="CheckoutButton"]').waitFor({ timeout: 15000 });
    writeFileSync('reports/cart-dom.html', await page.content());
  }
  console.log('Saved read-only checkout diagnostics under reports/. No items added or removed.');
} finally {
  await browser?.close().catch(() => {});
  await client.sessions.release(session.id).catch(() => {});
}
