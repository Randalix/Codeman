import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

/**
 * Unlocking a phone or laptop after a lot of output: the page comes back with a
 * stale stream, and the session already on screen catches up — through the
 * reconnect refresh (`_onSessionNeedsRefresh`, path A) or, when the socket stayed
 * up, through the backlog queued while the page was hidden (path B). Either way
 * the catch-up must not be watched scrolling to the end.
 */
describe('catching up after unlock hides the scroll to the end', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  const buffers = new Map<string, string>();
  const history = (name: string, count = 200) =>
    Array.from({ length: count }, (_, i) => `${name} history ${i}\r\n`).join('');

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
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/api/sessions/unlock-scroll-*/terminal?*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      return route.fulfill({
        json: {
          success: true,
          data: { terminalBuffer: buffers.get(id), source: 'mux-full-history', truncated: false },
        },
      });
    });
    buffers.set('unlock-scroll-a', history('A'));
    buffers.set('unlock-scroll-b', history('B'));
    await page.goto(`http://localhost:${server.boundPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.evaluate(() => {
      const app = (window as any).app;
      app._connectWs = () => {};
      app.sendResize = async () => false;
      app._updateSseSubscription = () => {};
      app._refreshSessionPanels = () => {};
      app.markIdleAlertSeen = () => {};
      app.sessions.clear();
      app.activeSessionId = null;
      app.sessionOrder = ['unlock-scroll-a', 'unlock-scroll-b'];
      for (const id of app.sessionOrder)
        app.sessions.set(id, { id, name: id, mode: 'codex', status: 'idle', pid: 1, workingDir: '/tmp' });
    });
  });

  const select = (id: string) => page.evaluate((id) => (window as any).app.selectSession(id), id);
  const snapshot = () =>
    page.evaluate(() => {
      const buf = (window as any).app.terminal.buffer.active;
      return { row: buf.viewportY, baseY: buf.baseY, top: buf.getLine(buf.viewportY)?.translateToString(true) };
    });
  /** Record every viewport move from now on, with the terminal's opacity at that moment. */
  const recordScrolls = () =>
    page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__scrolls = [];
      (window as any).__scrollSub?.dispose();
      (window as any).__scrollSub = app.terminal.onScroll(() =>
        (window as any).__scrolls.push(getComputedStyle(app.terminal.element).opacity)
      );
    });
  const recorded = () =>
    page.evaluate(() => ({
      scrolls: (window as any).__scrolls as string[],
      opacity: getComputedStyle((window as any).app.terminal.element).opacity,
    }));

  describe('path A: the reconnect refresh of the session on screen', () => {
    it.each(['codex', 'claude', 'shell'])('rewrites a %s session at the bottom out of sight', async (mode) => {
      await page.evaluate((mode) => {
        (window as any).app.sessions.get('unlock-scroll-a').mode = mode;
      }, mode);
      await select('unlock-scroll-a');
      buffers.set('unlock-scroll-a', history('A', 400));
      await recordScrolls();
      expect(await page.evaluate(() => (window as any).app._onSessionNeedsRefresh({ id: 'unlock-scroll-a' }))).toBe(
        true
      );

      const after = await snapshot();
      expect(after.row).toBe(after.baseY);
      expect(after.top).not.toContain('A history 1 ');
      const { scrolls, opacity } = await recorded();
      expect(scrolls.length).toBeGreaterThan(0);
      expect(scrolls.filter((o) => o !== '0')).toEqual([]);
      expect(opacity).toBe('1');
    });

    it('keeps the reading position while hiding the rewrite', async () => {
      await select('unlock-scroll-a');
      await page.evaluate(() => (window as any).app.terminal.scrollToLine(30));
      const before = await snapshot();
      buffers.set('unlock-scroll-a', history('A', 210));
      await recordScrolls();
      await page.evaluate(() => (window as any).app._onSessionNeedsRefresh({ id: 'unlock-scroll-a' }));

      expect((await snapshot()).top).toBe(before.top);
      const { scrolls, opacity } = await recorded();
      expect(scrolls.filter((o) => o !== '0')).toEqual([]);
      expect(opacity).toBe('1');
    });

    it('keeps the old content readable while the capture loads', async () => {
      await select('unlock-scroll-a');
      await page.evaluate(() => {
        const app = (window as any).app;
        const fetchCapture = app._fetchTerminalCapture.bind(app);
        app._fetchTerminalCapture = async (...args: unknown[]) => {
          await new Promise<void>((resolve) => {
            (window as any).__continueCapture = resolve;
          });
          return fetchCapture(...args);
        };
        (window as any).__refresh = app._onSessionNeedsRefresh({ id: 'unlock-scroll-a' });
      });
      await page.waitForFunction(() => !!(window as any).__continueCapture);
      expect((await recorded()).opacity).toBe('1');
      await page.evaluate(() => {
        (window as any).__continueCapture();
        return (window as any).__refresh;
      });
      expect((await recorded()).opacity).toBe('1');
    });

    it('shows the terminal again when the rewrite fails', async () => {
      await select('unlock-scroll-a');
      await page.evaluate(() => {
        (window as any).app.chunkedTerminalWrite = async () => {
          throw new Error('write failed');
        };
      });
      await page.evaluate(() => (window as any).app._onSessionNeedsRefresh({ id: 'unlock-scroll-a' }));
      expect((await recorded()).opacity).toBe('1');
    });

    it('leaves a tab switch during the rewrite in charge of its own reveal', async () => {
      await select('unlock-scroll-a');
      await page.evaluate(() => {
        const app = (window as any).app;
        const write = app.chunkedTerminalWrite.bind(app);
        (window as any).__write = app.chunkedTerminalWrite;
        app.chunkedTerminalWrite = async (...args: unknown[]) => {
          await new Promise<void>((resolve) => {
            (window as any).__continueWrite = resolve;
          });
          return write(...args);
        };
        (window as any).__refresh = app._onSessionNeedsRefresh({ id: 'unlock-scroll-a' });
      });
      await page.waitForFunction(() => !!(window as any).__continueWrite);
      // The tab switch takes over while A's rewrite is parked mid-flight; holding
      // B's capture keeps B's own replay hidden while A's refresh finishes.
      await page.evaluate(() => {
        const app = (window as any).app;
        const fetchCapture = app._fetchTerminalCapture.bind(app);
        app.chunkedTerminalWrite = (window as any).__write;
        app._fetchTerminalCapture = async (...args: unknown[]) => {
          await new Promise<void>((resolve) => {
            (window as any).__continueCapture = resolve;
          });
          return fetchCapture(...args);
        };
        (window as any).__select = app.selectSession('unlock-scroll-b');
      });
      await page.waitForFunction(() => !!(window as any).__continueCapture);
      await page.evaluate(() => {
        (window as any).__continueWrite();
        return (window as any).__refresh;
      });
      expect((await recorded()).opacity).toBe('0');
      await page.evaluate(() => {
        (window as any).__continueCapture();
        return (window as any).__select;
      });
      expect((await recorded()).opacity).toBe('1');
    });
  });

  describe('path B: the backlog queued while the page was hidden', () => {
    const queueBacklog = (lines: number) =>
      page.evaluate((lines) => {
        const app = (window as any).app;
        const text = Array.from({ length: lines }, (_, i) => `backlog ${i} ${'x'.repeat(10)}\r\n`).join('');
        app.pendingWrites.push(text);
      }, lines);
    const drain = () =>
      page.waitForFunction(() => {
        const app = (window as any).app;
        return app.pendingWrites.length === 0 && !app._terminalWriteInFlight;
      });
    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);

    it('drains a multi-frame backlog out of sight when the page comes back', async () => {
      await select('unlock-scroll-a');
      await setVisibility('hidden');
      await queueBacklog(4000);
      await recordScrolls();
      await setVisibility('visible');
      await page.evaluate(() => (window as any).app._scheduleTerminalWriteFlush());
      await drain();

      const after = await snapshot();
      expect(after.row).toBe(after.baseY);
      expect(after.top).toContain('backlog');
      const { scrolls, opacity } = await recorded();
      expect(scrolls.length).toBeGreaterThan(0);
      expect(scrolls.filter((o) => o !== '0')).toEqual([]);
      expect(opacity).toBe('1');
    });

    it('still follows ordinary live output at the bottom in plain sight', async () => {
      await select('unlock-scroll-a');
      await queueBacklog(4000);
      await recordScrolls();
      await page.evaluate(() => (window as any).app._scheduleTerminalWriteFlush());
      await drain();
      const { scrolls } = await recorded();
      expect(scrolls.length).toBeGreaterThan(0);
      expect(scrolls.every((o) => o === '1')).toBe(true);
    });
  });
});
