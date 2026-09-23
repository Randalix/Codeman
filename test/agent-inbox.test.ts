/**
 * @fileoverview The agent inbox store (src/web/agent-inbox.ts): bounds, non-destructive
 * reads, ack semantics, long-poll release paths, and the persistence round trip.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AgentInbox,
  MAX_MESSAGES_PER_INBOX,
  MAX_TEXT_LENGTH,
  WAITING_GRACE_MS,
  clampWait,
} from '../src/web/agent-inbox.js';
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

describe('seen / ackSeen — reading no longer acknowledges', () => {
  it('read marks exactly the returned messages as seen; ackSeen removes them', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'one');
    inbox.post(A, B, 'two');
    await inbox.read(A);
    expect(inbox.pendingCount(A)).toBe(2); // a plain read is non-destructive
    expect(inbox.ackSeen(A)).toBe(2);
    expect(inbox.pendingCount(A)).toBe(0);
  });

  it('ackSeen never removes a message that arrived after the read', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'order');
    await inbox.read(A);
    inbox.post(A, B, 'please stop'); // the sender posts again while the receiver works
    expect(inbox.ackSeen(A)).toBe(1);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['please stop']);
  });

  it('peek marks nothing, so ackSeen leaves the message in place', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'order');
    await inbox.read(A, 60_000, undefined, { peek: true });
    expect(inbox.ackSeen(A)).toBe(0);
    expect(inbox.pendingCount(A)).toBe(1);
  });

  it('a second read of the same message stays seen; an empty ackSeen is a no-op with no change event', async () => {
    const { inbox } = make();
    const onChange = vi.fn();
    inbox.onChange = onChange;
    inbox.post(A, B, 'x'); // one change event
    await inbox.read(A);
    await inbox.read(A);
    expect(inbox.ackSeen(A)).toBe(1); // exactly one removal
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(inbox.ackSeen(A)).toBe(0); // nothing seen anymore: no mutation
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('clear() and drop() forget the seen set so stale ids cannot acknowledge a later message', async () => {
    const { inbox } = make();
    inbox.post(A, B, 'x');
    await inbox.read(A);
    inbox.clear(A);
    inbox.post(A, B, 'y');
    expect(inbox.ackSeen(A)).toBe(0);
    expect(inbox.list(A).map((m) => m.text)).toEqual(['y']);

    inbox.drop(A);
    inbox.post(A, B, 'z');
    await inbox.read(A);
    expect(inbox.ackSeen(A)).toBe(1);
  });

  it('an explicit ack removes the id from the seen set too', async () => {
    const { inbox } = make();
    const r = inbox.post(A, B, 'x');
    if (!r.ok) throw new Error('unreachable');
    await inbox.read(A);
    expect(inbox.ack(A, [r.message.id])).toBe(1);
    expect(inbox.ackSeen(A)).toBe(0); // already acked, no double count
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

describe('summary — who is waiting for whom', () => {
  // The state that cost a planner/builder pair 26 minutes: one side parked on its
  // inbox, the other idle with nothing to read. The store records since WHEN a
  // session has been waiting; the CLI folds it into `ls`.
  it('reports pending counts and a wait that began with the first waiter', async () => {
    const { inbox, tick } = make();
    inbox.post(B, A, 'unread');
    expect(inbox.summary().get(B)).toEqual({ pending: 1, waiting: false, waitingSince: null });

    const pending = inbox.read(A, 5_000);
    const since = 1_000;
    expect(inbox.summary().get(A)).toEqual({ pending: 0, waiting: true, waitingSince: since });
    tick(4_000);
    expect(inbox.summary().get(A)?.waitingSince).toBe(since); // still the first one

    inbox.post(A, B, 'here you go');
    await pending;
    // Released by a post: the wait is over.
    expect(inbox.summary().get(A)).toEqual({ pending: 1, waiting: false, waitingSince: null });
  });

  it('keeps the wait clock across the timeout slices of a looping long-poll', async () => {
    // `inbox --wait 590000` in a Monitor loops: each slice ends in a timeout and the
    // next request follows within milliseconds. Resetting on every slice would make
    // `ls` say "waiting since just now" every ten minutes.
    vi.useFakeTimers();
    try {
      let t = 10_000;
      const inbox = new AgentInbox(() => t);
      const first = inbox.read(A, MIN_WAIT_MS);
      await vi.advanceTimersByTimeAsync(MIN_WAIT_MS);
      t += MIN_WAIT_MS;
      expect((await first).timedOut).toBe(true);
      // Between slices: still waiting, inside the grace.
      expect(inbox.summary().get(A)).toEqual({ pending: 0, waiting: true, waitingSince: 10_000 });
      t += 50;
      const second = inbox.read(A, MIN_WAIT_MS);
      expect(inbox.summary().get(A)?.waitingSince).toBe(10_000);
      inbox.post(A, B, 'x');
      await second;
      expect(inbox.summary().get(A)?.waiting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a wait whose last waiter left longer ago than the grace', async () => {
    vi.useFakeTimers();
    try {
      let t = 10_000;
      const inbox = new AgentInbox(() => t);
      const pending = inbox.read(A, MIN_WAIT_MS);
      await vi.advanceTimersByTimeAsync(MIN_WAIT_MS);
      t += MIN_WAIT_MS;
      await pending;
      t += WAITING_GRACE_MS + 1;
      expect(inbox.summary().get(A)).toBeUndefined(); // no mail, no waiter: not listed at all
      // A NEW wait after the grace starts a new clock.
      const later = inbox.read(A, MIN_WAIT_MS);
      expect(inbox.summary().get(A)?.waitingSince).toBe(t);
      inbox.drop(A);
      await later;
    } finally {
      vi.useRealTimers();
    }
  });

  it('an aborted wait counts as left, a drop as over', async () => {
    const { inbox, tick } = make();
    const controller = new AbortController();
    const pending = inbox.read(A, 5_000, controller.signal);
    controller.abort();
    await pending;
    expect(inbox.summary().get(A)?.waiting).toBe(true); // inside the grace
    tick(WAITING_GRACE_MS + 1);
    expect(inbox.summary().get(A)).toBeUndefined();

    const other = inbox.read(B, 5_000);
    inbox.drop(B);
    await other;
    expect(inbox.summary().get(B)).toBeUndefined();
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
