import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';
import { showKeyboardViaCDP } from './helpers/keyboard-sim.js';

declare const KeyboardHandler: { _scheduleViewportSettle: (opts: { restoreScroll: boolean }) => void };

describe('terminal scroll-to-bottom control', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

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
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.activeSessionId = 'bottom-probe';
      app.sessions.set(app.activeSessionId, { id: app.activeSessionId, mode: 'claude', pid: 1 });
      app.hideMobileOverview();
      app.sendResize = async () => false;
      app.syncTerminalGeometry = () => ({ cols: 40, rows: 20 });
      app.pendingWrites = [];
      app.terminal.reset();
      app.terminal.resize(40, 20);
      await new Promise<void>((resolve) =>
        app.terminal.write(Array.from({ length: 200 }, (_, i) => `history ${i}\r\n`).join(''), resolve)
      );
      app.terminal.scrollToBottom();
      app._syncStickyScrollBaseline();
    });
  });

  const button = () => page.getByRole('button', { name: 'Scroll to bottom', exact: true });
  const scrollUp = () => page.evaluate(() => (window as any).app.terminal.scrollLines(-10));
  const snapshot = () =>
    page.evaluate(() => {
      const app = (window as any).app;
      const b = app.terminal.buffer.active;
      return { row: b.viewportY, base: b.baseY, top: b.getLine(b.viewportY)?.translateToString(true) };
    });
  const output = () =>
    page.evaluate(async () => {
      const app = (window as any).app;
      app.batchTerminalWrite('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });

  it.each(['claude', 'codex', 'shell'])(
    'holds reading position and resumes following after a tap in %s',
    async (mode) => {
      await page.evaluate((mode) => ((window as any).app.sessions.get('bottom-probe').mode = mode), mode);
      expect(await button().count()).toBe(0);
      await scrollUp();
      await button().waitFor({ state: 'visible' });
      const reading = await snapshot();
      await output();
      expect((await snapshot()).top).toBe(reading.top);
      await button().tap();
      const bottom = await snapshot();
      expect(bottom.row).toBe(bottom.base);
      expect(await button().count()).toBe(0);
      await output();
      const followed = await snapshot();
      expect(followed.row).toBe(followed.base);
      expect(followed.base).toBeGreaterThan(bottom.base);
    }
  );

  it.each([false, true])('preserves terminal input focus on touch (previously focused: %s)', async (focused) => {
    await scrollUp();
    if (focused) await page.evaluate(() => (window as any).app.terminal.focus());
    else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    const before = await page.evaluate(() => document.activeElement?.className);
    await button().tap();
    expect(await page.evaluate(() => document.activeElement?.className)).toBe(before);
    expect((await snapshot()).row).toBe((await snapshot()).base);
  });

  it('stays at bottom when touch and wheel momentum were still running', async () => {
    const cdp = await page.context().newCDPSession(page);
    const rect = (await page.locator('.xterm-screen').boundingBox())!;
    const x = rect.x + 50,
      y = rect.y + 50;
    expect(
      await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#terminalContainer'), { x, y })
    ).toBe(true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 15 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect((await snapshot()).row).toBeLessThan((await snapshot()).base);
    await page.evaluate(() => (window as any).app._smoothScrollBy(-100));
    await button().tap();
    await page.waitForTimeout(400);
    expect((await snapshot()).row).toBe((await snapshot()).base);
    await output();
    expect((await snapshot()).row).toBe((await snapshot()).base);
    await cdp.detach();
  });

  it('wins over a keyboard settle started while reading history', async () => {
    await scrollUp();
    await page.evaluate(() => KeyboardHandler._scheduleViewportSettle({ restoreScroll: true }));
    await button().tap();
    await page.waitForTimeout(400);
    expect((await snapshot()).row).toBe((await snapshot()).base);
    expect(await button().count()).toBe(0);
  });

  it('remains reachable above an open keyboard and leaves it open', async () => {
    await page.evaluate(() => (window as any).app.terminal.focus());
    expect(await showKeyboardViaCDP(page, 300)).toBe(true);
    await scrollUp();
    await button().waitFor({ state: 'visible' });
    const box = (await button().boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(544);
    await button().tap();
    expect(await page.evaluate(() => document.body.classList.contains('keyboard-visible'))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    expect((await snapshot()).row).toBe((await snapshot()).base);
  });

  it('is hidden during tab replay and in the alternate buffer', async () => {
    await scrollUp();
    await button().waitFor({ state: 'visible' });
    await page.evaluate(() => {
      const app = (window as any).app;
      app._setTerminalLoadState(app.activeSessionId, app._selectGeneration, 'fetching');
    });
    expect(await button().count()).toBe(0);
    await page.evaluate(() => {
      const app = (window as any).app;
      app._clearTerminalLoadState(app.activeSessionId, app._selectGeneration);
    });
    await button().waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      const app = (window as any).app;
      await new Promise<void>((resolve) => app.terminal.write('\x1b[?1049h', resolve));
    });
    await button().waitFor({ state: 'hidden' });
  });

  it('has a reachable 48px target inside the terminal and supports keyboard activation', async () => {
    await scrollUp();
    await button().waitFor({ state: 'visible' });
    const box = (await button().boundingBox())!;
    const wrap = (await page.locator('.terminal-wrap').boundingBox())!;
    expect(box.width).toBe(48);
    expect(box.height).toBe(48);
    expect(box.x + box.width).toBeLessThanOrEqual(wrap.x + wrap.width);
    expect(box.y + box.height).toBeLessThanOrEqual(wrap.y + wrap.height);
    expect(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.id, {
        x: box.x + 24,
        y: box.y + 24,
      })
    ).toBe('terminalScrollBottom');
    if (process.env.SCROLL_BOTTOM_CAPTURE_PATH) {
      await page.screenshot({ path: process.env.SCROLL_BOTTOM_CAPTURE_PATH });
    }
    await button().focus();
    await page.keyboard.press('Enter');
    expect((await snapshot()).row).toBe((await snapshot()).base);
  });
});
