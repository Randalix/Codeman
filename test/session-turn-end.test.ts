/**
 * @fileoverview The turn-end latch on Session (`turnEndedAt`/`turnEndSource`), read by
 * `GET /api/agent-watch`. Signals are edges; this is the level behind them, so a
 * coordinator that looks late still learns a worker's turn is over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { IDLE_SILENCE_MS } from '../src/session-activity.js';

type Internals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
  _markWorking(): void;
  _trackSubmit(data: string, options: object): string[];
};

/** Claude's composer repaint: the frame that arms the idle confirmation. */
const COMPOSER = '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m\x1b[0m';

function idleSession(): Session {
  const mux = { isAvailable: () => true, capturePaneText: () => '❯ \n' } as never;
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

function internals(s: Session): Internals {
  return s as unknown as Internals;
}

describe('Session turn-end latch', () => {
  afterEach(() => vi.useRealTimers());

  it('the idle heuristic stamps it; the next working transition clears it', () => {
    vi.useFakeTimers();
    const s = idleSession();
    const ended = vi.fn();
    s.on('turnEnded', ended);
    internals(s)._markWorking();
    expect(s.turnEndedAt).toBeNull();

    internals(s)._handleTerminalOutput(COMPOSER);
    internals(s)._detectInteractiveActivity(COMPOSER);
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 3000);

    expect(s.status).toBe('idle');
    expect(typeof s.turnEndedAt).toBe('number');
    expect(s.turnEndSource).toBe('heuristic');
    expect(ended).toHaveBeenCalledTimes(1);

    internals(s)._markWorking();
    expect(s.turnEndedAt).toBeNull();
    expect(s.turnEndSource).toBeNull();
  });

  it('the first stamp wins the time; a later hook only upgrades a heuristic source', () => {
    vi.useFakeTimers({ now: 1_000 });
    const s = idleSession();
    const ended = vi.fn();
    s.on('turnEnded', ended);
    s.markTurnEnded('heuristic');
    vi.advanceTimersByTime(500);
    s.markTurnEnded('hook');
    expect(s.turnEndedAt).toBe(1_000);
    expect(s.turnEndSource).toBe('hook');
    s.markTurnEnded('heuristic'); // never downgrades
    expect(s.turnEndSource).toBe('hook');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('an exit re-stamps an idle session (a watcher must learn the worker died)', () => {
    vi.useFakeTimers({ now: 1_000 });
    const s = idleSession();
    const ended = vi.fn();
    s.on('turnEnded', ended);
    s.markTurnEnded('hook');
    vi.advanceTimersByTime(60_000);
    s.markTurnEnded('exit');
    expect(s.turnEndedAt).toBe(61_000);
    expect(s.turnEndSource).toBe('exit');
    s.markTurnEnded('exit');
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it('the prompt hook clears it; a bare Enter through the write path does not', () => {
    const s = idleSession();
    s.markTurnEnded('hook');
    internals(s)._trackSubmit('\r', {}); // empty composer: no turn starts, the worker is still idle
    expect(s.turnEndedAt).not.toBeNull();
    s.markPromptSubmitted();
    expect(s.turnEndedAt).toBeNull();
  });

  it('is on the light state the session list serves', () => {
    const s = idleSession();
    s.markTurnEnded('hook');
    expect(s.toLightDetailedState()).toMatchObject({ turnEndedAt: s.turnEndedAt, turnEndSource: 'hook' });
  });

  it('paneText falls back to the buffer tail with cursor jumps as line breaks', () => {
    const s = new Session({ workingDir: '/tmp', mode: 'claude' });
    (s as unknown as Internals)._handleTerminalOutput('\x1b[2J\x1b[3;1Hdone\x1b[4;3H\x1b[31m⎿  API Error: x\x1b[0m');
    expect(s.paneText()).toMatch(/^\s*⎿ {2}API Error: x$/m);
  });
});
