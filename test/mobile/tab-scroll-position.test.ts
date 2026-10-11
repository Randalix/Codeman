import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

describe('session tabs hide intermediate replay scrolls', () => {
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
    // Each test gets its own tab caches and storage.
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/api/sessions/tab-scroll-*/terminal?*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      return route.fulfill({
        json: {
          success: true,
          data: {
            terminalBuffer: buffers.get(id),
            source: 'mux-full-history',
            truncated: false,
          },
        },
      });
    });
    buffers.set('tab-scroll-a', history('A'));
    buffers.set('tab-scroll-b', history('B'));
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
      app.sessionOrder = ['tab-scroll-a', 'tab-scroll-b'];
      for (const id of app.sessionOrder)
        app.sessions.set(id, {
          id,
          name: id,
          mode: 'codex',
          status: 'idle',
          pid: 1,
          workingDir: '/tmp',
        });
      (window as any).__replayScrolls = [];
      for (const [object, method] of [
        [app, '_resetTerminalForReplay'],
        [app, 'scrollToLastNonEmptyLine'],
        [app.terminal, 'scrollToBottom'],
      ]) {
        const original = object[method].bind(object);
        object[method] = (...args: unknown[]) => {
          (window as any).__replayScrolls.push({
            method,
            opacity: getComputedStyle(app.terminal.element).opacity,
          });
          return original(...args);
        };
      }
    });
  });

  const select = (id: string) => page.evaluate((id) => (window as any).app.selectSession(id), id);
  const snapshot = () =>
    page.evaluate(() => {
      const term = (window as any).app.terminal;
      const buf = term.buffer.active;
      return { row: buf.viewportY, baseY: buf.baseY, top: buf.getLine(buf.viewportY)?.translateToString(true) };
    });

  it.each(['codex', 'claude', 'shell'])('opens a %s tab at recent output with its replay hidden', async (mode) => {
    await page.evaluate((mode) => {
      (window as any).app.sessions.get('tab-scroll-a').mode = mode;
    }, mode);
    await select('tab-scroll-a');
    await page.evaluate(() => (window as any).app.terminal.scrollToLine(30));
    await select('tab-scroll-b');
    buffers.set('tab-scroll-a', history('A', 210));
    await select('tab-scroll-a');
    const after = await snapshot();
    expect(after.row).toBeGreaterThan(100);
    const rendering = await page.evaluate(() => ({
      replayScrolls: (window as any).__replayScrolls,
      opacity: getComputedStyle((window as any).app.terminal.element).opacity,
    }));
    expect(rendering.replayScrolls.length).toBeGreaterThan(0);
    expect(rendering.replayScrolls.every((entry: { opacity: string }) => entry.opacity === '0')).toBe(true);
    expect(rendering.opacity).toBe('1');
  });

  it('reveals a busy tab only after its fresh frame is loaded', async () => {
    await select('tab-scroll-a');
    await page.evaluate(() => (window as any).app.terminal.scrollToLine(40));
    await select('tab-scroll-b');
    await page.evaluate(() => {
      (window as any).app.sessions.get('tab-scroll-a').status = 'busy';
    });
    await select('tab-scroll-a');
    expect((await snapshot()).row).toBeGreaterThan(100);
    expect(
      await page.evaluate(() =>
        (window as any).__replayScrolls.every((entry: { opacity: string }) => entry.opacity === '0')
      )
    ).toBe(true);
    expect(await page.evaluate(() => getComputedStyle((window as any).app.terminal.element).opacity)).toBe('1');
  });

  it('opens a never-visited tab at the latest output', async () => {
    await select('tab-scroll-a');
    const current = await snapshot();
    expect(current.row).toBeGreaterThan(100);
  });

  it('keeps the focused terminal textarea alive while the new tab is loading', async () => {
    await select('tab-scroll-a');
    await page.evaluate(() => {
      const app = (window as any).app;
      app._shouldFocusTerminalForTabSwitch = () => true;
      const fetchCapture = app._fetchTerminalCapture.bind(app);
      app._fetchTerminalCapture = async (...args: unknown[]) => {
        await new Promise<void>((resolve) => {
          (window as any).__continueCapture = resolve;
        });
        return fetchCapture(...args);
      };
      (window as any).__selectPending = app.selectSession('tab-scroll-b');
    });
    await page.waitForFunction(() => !!(window as any).__continueCapture);
    const loading = await page.evaluate(() => ({
      opacity: getComputedStyle((window as any).app.terminal.element).opacity,
      focused: document.activeElement?.classList.contains('xterm-helper-textarea'),
    }));
    expect(loading.opacity).toBe('0');
    expect(loading.focused).toBe(true);
    await page.evaluate(() => {
      (window as any).__continueCapture();
      return (window as any).__selectPending;
    });
    expect(await page.evaluate(() => getComputedStyle((window as any).app.terminal.element).opacity)).toBe('1');
  });

  it('reveals the terminal when the new tab capture fails', async () => {
    await select('tab-scroll-a');
    await page.evaluate(() => {
      (window as any).app._fetchTerminalCapture = async () => {
        throw new Error('capture failed');
      };
    });
    await select('tab-scroll-b');
    const state = await page.evaluate(() => ({
      opacity: getComputedStyle((window as any).app.terminal.element).opacity,
      loading: (window as any).app.terminalLoadStates.has('tab-scroll-b'),
    }));
    expect(state.opacity).toBe('1');
    expect(state.loading).toBe(false);
  });

  it('keeps the text stationary when output arrives while reading history', async () => {
    await select('tab-scroll-a');
    await page.evaluate(() => (window as any).app.terminal.scrollToLine(30));
    const before = await snapshot();
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.pendingWrites.push('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });
    expect((await snapshot()).top).toBe(before.top);
  });

  it('continues following output at the live bottom', async () => {
    await select('tab-scroll-a');
    await page.evaluate(() => {
      const app = (window as any).app;
      app.terminal.scrollToBottom();
      app._syncStickyScrollBaseline();
    });
    const before = await snapshot();
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.pendingWrites.push('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });
    const after = await snapshot();
    expect(after.row).toBe(after.baseY);
    expect(after.top).not.toBe(before.top);
  });
});
