/**
 * @fileoverview Fan-in wait behind `GET /api/agent-watch`: block until ANY of a set
 * of sessions reports the end of a turn.
 *
 * A coordinator steering N workers had two options, both bad: one `wait` long-poll
 * per worker (edge-triggered — a turn that ends while no waiter is parked is never
 * seen), or polling `agent ls` every 30 s and counting minutes (the 6-minute
 * watchdog the Neon Getaway runs used). The level now lives on the session
 * (`Session.turnEndedAt`, stamped by the stop hook, the idle heuristic or the pane's
 * exit); this registry only wakes a parked request when a stamp lands, and the
 * route re-reads the level. So a wake is a hint, never the answer: a missed or
 * spurious wake costs one rescan, never a lost turn.
 *
 * Lifetime: every waiter owns one timer, cleared on settle; `stop()` releases all at
 * shutdown. Holds no `Session` reference, which keeps it testable in isolation.
 *
 * @module web/agent-watch
 */

/** Concurrent parked watch requests, process-wide. A coordinator needs one. */
export const MAX_TURN_WATCHERS = 32;

/** Session ids one watch request may name. */
export const MAX_WATCH_SESSIONS = 64;

export type WatchOutcome = 'woken' | 'timeout' | 'aborted' | 'stopped';

interface Waiter {
  ids: ReadonlySet<string>;
  settle: (outcome: WatchOutcome) => void;
}

export class TurnWatch {
  private readonly waiters = new Set<Waiter>();
  private stopped = false;

  /** Parked requests right now. */
  get size(): number {
    return this.waiters.size;
  }

  /**
   * Park until a turn ends in one of `ids`, the timeout, or `signal` aborts.
   * Registration is synchronous, so a caller that scanned the sessions in the same
   * tick cannot miss a stamp landing between its scan and this call.
   */
  wait(ids: Iterable<string>, timeoutMs: number, signal?: AbortSignal): Promise<WatchOutcome> {
    if (this.stopped) return Promise.resolve('stopped');
    if (signal?.aborted) return Promise.resolve('aborted');
    return new Promise((resolve) => {
      const onAbort = (): void => settle('aborted');
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      const waiter: Waiter = { ids: new Set(ids), settle: (outcome) => settle(outcome) };
      const settle = (outcome: WatchOutcome): void => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** A turn ended in `sessionId`: wake every request watching it. */
  notify(sessionId: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.ids.has(sessionId)) waiter.settle('woken');
    }
  }

  /** Shutdown: release everything and refuse new waits. */
  stop(): void {
    this.stopped = true;
    for (const waiter of [...this.waiters]) waiter.settle('stopped');
  }

  resetForTests(): void {
    for (const waiter of [...this.waiters]) waiter.settle('stopped');
    this.stopped = false;
  }
}

/** The process-wide registry: the session wiring notifies it, the route parks on it. */
export const turnWatch = new TurnWatch();
