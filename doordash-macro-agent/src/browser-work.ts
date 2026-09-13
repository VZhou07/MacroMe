import type { Browser, BrowserContext, Page } from 'playwright-core';

export class BrowserUnavailableError extends Error {}
export class PageWorkError extends Error {
  constructor(public phase: string, detail: string) { super(`${phase}: ${detail}`); }
}

export const errorLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0];

/** Also bounds CDP operations which do not have a Playwright timeout option. */
export async function bounded<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageWorkError(phase, 'time budget exceeded')), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export function assertConnected(browser: Browser | null): void {
  if (browser && !browser.isConnected()) {
    throw new BrowserUnavailableError('Steel browser disconnected or session expired. Start a new run; no further browser actions will be attempted.');
  }
}

export async function closePage(page: Page, phase: string): Promise<void> {
  if (page.isClosed()) return;
  try {
    await bounded(page.close({ runBeforeUnload: false }), 3000, `${phase} / close tab`);
  } catch (error) {
    if (!page.isClosed()) {
      // Continuing with an unresponsive tab can accumulate work and exhaust RAM.
      throw new BrowserUnavailableError(`${phase}: could not close the browser tab. Stopping this session to avoid leaving a hung tab.`);
    }
  }
}

/** Retry only navigation/readiness, never a cart mutation or Place Order. */
export async function navigate(page: Page, url: string, selector: string, phase: string,
  options: { attemptMs?: number; backoffMs?: number } = {}): Promise<void> {
  const browser = page.context().browser();
  const attemptMs = options.attemptMs ?? 15000;
  let failure: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    assertConnected(browser);
    if (page.isClosed()) throw new PageWorkError(phase, 'tab closed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    try {
      await bounded((async () => {
        // Commit avoids waiting for slow third-party resources. Readiness is
        // established by the actual store/search selector, not a load event.
        await page.goto(url, { waitUntil: 'commit', timeout: Math.min(10000, attemptMs), signal: controller.signal });
        if (await page.getByText(/session ended/i).first().isVisible()) {
          throw new BrowserUnavailableError(`${phase}: Steel reports that the session ended. Start a new run.`);
        }
        await page.waitForSelector(selector, { state: 'attached', timeout: Math.min(5000, attemptMs), signal: controller.signal });
      })(), attemptMs, phase);
      return;
    } catch (error) {
      assertConnected(browser);
      if (error instanceof BrowserUnavailableError || page.isClosed()) throw error;
      failure = error;
      console.log(`[browser] ${phase} / navigation ${attempt}/2: ${errorLine(error)}`);
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, options.backoffMs ?? 500));
  }
  throw new PageWorkError(phase, `navigation/readiness failed after 2 attempts (${errorLine(failure)})`);
}

/** Release the overall run on expiry/disconnect, including during human approval. */
export async function whileSessionLive<T>(browser: Browser, expiresAt: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertConnected(browser);
  if (expiresAt <= Date.now()) throw new BrowserUnavailableError('Steel session expired. Start a new run.');
  const controller = new AbortController();
  let disconnected: () => void;
  const lost = new Promise<never>((_, reject) => {
    disconnected = () => reject(new BrowserUnavailableError('Steel browser disconnected or session expired. Start a new run.'));
    browser.once('disconnected', disconnected);
  });
  try {
    return await bounded(Promise.race([work(controller.signal), lost]), expiresAt - Date.now(), 'Steel session lifetime');
  } finally {
    controller.abort();
    browser.off('disconnected', disconnected!);
  }
}

/** A scrape owns its tab: timeout/crash always reaches bounded cleanup. */
export async function withStorePage<T>(context: BrowserContext, phase: string, milliseconds: number,
  work: (page: Page) => Promise<T>): Promise<T> {
  assertConnected(context.browser());
  const deadline = Date.now() + milliseconds;
  let page: Page;
  try {
    page = await bounded(context.newPage(), Math.min(milliseconds, 10000), `${phase} / open tab`);
  } catch (error) {
    // A late newPage response cannot be safely assigned to another scrape.
    // The caller must release the session, including any late-created tab.
    throw new BrowserUnavailableError(`${phase} / open tab: ${errorLine(error)}`);
  }
  let crashed: () => void;
  const crash = new Promise<never>((_, reject) => {
    crashed = () => reject(new PageWorkError(phase, 'tab crashed (possible memory pressure)'));
    page.once('crash', crashed);
  });
  try {
    if (Date.now() >= deadline) throw new PageWorkError(phase, 'time budget exceeded before navigation');
    return await bounded(Promise.race([work(page), crash]), deadline - Date.now(), `${phase} / scrape`);
  } finally {
    page.off('crash', crashed!);
    await closePage(page, phase);
  }
}
