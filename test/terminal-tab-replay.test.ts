import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const dir = resolve(import.meta.dirname, '../src/web/public');
const context = vm.createContext({
  console,
  performance,
  setTimeout,
  clearTimeout,
  setInterval: vi.fn(),
  HTMLCanvasElement: class HTMLCanvasElement {},
  document: { addEventListener: vi.fn() },
  window: { addEventListener: vi.fn() },
  MobileDetection: { isTouchDevice: () => false },
});
vm.runInContext(
  readFileSync(resolve(dir, 'constants.js'), 'utf8') +
    readFileSync(resolve(dir, 'app.js'), 'utf8') +
    '\nglobalThis.App = CodemanApp;',
  context
);

function harness() {
  const app = Object.create((context as any).App.prototype);
  const classes = new Set<string>();
  app.terminal = {
    element: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    },
  };
  app.terminalLoadStates = new Map();
  app._updateTerminalLoadTab = vi.fn();
  app._selectGeneration = 1;
  return { app, hidden: () => classes.has('terminal-tab-replay') };
}

describe('terminal tab replay rendering ownership', () => {
  it('reveals a terminal only when its current selection has finished', () => {
    const { app, hidden } = harness();
    app._setTerminalLoadState('a', 1, 'fetching');
    expect(hidden()).toBe(true);
    app._clearTerminalLoadState('a', 1);
    expect(hidden()).toBe(false);
  });

  it('does not reveal a newer tab when the previous fetch finishes late', () => {
    const { app, hidden } = harness();
    app._setTerminalLoadState('a', 1, 'fetching');
    app._selectGeneration = 2;
    app._setTerminalLoadState('b', 2, 'fetching');
    app._clearTerminalLoadState('a', 1);
    expect(hidden()).toBe(true);
    app._clearTerminalLoadState('b', 2);
    expect(hidden()).toBe(false);
  });

  it('does not reveal a force reload when an earlier load of the same tab ends', () => {
    const { app, hidden } = harness();
    app._setTerminalLoadState('a', 1, 'fetching');
    app._selectGeneration = 2;
    app._setTerminalLoadState('a', 2, 'replaying');
    app._clearTerminalLoadState('a', 1);
    expect(hidden()).toBe(true);
    app._clearTerminalLoadState('a', 2);
    expect(hidden()).toBe(false);
  });
});
