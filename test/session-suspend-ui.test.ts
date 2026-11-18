/**
 * @fileoverview The suspended state in the web UI (session-suspend.ts): a suspended
 * session reads "suspended" (not "exited (143)") and is greyed out on every surface —
 * desktop tabs (full render and the incremental badge path), the phone overview, the
 * home rail and the rich sidebar rows, which share `_mobileOverviewExit()`.
 *
 * Port: none (source extraction + jsdom + postcss)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const fn = (name: string) => {
  const source = appJs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  if (!source) throw new Error(`${name} not found in app.js`);
  return source;
};

describe('paneExitLabel with suspended', () => {
  const paneExitLabel = new Function(`${fn('paneExitLabel')}\nreturn paneExitLabel;`)() as (
    p: unknown,
    s?: unknown
  ) => string;

  it('says "suspended" for a suspended session, whatever the pane exit says', () => {
    expect(paneExitLabel({ status: 143, at: 1 }, true)).toBe('suspended');
    expect(paneExitLabel(undefined, true)).toBe('suspended');
  });

  it('keeps the exit labels otherwise', () => {
    expect(paneExitLabel({ status: 143, at: 1 }, false)).toBe('exited (143)');
    expect(paneExitLabel({ status: 143, at: 1 })).toBe('exited (143)');
    expect(paneExitLabel(undefined)).toBe('');
  });
});

describe('the incremental tab path greys a suspended tab out', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const apply = new Function(
    'document',
    `${fn('paneExitLabel')}\n${fn('paneExitAriaLabel')}\n${fn('applyPaneExitBadge')}\nreturn applyPaneExitBadge;`
  )(dom.window.document) as (tab: unknown, paneExit: unknown, suspended?: unknown) => void;
  const makeTab = () => {
    const tab = dom.window.document.createElement('div');
    tab.className = 'session-tab';
    tab.innerHTML = '<span class="tab-name" data-full-name="w1">w1</span>';
    return tab;
  };

  it('adds tab-suspended and the "suspended" badge, and removes both on resume', () => {
    const tab = makeTab();
    apply(tab, { status: 143, at: 1 }, true);
    expect(tab.classList.contains('tab-suspended')).toBe(true);
    expect(tab.querySelector('.tab-exited-badge')?.textContent).toBe('suspended');
    expect(tab.getAttribute('aria-label')).toBe('w1 session, agent suspended');
    apply(tab, undefined, false);
    expect(tab.classList.contains('tab-suspended')).toBe(false);
    expect(tab.querySelector('.tab-exited-badge')).toBeNull();
  });

  it('the full render carries the class too', () => {
    expect(appJs).toContain("${session.suspended ? ' tab-suspended' : ''}");
    expect(appJs).toContain('paneExitLabel(session.paneExit, session.suspended)');
  });
});

describe('the home surfaces', () => {
  const load = () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({ CodemanApp, console, window: {}, document: {} });
    vm.runInContext(`${fn('paneExitLabel')}\nthis.paneExitLabel = paneExitLabel;`, context);
    for (const file of ['constants.js', 'mobile-overview.js']) {
      vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
    }
    return new (CodemanApp as unknown as new () => {
      _mobileOverviewExit(
        state: string,
        session: unknown
      ): { label?: string; suspended?: boolean; since: unknown } | null;
    })();
  };

  it('_mobileOverviewExit names a suspended session and measures from the suspend', () => {
    const app = load();
    expect(
      app._mobileOverviewExit('idle', { paneExit: { status: 143, at: 5 }, suspended: true, suspendedAt: 7 })
    ).toEqual({ since: { key: 'suspended', at: 7 }, label: 'suspended', suspended: true });
    expect(app._mobileOverviewExit('idle', { paneExit: { status: 143, at: 5 } })).toEqual({
      since: { key: 'exited', at: 5 },
      label: 'exited',
    });
  });

  it('rows take the suspended class and pill', () => {
    const mo = readFileSync(resolve(PUBLIC, 'mobile-overview.js'), 'utf8');
    const hs = readFileSync(resolve(PUBLIC, 'home-sessions.js'), 'utf8');
    expect(mo).toContain("row.suspended ? ' mobile-overview-row--suspended' : ''");
    expect(hs).toContain("row.suspended ? ' home-sessions-row--suspended' : ''");
    expect(mo).toContain("pill: exit ? exit.label || 'exited'");
    expect(hs).toContain("pill: exit ? exit.label || 'exited'");
  });

  it('the stylesheets grey suspended tabs and rows out', () => {
    const selectors = (file: string) => {
      const found: string[] = [];
      postcss.parse(readFileSync(resolve(PUBLIC, file), 'utf8')).walkRules((r) => {
        if (/suspended/.test(r.selector) && r.nodes.some((n) => n.type === 'decl' && n.prop === 'opacity')) {
          found.push(r.selector);
        }
      });
      return found.join('\n');
    };
    expect(selectors('styles.css')).toMatch(/\.session-tab\.tab-suspended/);
    expect(selectors('styles.css')).toMatch(/\.home-sessions-row--suspended/);
    expect(selectors('mobile.css')).toMatch(/\.mobile-overview-row--suspended/);
  });
});
