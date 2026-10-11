import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

declare const KeyboardHandler: { _scheduleViewportSettle: (opts: { restoreScroll: boolean }) => void };
declare const _crashDiag: { _entries: string[] };

describe('mobile scrolling across viewport settle and terminal recovery', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
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
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    });
    await page.route('**/api/sessions/lifecycle-probe/terminal?*', (route) =>
      route.fulfill({
        json: { success: true, data: { terminalBuffer: history(210), source: 'mux-full-history', truncated: false } },
      })
    );
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.evaluate(async (text) => {
      const app = (window as any).app;
      app.activeSessionId = 'lifecycle-probe';
      app.sessions.set(app.activeSessionId, { id: app.activeSessionId, mode: 'claude', pid: 1 });
      app.hideMobileOverview();
      app.sendResize = async () => false;
      app._lastResizeDims = { cols: 40, rows: 20 };
      // Keep the geometry fixed to isolate the scroll decision from real OS sizing.
      app.syncTerminalGeometry = () => ({ cols: 40, rows: 20 });
      app.pendingWrites = [];
      app.terminal.reset();
      app.terminal.options.scrollback = 1000;
      app.terminal.resize(40, 20);
      await new Promise<void>((resolve) => app.terminal.write(text, resolve));
      app.terminal.scrollToLine(30);
    }, history(200));
  });

  const snapshot = () =>
    page.evaluate(() => {
      const b = (window as any).app.terminal.buffer.active;
      return { row: b.viewportY, base: b.baseY, top: b.getLine(b.viewportY)?.translateToString(true) };
    });
  const swipeUp = () =>
    page.evaluate(() => {
      const container = document.getElementById('terminalContainer')!;
      const rect = container.getBoundingClientRect();
      const dispatch = (type: string, y: number) => {
        const touch = new Touch({ identifier: 1, target: container, clientX: rect.left + 50, clientY: y });
        container.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchcancel' ? [] : [touch],
            changedTouches: [touch],
          })
        );
      };
      dispatch('touchstart', rect.top + 80);
      dispatch('touchmove', rect.top + 140);
      dispatch('touchcancel', rect.top + 140);
    });

  it.each(['bottom', 'history'])('keeps a newer touch drag when keyboard settling started at %s', async (start) => {
    await page.evaluate((start) => {
      const app = (window as any).app;
      if (start === 'bottom') app.terminal.scrollToBottom();
      KeyboardHandler._scheduleViewportSettle({ restoreScroll: true });
    }, start);
    const before = await snapshot();
    await swipeUp();
    const dragged = await snapshot();
    expect(dragged.row).toBeLessThan(before.row);
    await page.waitForTimeout(400);
    const settled = await snapshot();
    console.log('keyboard settle versus touch', { start, before, dragged, settled });
    expect(settled.top).toBe(dragged.top);
  });

  it('holds the same text when a recovery capture includes new output', async () => {
    const before = await snapshot();
    await page.evaluate(() => (window as any).app._onSessionNeedsRefresh({ id: 'lifecycle-probe' }));
    const after = await snapshot();
    console.log('recovery with new output', { before, after });
    expect(after.top).toBe(before.top);
  });

  it('holds the same text when loading more history includes new output', async () => {
    await page.evaluate(() => (window as any).app.terminal.scrollToTop());
    const before = await snapshot();
    await page.evaluate(() => (window as any).app._maybeRefetchFullHistory({ force: true }));
    const after = await snapshot();
    console.log('history pull with new output', { before, after });
    expect(after.top).toBe(before.top);
  });

  it('keeps trimmed history stationary after the browser paints queued viewport updates', async () => {
    const before = await page.evaluate(async () => {
      const app = (window as any).app;
      app.terminal.reset();
      app.terminal.options.scrollback = 100;
      await new Promise<void>((resolve) =>
        app.terminal.write(Array.from({ length: 140 }, (_, i) => `history ${i}\r\n`).join(''), resolve)
      );
      app.terminal.scrollToLine(30);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return app.terminal.buffer.active.getLine(app.terminal.buffer.active.viewportY).translateToString(true);
    });
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.batchTerminalWrite('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const after = await snapshot();
    console.log('scrollback trim after paint', { before, after });
    expect(after.top).toBe(before);
  });

  it('holds the same text when output trims scrollback during keyboard settling', async () => {
    await page.evaluate(async (text) => {
      const app = (window as any).app;
      app.terminal.reset();
      app.terminal.options.scrollback = 100;
      await new Promise<void>((resolve) => app.terminal.write(text, resolve));
      app.terminal.scrollToLine(30);
      KeyboardHandler._scheduleViewportSettle({ restoreScroll: true });
      app.batchTerminalWrite('new output\r\n'.repeat(10));
      app.flushPendingWrites();
    }, history(140));
    await page.waitForTimeout(400);
    expect((await snapshot()).top).toBe('history 51');
    expect(await page.evaluate(() => (window as any).app.terminal.markers.length)).toBe(0);
  });

  it('keeps a replay restore when it overlaps a pending keyboard settle', async () => {
    await page.evaluate(async () => {
      KeyboardHandler._scheduleViewportSettle({ restoreScroll: true });
      await (window as any).app._onSessionNeedsRefresh({ id: 'lifecycle-probe' });
    });
    await page.waitForTimeout(400);
    expect((await snapshot()).top).toBe('history 30');
    expect(await page.evaluate(() => (window as any).app.terminal.markers.length)).toBe(0);
  });

  it('records an incorrectly applied local drag when the viewport scroll model is stale', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      const viewport = app.terminal._core._viewport;
      // Fault injection for diagnostics, not a claim that this is the phone's
      // cause: preserve the buffer but give the viewport no scrollable range.
      viewport._suppressOnScrollHandler = true;
      try {
        const height = app.terminal._core._renderService.dimensions.css.canvas.height;
        viewport._scrollableElement.setScrollDimensions({ height, scrollHeight: height });
        viewport._scrollableElement.setScrollPosition({ scrollTop: 0 });
      } finally {
        viewport._suppressOnScrollHandler = false;
      }
    });
    const before = await snapshot();
    await swipeUp();
    // A stale model may refuse the gesture or overshoot to its own row zero.
    // Either mismatch should be reported, without asserting a phone cause.
    expect((await snapshot()).row).not.toBe(before.row - 4);
    const diagnostics = await page.evaluate(() => _crashDiag._entries.filter((line) => line.includes('SCROLL STALL:')));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('lifecycle-probe');
    expect(diagnostics[0]).not.toContain('history');
  });

  it.each(['claude', 'codex'])(
    'accepts native Chromium touch scrolling after repeated %s terminal replays',
    async (mode) => {
      await page.evaluate((mode) => ((window as any).app.sessions.get('lifecycle-probe').mode = mode), mode);
      const cdp = await page.context().newCDPSession(page);
      for (let replay = 0; replay < 3; replay++) {
        await page.evaluate(
          async (text) => {
            const app = (window as any).app;
            app._resetTerminalForReplay();
            await new Promise<void>((resolve) => app.terminal.write(text, resolve));
            app.terminal.scrollToBottom();
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          },
          history(200 + replay * 20)
        );
        const before = await snapshot();
        const point = await page.locator('.xterm-screen').boundingBox();
        expect(point).not.toBeNull();
        const x = point!.x + 60;
        const y = point!.y + 60;
        expect(
          await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#terminalContainer'), { x, y })
        ).toBe(true);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 5; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 18 }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await page.waitForTimeout(200);
        const after = await snapshot();
        expect(after.row, `replay ${replay}: ${JSON.stringify({ before, after })}`).toBeLessThan(before.row);
      }
      await cdp.detach();
    }
  );
});
