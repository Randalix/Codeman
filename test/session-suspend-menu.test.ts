/**
 * @fileoverview The row ⋯ menu's suspend/resume item (tab-rail-resize.js), driven in
 * JSDOM like tile-grid-detach.test.ts: which sessions get which item, what the click
 * POSTs, and that a refusal's reason reaches the toast.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');

type Session = { mode?: string; suspended?: boolean };

function menuFor(session: Session | undefined, api?: (path: string) => unknown) {
  const dom = new JSDOM('<!doctype html><html><body><button id="t">⋯</button></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const ctx = dom.getInternalVMContext();
  vm.runInContext('globalThis.CodemanApp = class CodemanApp {};', ctx);
  vm.runInContext(read('tab-rail-resize.js'), ctx, { filename: 'tab-rail-resize.js' });
  const App = (dom.window as unknown as { CodemanApp: { prototype: object } }).CodemanApp;
  const sessions = new Map<string, Session>();
  if (session) sessions.set('s1', session);
  const app = Object.assign(Object.create(App.prototype), {
    sessions,
    loadAppSettingsFromStorage: () => ({}),
    detachedSessions: new Set(),
    openSessionOptions: vi.fn(),
    requestCloseSession: vi.fn(),
    showToast: vi.fn(),
    _api: vi.fn(async (path: string) => (api ? api(path) : { ok: true, json: async () => ({ success: true }) })),
  }) as Record<string, ReturnType<typeof vi.fn> & ((...a: unknown[]) => unknown)>;
  const doc = dom.window.document;
  app.openTabRailActionMenu(
    { preventDefault() {}, stopPropagation() {}, currentTarget: doc.getElementById('t') },
    's1'
  );
  const items = [...doc.querySelectorAll('.tab-rail-action-menu [role="menuitem"]')] as HTMLButtonElement[];
  return {
    app,
    labels: items.map((b) => b.textContent),
    click: (label: string) => items.find((b) => b.textContent === label)!.click(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('suspend/resume in the row ⋯ menu', () => {
  it('offers "Suspend session" for a running claude session, before "Close session"', () => {
    expect(menuFor({ mode: 'claude' }).labels).toEqual(['Session options', 'Suspend session', 'Close session']);
  });

  it('offers "Wake session" for a suspended session', () => {
    expect(menuFor({ mode: 'claude', suspended: true }).labels).toEqual([
      'Session options',
      'Wake session',
      'Close session',
    ]);
  });

  it('offers nothing for other CLIs or an unknown session (the server would refuse them)', () => {
    for (const mode of ['opencode', 'codex', 'shell', 'pi']) {
      expect(menuFor({ mode }).labels).toEqual(['Session options', 'Close session']);
    }
    expect(menuFor(undefined).labels).toEqual(['Session options', 'Close session']);
  });

  it('suspend POSTs the suspend route and confirms with a toast', async () => {
    const { app, click } = menuFor({ mode: 'claude' });
    click('Suspend session');
    await flush();
    expect(app._api).toHaveBeenCalledWith('/api/sessions/s1/suspend', { method: 'POST' });
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('suspended'), 'success');
  });

  it('resume POSTs the resume route and says it is waiting', async () => {
    const { app, click } = menuFor({ mode: 'claude', suspended: true });
    click('Wake session');
    await flush();
    expect(app._api).toHaveBeenCalledWith('/api/sessions/s1/resume', { method: 'POST' });
    expect(app.showToast).toHaveBeenCalledWith('Waking session…', 'info');
    expect(app.showToast).toHaveBeenCalledTimes(1);
  });

  it("a refusal shows the server's reason", async () => {
    const { app, click } = menuFor({ mode: 'claude' }, () => ({
      ok: false,
      json: async () => ({ success: false, error: 'The session is working; wait until it is idle.' }),
    }));
    click('Suspend session');
    await flush();
    expect(app.showToast).toHaveBeenCalledWith('The session is working; wait until it is idle.', 'error');
  });

  it('a network failure still says something', async () => {
    const { app, click } = menuFor({ mode: 'claude', suspended: true }, () => null);
    click('Wake session');
    await flush();
    expect(app.showToast).toHaveBeenLastCalledWith('Could not resume the session', 'error');
  });
});
