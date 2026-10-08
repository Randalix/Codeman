/**
 * @fileoverview TurnWatch (src/web/agent-watch.ts): the fan-in wake behind
 * `GET /api/agent-watch`. A wake is a hint; the route re-reads the latch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnWatch } from '../src/web/agent-watch.js';

describe('TurnWatch', () => {
  afterEach(() => vi.useRealTimers());

  it('wakes only the waiters that watch the notified session, and frees their slot', async () => {
    const watch = new TurnWatch();
    const a = watch.wait(['s1', 's2'], 10_000);
    const b = watch.wait(['s3'], 10_000);
    expect(watch.size).toBe(2);
    watch.notify('s2');
    expect(await a).toBe('woken');
    expect(watch.size).toBe(1);
    watch.notify('s3');
    expect(await b).toBe('woken');
    expect(watch.size).toBe(0);
  });

  it('times out, and an abort frees the slot at once', async () => {
    vi.useFakeTimers();
    const watch = new TurnWatch();
    const timed = watch.wait(['s1'], 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await timed).toBe('timeout');

    const controller = new AbortController();
    const aborted = watch.wait(['s1'], 60_000, controller.signal);
    controller.abort();
    expect(await aborted).toBe('aborted');
    expect(watch.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // no timer outlives its waiter
  });

  it('stop releases every waiter and refuses new ones', async () => {
    const watch = new TurnWatch();
    const parked = watch.wait(['s1'], 60_000);
    watch.stop();
    expect(await parked).toBe('stopped');
    expect(await watch.wait(['s1'], 60_000)).toBe('stopped');
  });
});
