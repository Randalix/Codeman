import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../../src/web/server.js';

declare const _crashDiag: { _entries: string[] };

/**
 * `SCROLL JUMP` names the code path behind a frame that jumps away and back
 * without a user scroll (reported in claude tabs, not reproduced by a replay).
 */
describe('SCROLL JUMP diagnostic', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  const history = Array.from({ length: 200 }, (_, i) => `jump history ${i}\r\n`).join('');

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
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route('**/api/sessions/jump-diag/terminal?*', (route) =>
      route.fulfill({
        json: { success: true, data: { terminalBuffer: history, source: 'mux-full-history', truncated: false } },
      })
    );
    await page.goto(`http://localhost:${server.boundPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).app?.terminal);
    await page.evaluate(async () => {
      const app = (window as any).app;
      app._connectWs = () => {};
      app.sendResize = async () => false;
      app._updateSseSubscription = () => {};
      app._refreshSessionPanels = () => {};
      app.markIdleAlertSeen = () => {};
      app.sessions.clear();
      app.activeSessionId = null;
      app.sessionOrder = ['jump-diag'];
      app.sessions.set('jump-diag', {
        id: 'jump-diag',
        name: 'jump',
        mode: 'claude',
        status: 'idle',
        pid: 1,
        workingDir: '/tmp',
      });
      await app.selectSession('jump-diag');
      app.terminal.scrollToBottom();
      _crashDiag._entries.length = 0;
    });
  });

  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const jumps = () => page.evaluate(() => _crashDiag._entries.filter((line) => line.includes('SCROLL JUMP:')));

  it('logs a jump away from the bottom and back, with the caller that moved it', async () => {
    await page.evaluate(function stickyRestoreProbe() {
      (window as any).app.terminal.scrollToLine(20);
    });
    await frame();
    await page.evaluate(() => (window as any).app.terminal.scrollToBottom());
    await frame();
    await page.evaluate(() => (window as any).app.terminal.write('one more line\r\n'));
    await frame();
    const logged = await jumps();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/SCROLL JUMP: jump-diag row=\d+>20>/);
    expect(logged[0]).toContain('scrollToLine@stickyRestoreProbe');
    expect(logged[0]).not.toContain('jump history');
  });

  it('stays quiet while following output at the bottom', async () => {
    for (let i = 0; i < 6; i++) {
      await page.evaluate((i) => (window as any).app.terminal.write(`live ${i}\r\n`), i);
      await frame();
    }
    expect(await jumps()).toEqual([]);
  });

  it('stays quiet when the user scrolled in between', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      app._noteTerminalUserScroll(-30);
      app.terminal.scrollLines(-30);
    });
    await frame();
    await page.evaluate(() => {
      const app = (window as any).app;
      app._noteTerminalUserScroll(30);
      app.terminal.scrollLines(30);
    });
    await frame();
    await page.evaluate(() => (window as any).app.terminal.write('one more line\r\n'));
    await frame();
    expect(await jumps()).toEqual([]);
  });
});
