// Real xterm parsing keeps these scroll regressions visible to the CI gate.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
const terminals: InstanceType<typeof xtermHeadless.Terminal>[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

async function harness() {
  const frames: Array<() => void> = [];
  const CodemanApp = function () {};
  vm.runInNewContext(source, {
    CodemanApp,
    window: {},
    console,
    performance,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  const app = new (CodemanApp as any)();
  const terminal = new xtermHeadless.Terminal({ cols: 40, rows: 20, scrollback: 100, allowProposedApi: true });
  terminals.push(terminal);
  Object.assign(app, {
    terminal,
    activeSessionId: 'scroll-test',
    sessions: new Map([['scroll-test', { mode: 'codex' }]]),
    pendingWrites: [],
    _wasAtBottomBeforeWrite: false,
    _scheduleTerminalWriteFlush: vi.fn(),
    _noteMobileImeAuthoritativeOutput: vi.fn(),
  });
  const parsed = () => new Promise<void>((resolve) => terminal.write('', resolve));
  await new Promise<void>((resolve) =>
    terminal.write(Array.from({ length: 140 }, (_, i) => `history ${i}\r\n`).join(''), resolve)
  );
  terminal.scrollToLine(30);
  const top = () => terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true);
  const flush = (data: string) => {
    app.pendingWrites.push(data);
    app.flushPendingWrites();
  };
  return { app, terminal, top, flush, parsed, frame: () => frames.shift()?.() };
}

describe('new output preserves the text being read', () => {
  it('follows the history row when full scrollback trims older rows', async () => {
    const { terminal, top, flush, parsed } = await harness();
    const before = top();
    flush('new output\r\n'.repeat(10));
    await parsed();
    expect(top()).toBe(before);
    expect(terminal.buffer.active.viewportY).toBe(20);
    expect(terminal.markers).toHaveLength(0);
  });

  it.each([1, 2])('does not follow output when %i lines above the bottom', async (distance) => {
    const { app, terminal, top, flush, parsed } = await harness();
    terminal.scrollToLine(terminal.buffer.active.baseY - distance);
    app._wasAtBottomBeforeWrite = app.isTerminalAtBottom();
    const before = top();
    flush('new output\r\n'.repeat(10));
    await parsed();
    expect(top()).toBe(before);
  });

  it('keeps a gesture made after output was queued', async () => {
    const { app, terminal, flush, parsed } = await harness();
    flush('\x1b[1;1Hstatus tick');
    app._noteTerminalUserScroll(-10);
    terminal.scrollLines(-10);
    await parsed();
    expect(terminal.buffer.active.viewportY).toBe(20);
    expect(terminal.markers).toHaveLength(0);
  });

  it('keeps wheel animation steps made while output is queued', async () => {
    const { app, terminal, flush, parsed, frame } = await harness();
    app._smoothScrollBy(-10);
    frame();
    flush('\x1b[1;1Hstatus tick');
    frame();
    const position = terminal.buffer.active.viewportY;
    await parsed();
    expect(terminal.buffer.active.viewportY).toBe(position);
  });

  it('shows the oldest remaining row if the row being read was evicted', async () => {
    const { terminal, top, flush, parsed } = await harness();
    flush('new output\r\n'.repeat(40));
    await parsed();
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(top()).toBe('history 61');
    expect(terminal.markers).toHaveLength(0);
  });

  it('continues following output at the actual bottom', async () => {
    const { app, terminal, top, flush, parsed } = await harness();
    terminal.scrollToBottom();
    app._wasAtBottomBeforeWrite = app.isTerminalAtBottom();
    const before = top();
    flush('new output\r\n'.repeat(10));
    await parsed();
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(top()).not.toBe(before);
    expect(terminal.markers).toHaveLength(0);
  });

  it('disposes its marker when a write fails', async () => {
    const { terminal, flush } = await harness();
    vi.spyOn(terminal, 'write').mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() => flush('new output')).toThrow('write failed');
    expect(terminal.markers).toHaveLength(0);
  });

  it('disposes its marker when a session switch makes the anchor obsolete', async () => {
    const { app, terminal, flush, parsed } = await harness();
    flush('new output\r\n');
    app.activeSessionId = 'another-session';
    await parsed();
    expect(terminal.markers).toHaveLength(0);
  });
});
