import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

describe('mobile output preserves the history being read', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.waitForTimeout(1000);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  beforeEach(async () => {
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.activeSessionId = 'output-scroll-probe';
      app.sessions.set(app.activeSessionId, { id: app.activeSessionId, mode: 'codex' });
      app.pendingWrites = [];
      app._wasAtBottomBeforeWrite = false;
      app._lastUserScrollUpAt = null;
      app.terminal.reset();
      app.terminal.options.scrollback = 100;
      app.terminal.resize(40, 20);
      await new Promise<void>((resolve) =>
        app.terminal.write(Array.from({ length: 140 }, (_, i) => `history ${i}\r\n`).join(''), resolve)
      );
      app.terminal.scrollToLine(30);
    });
  });

  const snapshot = () =>
    page.evaluate(() => {
      const term = (window as any).app.terminal;
      const buf = term.buffer.active;
      return { baseY: buf.baseY, viewportY: buf.viewportY, top: buf.getLine(buf.viewportY)?.translateToString(true) };
    });

  it('keeps the same text visible when new lines evict old scrollback', async () => {
    const before = await snapshot();
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.pendingWrites.push('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });
    const after = await snapshot();
    console.log('scrollback trim', { before, after });
    expect(after.top).toBe(before.top);
  });

  it('keeps a manual scroll made while a write is waiting to parse', async () => {
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.pendingWrites.push('\x1b[1;1Hstatus tick');
      app.flushPendingWrites();
      app._noteTerminalUserScroll(-10);
      app.terminal.scrollLines(-10);
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });
    const after = await snapshot();
    console.log('gesture during pending parse', after);
    expect(after.viewportY).toBe(20);
  });

  it('keeps a reader still when just one line above live output', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      app.terminal.scrollToLine(app.terminal.buffer.active.baseY - 1);
      app._wasAtBottomBeforeWrite = app.isTerminalAtBottom();
    });
    const before = await snapshot();
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.pendingWrites.push('new output\r\n'.repeat(10));
      app.flushPendingWrites();
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
    });
    const after = await snapshot();
    console.log('near bottom', { before, after });
    expect(after.top).toBe(before.top);
  });

  it('keeps a touch drag made while output is waiting to parse', async () => {
    const result = await page.evaluate(async () => {
      const app = (window as any).app;
      const container = document.getElementById('terminalContainer')!;
      const dispatch = (type: string, y: number) => {
        const touch = new Touch({ identifier: 1, target: container, clientX: 50, clientY: y });
        container.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
          })
        );
      };
      dispatch('touchstart', 100);
      app.pendingWrites.push('\x1b[1;1Hstatus tick');
      app.flushPendingWrites();
      dispatch('touchmove', 160);
      const draggedTo = app.terminal.buffer.active.viewportY;
      await new Promise<void>((resolve) => app.terminal.write('', resolve));
      const after = app.terminal.buffer.active.viewportY;
      container.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [], changedTouches: [] }));
      return { draggedTo, after };
    });
    expect(result.draggedTo).toBeLessThan(30);
    expect(result.after).toBe(result.draggedTo);
  });

  it('keeps touch momentum that advances while output is waiting to parse', async () => {
    const result = await page.evaluate(async () => {
      const app = (window as any).app;
      const container = document.getElementById('terminalContainer')!;
      const dispatch = (type: string, y: number) => {
        const touch = new Touch({ identifier: 1, target: container, clientX: 50, clientY: y });
        const touches = type === 'touchend' || type === 'touchcancel' ? [] : [touch];
        container.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            targetTouches: touches,
            changedTouches: [touch],
          })
        );
      };
      app.terminal.scrollToLine(80);
      dispatch('touchstart', 100);
      dispatch('touchmove', 160);
      dispatch('touchend', 160);
      // Hold just this write to model a parsing backlog while real RAF momentum runs.
      const write = app.terminal.write.bind(app.terminal);
      let queued: { data: string; callback: () => void } | undefined;
      app.terminal.write = (data: string, callback: () => void) => {
        queued = { data, callback };
      };
      const beforeMomentum = app.terminal.buffer.active.viewportY;
      let momentumPosition: number;
      try {
        app.pendingWrites.push('\x1b[1;1Hstatus tick');
        app.flushPendingWrites();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        momentumPosition = app.terminal.buffer.active.viewportY;
      } finally {
        app.terminal.write = write;
        dispatch('touchcancel', 160);
      }
      if (!queued) throw new Error('output was not queued');
      await new Promise<void>((resolve) =>
        write(queued!.data, () => {
          queued!.callback();
          resolve();
        })
      );
      return { beforeMomentum, momentumPosition, after: app.terminal.buffer.active.viewportY };
    });
    expect(result.momentumPosition).toBeLessThan(result.beforeMomentum);
    expect(result.after).toBe(result.momentumPosition);
  });
});
