// A window resize at the live bottom clears xterm's scrollback (`\x1b[3J`, against
// reflow ghost renders) and sends the new size, after which tmux repaints only
// the visible screen. Nothing reloaded the history: the scrollbar vanished, the
// wheel had nothing to scroll (`baseY` 0 routes it to the CLI as page keys) and
// stayed dead until a tab switch or enough new output. The resize must bring the
// history back from the server once the TUI has redrawn.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

describe('scrollback across a window resize', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let fetches: string[];
  const history = (count: number) => Array.from({ length: count }, (_, i) => `history ${i}\r\n`).join('');

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await page?.close();
    fetches = [];
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route('**/api/sessions/resize-probe/terminal?*', (route) => {
      fetches.push(route.request().url());
      return route.fulfill({
        json: { success: true, data: { terminalBuffer: history(300), source: 'mux-full-history', truncated: false } },
      });
    });
    await page.route('**/api/sessions/resize-probe/resize', (route) =>
      route.fulfill({ json: { success: true, data: {} } })
    );
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.evaluate(async (text) => {
      const app = (window as any).app;
      app.activeSessionId = 'resize-probe';
      app.sessions.set(app.activeSessionId, { id: app.activeSessionId, mode: 'claude', pid: 1 });
      app.pendingWrites = [];
      app.terminal.reset();
      app.terminal.options.scrollback = 1000;
      await new Promise<void>((resolve) => app.terminal.write(text, resolve));
      app.terminal.scrollToBottom();
      app._lastResizeDims = { cols: app.terminal.cols, rows: app.terminal.rows };
    }, history(300));
  });

  const snapshot = () =>
    page.evaluate(() => {
      const b = (window as any).app.terminal.buffer.active;
      return { base: b.baseY, top: b.getLine(0)?.translateToString(true) };
    });

  it('reloads the history a resize at the bottom cleared', async () => {
    expect((await snapshot()).base).toBeGreaterThan(200);
    await page.setViewportSize({ width: 1200, height: 700 });
    // The 300 ms trailing debounce clears the scrollback...
    await page.waitForFunction(() => (window as any).app.terminal.buffer.active.baseY === 0, null, {
      timeout: 5000,
    });
    // ...and after the TUI redraw grace the reload has to bring it back.
    await page.waitForFunction(() => (window as any).app.terminal.buffer.active.baseY > 200, null, {
      timeout: 8000,
    });
    const after = await snapshot();
    expect(after.top).toBe('history 0');
    expect(fetches).toHaveLength(1);
  });

  it('reloads once for a burst of resizes', async () => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForTimeout(350);
    await page.setViewportSize({ width: 1200, height: 650 });
    await page.waitForFunction(() => (window as any).app.terminal.buffer.active.baseY > 200, null, {
      timeout: 8000,
    });
    await page.waitForTimeout(800);
    expect(fetches).toHaveLength(1);
  });

  it('does not reload into a tab selected meanwhile', async () => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForTimeout(350); // the debounce has fired and cleared
    await page.evaluate(() => {
      const app = (window as any).app;
      app.activeSessionId = 'other-tab';
    });
    await page.waitForTimeout(1200);
    expect(fetches).toHaveLength(0);
  });

  it('leaves a reader in history alone (nothing was cleared)', async () => {
    await page.evaluate(() => (window as any).app.terminal.scrollToLine(50));
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForTimeout(1200);
    expect(fetches).toHaveLength(0);
    expect((await snapshot()).base).toBeGreaterThan(200);
  });
});
