/**
 * @fileoverview The agent inbox store (src/web/agent-inbox.ts): bounds, non-destructive
 * reads, ack semantics, long-poll release paths, and the persistence round trip.
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentInbox, MAX_MESSAGES_PER_INBOX, MAX_TEXT_LENGTH, clampWait } from '../src/web/agent-inbox.js';
import { MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS } from '../src/config/agent-wait.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000000';
const B = 'bbbbbbbb-0000-4000-8000-000000000000';

function make(): { inbox: AgentInbox; tick: (ms: number) => void } {
  let t = 1_000;
  const inbox = new AgentInbox(() => t);
  return { inbox, tick: (ms) => (t += ms) };
}

describe('post / list / ack', () => {
  it('stores in order, reads are non-destructive, ack removes only the named ids', () => {
    const { inbox } = make();
    const first = inbox.post(A, B, 'one');
    const second = inbox.post(A, 'label', 'two');
    expect(first.ok && second.ok).toBe(true);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['one', 'two']);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['one', 'two']); // still there
    expect(inbox.pendingCount(A)).toBe(2);
    if (!first.ok) throw new Error('unreachable');
    expect(inbox.ack(A, [first.message.id, 'unknown-id'])).toBe(1);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['two']);
    expect(inbox.list(B)).toEqual([]); // inboxes are per session
  });

  it('refuses instead of dropping the oldest when the inbox is full', () => {
    const { inbox } = make();
    for (let i = 0; i < MAX_MESSAGES_PER_INBOX; i++) expect(inbox.post(A, B, `m${i}`).ok).toBe(true);
    expect(inbox.post(A, B, 'overflow')).toEqual({ ok: false, reason: 'full' });
    expect(inbox.list(A)[0].text).toBe('m0'); // nothing was evicted
  });

  it('bounds text and from, and refuses empty text', () => {
    const { inbox } = make();
    expect(inbox.post(A, B, '')).toEqual({ ok: false, reason: 'text-empty' });
    expect(inbox.post(A, B, 'x'.repeat(MAX_TEXT_LENGTH + 1))).toEqual({ ok: false, reason: 'text-too-long' });
    expect(inbox.post(A, 'f'.repeat(129), 'ok')).toEqual({ ok: false, reason: 'from-too-long' });
    expect(inbox.post(A, B, 'x'.repeat(MAX_TEXT_LENGTH)).ok).toBe(true);
  });

  it('fires onMessage with the pending count and onChange on every mutation', () => {
    const { inbox } = make();
    const onMessage = vi.fn();
    const onChange = vi.fn();
    inbox.onMessage = onMessage;
    inbox.onChange = onChange;
    const r = inbox.post(A, B, 'hi');
    expect(onMessage).toHaveBeenCalledWith(A, expect.objectContaining({ text: 'hi', from: B }), 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    if (!r.ok) throw new Error('unreachable');
    inbox.ack(A, [r.message.id]);
    expect(onChange).toHaveBeenCalledTimes(2);
    inbox.ack(A, ['nothing']); // no-op mutation: no change event
    expect(onChange).toHaveBeenCalledTimes(2);
    inbox.post(A, B, 'x');
    inbox.clear(A);
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});

describe('read with wait', () => {
  it('answers at once when something is pending, without waiting', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'ready');
    const result = await inbox.read(A, 60_000);
    expect(result.messages.map((m) => m.text)).toEqual(['ready']);
    expect(result.waitedMs).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('a post releases a pending wait', async () => {
    const { inbox } = make();
    const pending = inbox.read(A, 5_000);
    expect(inbox.waiterCount(A)).toBe(1);
    inbox.post(A, B, 'arrived');
    const result = await pending;
    expect(result.messages.map((m) => m.text)).toEqual(['arrived']);
    expect(result.timedOut).toBe(false);
    expect(inbox.waiterCount(A)).toBe(0);
  });

  it('a post to ANOTHER inbox does not release the wait', async () => {
    vi.useFakeTimers();
    try {
      const { inbox, tick } = make();
      const pending = inbox.read(A, MIN_WAIT_MS);
      inbox.post(B, A, 'not for you');
      tick(MIN_WAIT_MS);
      await vi.advanceTimersByTimeAsync(MIN_WAIT_MS);
      const result = await pending;
      expect(result.messages).toEqual([]);
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detach() releases waiters but KEEPS the mail; drop() discards it', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'while away');
    const waiting = inbox.read(B, 5_000);
    inbox.detach(B);
    expect((await waiting).timedOut).toBe(false);
    inbox.detach(A);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['while away']); // still there after re-adoption
    inbox.drop(A);
    expect(inbox.list(A)).toEqual([]);
  });

  it('pruneExcept() drops inboxes of sessions that did not come back, once, with one change event', () => {
    const { inbox } = make();
    inbox.post(A, 'x', 'keep');
    inbox.post(B, 'x', 'orphan');
    const onChange = vi.fn();
    inbox.onChange = onChange;
    expect(inbox.pruneExcept([A])).toBe(1);
    expect(inbox.list(A)).toHaveLength(1);
    expect(inbox.list(B)).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(inbox.pruneExcept([A])).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1); // nothing to prune → no write
  });

  it('timedOut names the release path, not a clock comparison', async () => {
    vi.useFakeTimers();
    try {
      // The clock never advances, so a wall-clock check would say "not a timeout".
      const inbox = new AgentInbox(() => 42);
      const pending = inbox.read(A, MIN_WAIT_MS);
      await vi.advanceTimersByTimeAsync(MIN_WAIT_MS);
      expect((await pending).timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drop() and stop() release waiters without a timeout flag', async () => {
    const { inbox } = make();
    const dropped = inbox.read(A, 5_000);
    inbox.drop(A);
    expect((await dropped).timedOut).toBe(false);
    const stopped = inbox.read(B, 5_000);
    inbox.stop();
    expect((await stopped).timedOut).toBe(false);
    expect(inbox.post(B, A, 'late')).toEqual({ ok: false, reason: 'stopped' });
  });

  it('an aborted wait gives its slot back at once and answers without a timeout flag', async () => {
    const { inbox } = make();
    const controller = new AbortController();
    const pending = inbox.read(A, 5_000, controller.signal);
    expect(inbox.waiterCount(A)).toBe(1);
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.messages).toEqual([]);
    expect(inbox.waiterCount(A)).toBe(0);
    // An already-aborted signal never registers a waiter.
    const dead = await inbox.read(A, 5_000, controller.signal);
    expect(dead.waitedMs).toBe(0);
    expect(inbox.waiterCount(A)).toBe(0);
  });

  it('clamps the wait like the wait primitives', () => {
    expect(clampWait(undefined)).toBe(DEFAULT_WAIT_MS);
    expect(clampWait(1)).toBe(MIN_WAIT_MS);
    expect(clampWait(MAX_WAIT_MS * 10)).toBe(MAX_WAIT_MS);
    expect(clampWait(5_000)).toBe(5_000);
  });
});

describe('persistence', () => {
  it('snapshot → restore round-trips and skips malformed entries', () => {
    const { inbox } = make();
    inbox.post(A, B, 'keep');
    const snap = inbox.snapshot();
    const fresh = new AgentInbox();
    expect(fresh.restore(snap)).toBe(1);
    expect(fresh.list(A).map((m) => m.text)).toEqual(['keep']);
    expect(fresh.restore({ version: 1, inboxes: { [A]: [{ id: 'x' }, 'junk', null] } })).toBe(0);
    expect(fresh.list(A)).toEqual([]);
    expect(fresh.restore(null)).toBe(0);
    expect(fresh.restore({ version: 2, inboxes: {} })).toBe(0);
    expect(fresh.restore('garbage')).toBe(0);
  });
});
