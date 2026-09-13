import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { bounded, BrowserUnavailableError, navigate, withStorePage, whileSessionLive } from '../src/browser-work.ts';

function browserPage() {
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true });
  let closed = false;
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => closed,
    close: async () => { closed = true; },
    context: () => ({ browser: () => browser }),
    goto: async (_url: string, _options: any) => null,
    waitForSelector: async () => ({}),
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
  });
  const context = { browser: () => browser, newPage: async () => page };
  return { browser: browser as unknown as Browser, page, context: context as unknown as BrowserContext };
}

test('navigation retries once with commit and then checks actual readiness', async () => {
  const { page } = browserPage();
  let attempts = 0;
  page.goto = async (_, options) => { assert.equal(options.waitUntil, 'commit'); assert.ok(options.signal); if (++attempts === 1) throw new Error('page.goto: Timeout 30000ms exceeded'); return null; };
  await navigate(page as unknown as Page, 'https://example.com', '.menu', 'Pantry / menu', { backoffMs: 0 });
  assert.equal(attempts, 2);
});

test('hung navigation is bounded and reports a skippable store/phase error', async () => {
  const { page } = browserPage();
  page.goto = () => new Promise(() => {});
  await assert.rejects(navigate(page as unknown as Page, 'https://example.com', '.menu', 'Pantry / menu', { attemptMs: 5, backoffMs: 0 }), /Pantry \/ menu: navigation\/readiness failed after 2 attempts/);
});

test('one hung store closes its tab and the following store can succeed', async () => {
  const slow = browserPage();
  await assert.rejects(withStorePage(slow.context, 'Pantry / menu', 5, () => new Promise(() => {})), /time budget exceeded/);
  assert.equal(slow.page.isClosed(), true);
  const next = browserPage();
  assert.equal(await withStorePage(next.context, 'Kitchen / menu', 50, async () => 'usable menu'), 'usable menu');
  assert.equal(next.page.isClosed(), true);
});

test('tab crash aborts the scrape and closes the crashed tab', async () => {
  const f = browserPage();
  await assert.rejects(withStorePage(f.context, 'Pantry / menu', 50, async () => {
    f.page.emit('crash');
    return new Promise(() => {});
  }), /tab crashed/);
  assert.equal(f.page.isClosed(), true);
});

test('disconnected browser and ended session are fatal rather than navigation retries', async () => {
  const f = browserPage();
  f.browser.isConnected = () => false;
  await assert.rejects(navigate(f.page as unknown as Page, '', '.menu', 'Pantry / menu'), BrowserUnavailableError);
  const g = browserPage();
  g.page.getByText = () => ({ first: () => ({ isVisible: async () => true }) });
  await assert.rejects(navigate(g.page as unknown as Page, '', '.menu', 'Pantry / menu'), /session ended/);
});

test('session fence stops a hung approval on disconnect or expiry and removes listeners', async () => {
  const { browser } = browserPage();
  await assert.rejects(whileSessionLive(browser, Date.now() + 100, async () => {
    browser.emit('disconnected', browser);
    return new Promise(() => {});
  }), /disconnected/);
  assert.equal(browser.listenerCount('disconnected'), 0);
  await assert.rejects(whileSessionLive(browser, Date.now() + 5, () => new Promise(() => {})), /Steel session lifetime/);
  assert.equal(browser.listenerCount('disconnected'), 0);
});

test('a bounded successful operation clears its timeout', async () => {
  assert.equal(await bounded(Promise.resolve('done'), 10000, 'test'), 'done');
});
