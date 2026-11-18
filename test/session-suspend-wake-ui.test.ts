/**
 * @fileoverview How a suspended session tells the user it can come back:
 * - the bar over its terminal with a Wake button (app.js `_renderSuspendedBar`),
 * - the line tmux writes into its dead pane (`SUSPENDED_PANE_NOTICE`, set before the
 *   stop because tmux renders it at the moment the pane dies; "Pane is dead" read as
 *   final, 2026-11-18).
 *
 * Port: none (source extraction + jsdom)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { SUSPENDED_PANE_NOTICE } from '../src/tmux-manager.js';

const ROOT = resolve(import.meta.dirname, '..');
const appJs = readFileSync(resolve(ROOT, 'src/web/public/app.js'), 'utf8');
const indexHtml = readFileSync(resolve(ROOT, 'src/web/public/index.html'), 'utf8');

function method(name: string): string {
  const source = appJs.match(new RegExp(`\\n  ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}\\n`))?.[0];
  if (!source) throw new Error(`${name} not found in app.js`);
  return source.trim();
}

function makeApp(sessions: Record<string, Record<string, unknown>>, active: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="suspendedSessionBar" hidden></div></body></html>');
  const render = new Function('document', `return { ${method('_renderSuspendedBar')} };`)(dom.window.document) as {
    _renderSuspendedBar: () => void;
  };
  let finish: (ok: boolean) => void = () => {};
  const app = Object.assign(render, {
    activeSessionId: active,
    sessions: new Map(Object.entries(sessions)),
    setSessionSuspended: vi.fn(
      () =>
        new Promise<boolean>((r) => {
          finish = r;
        })
    ),
  });
  const bar = dom.window.document.getElementById('suspendedSessionBar') as HTMLElement;
  return { app, bar, finish: (ok: boolean) => finish(ok) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the suspended bar over the terminal', () => {
  it('is in the page, above the terminal', () => {
    expect(indexHtml).toMatch(/id="suspendedSessionBar"[^>]*hidden[\s\S]*id="terminalContainer"/);
  });

  it('shows for a suspended active session, with a Wake button', () => {
    const { app, bar } = makeApp({ a: { suspended: true } }, 'a');
    app._renderSuspendedBar();
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Suspended to free memory. Type to resume it');
    expect(bar.querySelector('button')?.textContent).toBe('Wake');
  });

  it('names the host for a remote session', () => {
    const { app, bar } = makeApp({ a: { suspended: true, remote: { hostId: 'h' } } }, 'a');
    app._renderSuspendedBar();
    expect(bar.textContent).toContain('on its host');
  });

  it('stays hidden for a running session and hides on resume', () => {
    const { app, bar } = makeApp({ a: { suspended: true }, b: {} }, 'b');
    app._renderSuspendedBar();
    expect(bar.hidden).toBe(true);
    app.activeSessionId = 'a';
    app._renderSuspendedBar();
    expect(bar.hidden).toBe(false);
    app.sessions.get('a')!.suspended = false;
    app._renderSuspendedBar();
    expect(bar.hidden).toBe(true);
  });

  it('Wake resumes that session and keeps "Waking…" across re-renders until it is back', async () => {
    const { app, bar, finish } = makeApp({ a: { suspended: true } }, 'a');
    app._renderSuspendedBar();
    bar.querySelector('button')!.click();
    expect(app.setSessionSuspended).toHaveBeenCalledWith('a', false);
    app._renderSuspendedBar(); // a session update during the resume
    expect(bar.querySelector('button')?.textContent).toBe('Waking…');
    expect((bar.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    app.sessions.get('a')!.suspended = false;
    finish(true);
    await flush();
    expect(bar.hidden).toBe(true);
  });

  it('a refused or failed wake offers the button again', async () => {
    const { app, bar, finish } = makeApp({ a: { suspended: true } }, 'a');
    app._renderSuspendedBar();
    bar.querySelector('button')!.click();
    finish(false);
    await flush();
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('button')?.textContent).toBe('Wake');
  });

  it('follows every session update and every tab switch', () => {
    expect(method('_renderSessionTabsImmediate')).toContain('this._renderSuspendedBar();');
    const select = appJs.slice(appJs.indexOf('  async selectSession(sessionId'));
    expect(select.slice(0, select.indexOf('\n  }\n'))).toContain('this._renderSuspendedBar();');
  });
});

describe('the dead pane of a suspended session', () => {
  const tmuxSrc = readFileSync(resolve(ROOT, 'src/tmux-manager.ts'), 'utf8');
  const stop = tmuxSrc.slice(tmuxSrc.indexOf('  async stopPaneProcesses('));

  it('says how to resume instead of "Pane is dead", and survives shell quoting', () => {
    expect(SUSPENDED_PANE_NOTICE).toContain('Type here');
    expect(SUSPENDED_PANE_NOTICE).not.toContain("'");
  });

  it('is set before anything is stopped (tmux renders it as the pane dies)', () => {
    const notice = stop.indexOf('setSuspendedPaneNotice(session.muxName, true)');
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(stop.indexOf('stopRemoteTmuxSession('));
    expect(notice).toBeLessThan(stop.indexOf("'SIGTERM'"));
  });

  it('is cleared again when the stop fails and when the session resumes', () => {
    const body = stop.slice(0, stop.indexOf('\n  }\n'));
    expect(body.match(/setSuspendedPaneNotice\(session\.muxName, false\)/g)?.length).toBe(2);
    const routes = readFileSync(resolve(ROOT, 'src/web/routes/session-routes.ts'), 'utf8');
    expect(routes).toMatch(/onResumed: \(s\) => \{[\s\S]*?clearSuspendedPaneNotice\?\.\(s\.id\)/);
  });
});
