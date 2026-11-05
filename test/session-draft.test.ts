/**
 * @fileoverview Session.hasDraft(): unsubmitted text in the composer, which the inbox
 * nudger must never type over (its line plus Enter would submit a human's draft).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

describe('Session.hasDraft', () => {
  it('is set by printable input without Enter and cleared by a submit', () => {
    const s = new Session({ workingDir: '/tmp' });
    expect(s.hasDraft()).toBe(false);
    s.write('half a prom');
    expect(s.hasDraft()).toBe(true);
    s.write('pt\r');
    expect(s.hasDraft()).toBe(false);
  });

  it('ignores escape sequences and bare control bytes', () => {
    const s = new Session({ workingDir: '/tmp' });
    s.write('\u001b[A'); // arrow up
    s.write('\u001b'); // interrupt
    s.write('\u0003');
    expect(s.hasDraft()).toBe(false);
  });

  it('a hook-reported submit clears it too', () => {
    const s = new Session({ workingDir: '/tmp' });
    s.write('draft');
    s.markPromptSubmitted();
    expect(s.hasDraft()).toBe(false);
  });
});

describe('Session.hasDraft against the pane', () => {
  const FRAME = '─'.repeat(40);
  const pane = (row: string) => [FRAME, row, FRAME, '  Opus 5.5  ctx:13%', '  bypass permissions on'].join('\n');
  const EMPTY = pane('\u001b[39m❯\u00a0');
  const PLACEHOLDER = pane('\u001b[39m❯\u00a0\u001b[2mTry "write a test for <filepath>"\u001b[0m');
  const TYPED = pane('\u001b[39m❯\u00a0hello world');

  function session(capture: () => string | null) {
    return new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux: { isAvailable: () => true, capturePaneText: capture },
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1 },
    } as unknown as ConstructorParameters<typeof Session>[0]);
  }
  /** A draft whose last key went in `ms` ago. */
  function drafted(s: Session, ms = 5000) {
    vi.useFakeTimers();
    s.write('abc', { fromUser: true });
    s.write('\u007f\u007f\u007f', { fromUser: true });
    vi.advanceTimersByTime(ms);
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['an empty composer', EMPTY],
    ['the dimmed placeholder', PLACEHOLDER],
  ])('backspaced to %s: the latch goes', (_label, screen) => {
    const s = session(() => screen);
    drafted(s);
    expect(s.hasDraft()).toBe(false);
  });

  it('a draft on screen keeps the latch', () => {
    const s = session(() => TYPED);
    drafted(s);
    expect(s.hasDraft()).toBe(true);
  });

  it('asks the pane for styles, or the placeholder would read as text', () => {
    const capture = vi.fn(() => EMPTY);
    const s = session(capture);
    drafted(s);
    s.hasDraft();
    expect(capture).toHaveBeenCalledWith('codeman-test', undefined, { styles: true });
  });

  it('does not trust a frame right after a key: it may predate the keystroke', () => {
    const s = session(() => EMPTY);
    drafted(s, 500);
    expect(s.hasDraft()).toBe(true);
  });

  it('a failed capture proves nothing', () => {
    const s = session(() => null);
    drafted(s);
    expect(s.hasDraft()).toBe(true);
  });

  it('no draft, no capture', () => {
    const capture = vi.fn(() => EMPTY);
    expect(session(capture).hasDraft()).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});
