/**
 * @fileoverview Agent inbox: a per-session mailbox other agents can post to, and the
 * receiving agent reads WHEN IT WANTS TO.
 *
 * The other agent-to-agent channel — `POST /api/sessions/:id/input` — types into the
 * receiver's composer. That is the right primitive for a prompt, and the wrong one
 * for a message: every delivery starts (or interrupts) a billed turn, the receiver
 * cannot defer it, and for the fullscreen TUIs a stray byte is a dead session. The
 * inbox stores instead of typing: nothing reaches the pane, the receiver polls
 * (`codeman agent inbox --wait`) between its own steps, and a message is gone only
 * when the receiver acknowledges it.
 *
 * Invariants:
 * - Module-level singleton in the style of `session-wait-registry.ts` /
 *   `approval-inbox.ts`: no `Session` import, no IO; the server injects the
 *   `onMessage`/`onChange` callbacks (SSE, persistence).
 * - Bounded: `MAX_MESSAGES_PER_INBOX` per session and `MAX_TEXT_LENGTH` per message.
 *   A full inbox REJECTS the post (the sender learns) rather than dropping the
 *   oldest (the receiver would never know what it missed).
 * - Reads are non-destructive. `ack(ids)` removes; a client that crashes between
 *   read and ack sees the message again, never loses it.
 * - Long-poll waiters are bounded per session (`MAX_INBOX_WAITERS_PER_SESSION`) and
 *   resolve on the first post, on `drop()`, on `stop()`, or on timeout — never hang.
 * - Persistence is a whole-store snapshot the server writes on `onChange`; a message
 *   survives a server restart (deploys use KillMode=process, sessions survive too).
 *
 * @consumedby web/routes/inbox-routes, web/server (callbacks, persistence, drop on cleanup)
 * @module web/agent-inbox
 */

import { randomUUID } from 'node:crypto';
import { MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS } from '../config/agent-wait.js';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** Messages one inbox holds before posts are refused. */
export const MAX_MESSAGES_PER_INBOX = 200;
/** Characters per message. Big payloads belong in the workspace; send a path. */
export const MAX_TEXT_LENGTH = 16_384;
/** Characters for the free-form `from` label (usually a session id). */
export const MAX_FROM_LENGTH = 128;
/** Concurrent long-polls on one inbox. */
export const MAX_INBOX_WAITERS_PER_SESSION = 4;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InboxMessage {
  id: string;
  /** Who posted: the sender's session id, or a label the sender chose. */
  from: string;
  text: string;
  createdAt: number;
}

export interface InboxSnapshot {
  version: 1;
  inboxes: Record<string, InboxMessage[]>;
}

export interface InboxReadResult {
  messages: InboxMessage[];
  /** Messages still in the inbox after this read (reads do not ack). */
  pending: number;
  /** True when a `wait` ran its full budget with nothing arriving. */
  timedOut: boolean;
  /** The wait actually applied after clamping, 0 for a plain read. */
  waitedMs: number;
}

export type PostResult =
  | { ok: true; message: InboxMessage; pending: number }
  | { ok: false; reason: 'full' | 'text-too-long' | 'text-empty' | 'from-too-long' | 'stopped' };

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class AgentInbox {
  private readonly inboxes = new Map<string, InboxMessage[]>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private stopped = false;

  /** A message landed: `{sessionId, message, pending}`. The server maps it to SSE. */
  onMessage: ((sessionId: string, message: InboxMessage, pending: number) => void) | undefined;
  /** Any mutation (post, ack, clear, drop, prune). The server persists on it. */
  onChange: (() => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Store a message for `sessionId`. Never touches the session's pane. */
  post(sessionId: string, from: string, text: string): PostResult {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (text.length === 0) return { ok: false, reason: 'text-empty' };
    if (text.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'text-too-long' };
    if (from.length > MAX_FROM_LENGTH) return { ok: false, reason: 'from-too-long' };
    const queue = this.inboxes.get(sessionId) ?? [];
    if (queue.length >= MAX_MESSAGES_PER_INBOX) return { ok: false, reason: 'full' };
    const message: InboxMessage = { id: randomUUID(), from, text, createdAt: this.now() };
    queue.push(message);
    this.inboxes.set(sessionId, queue);
    this.onChange?.();
    this.onMessage?.(sessionId, message, queue.length);
    this.releaseWaiters(sessionId);
    return { ok: true, message, pending: queue.length };
  }

  /** Every pending message, oldest first. Non-destructive. */
  list(sessionId: string): InboxMessage[] {
    return [...(this.inboxes.get(sessionId) ?? [])];
  }

  pendingCount(sessionId: string): number {
    return this.inboxes.get(sessionId)?.length ?? 0;
  }

  /**
   * Read, blocking up to `waitMs` (clamped to the agent-wait bounds) while the inbox
   * is empty. Resolves at once with what is there when it is not empty; a wait that
   * ends by timeout, `drop()` or `stop()` answers with an empty list and `timedOut`
   * set only for the timeout case.
   */
  async read(sessionId: string, waitMs?: number, abortSignal?: AbortSignal): Promise<InboxReadResult> {
    const existing = this.list(sessionId);
    if (existing.length > 0 || waitMs === undefined || this.stopped || abortSignal?.aborted) {
      return { messages: existing, pending: existing.length, timedOut: false, waitedMs: 0 };
    }
    const applied = clampWait(waitMs);
    const ended = await this.waitForPost(sessionId, applied, abortSignal);
    const messages = this.list(sessionId);
    // `timedOut` is which path released the waiter, never a clock comparison: the
    // timer runs on libuv's cached loop time and can fire a few ms before Date.now()
    // agrees, which read as "not a timeout" and told the CLI the inbox was simply empty.
    return { messages, pending: messages.length, timedOut: ended === 'timeout', waitedMs: applied };
  }

  /** How many waiters `sessionId` has right now (for the cap check in the route). */
  waiterCount(sessionId: string): number {
    return this.waiters.get(sessionId)?.size ?? 0;
  }

  /** Remove the given messages. Unknown ids are ignored. Returns how many were removed. */
  ack(sessionId: string, ids: readonly string[]): number {
    const queue = this.inboxes.get(sessionId);
    if (!queue || ids.length === 0) return 0;
    const drop = new Set(ids);
    const kept = queue.filter((m) => !drop.has(m.id));
    const removed = queue.length - kept.length;
    if (removed === 0) return 0;
    if (kept.length === 0) this.inboxes.delete(sessionId);
    else this.inboxes.set(sessionId, kept);
    this.onChange?.();
    return removed;
  }

  /** Empty one inbox. Returns how many messages were discarded. */
  clear(sessionId: string): number {
    const count = this.pendingCount(sessionId);
    if (count === 0) return 0;
    this.inboxes.delete(sessionId);
    this.onChange?.();
    return count;
  }

  /**
   * The session was DETACHED (kept for recovery): release its waiters, keep its mail.
   * A re-adopted session comes back to the messages posted while it was away.
   */
  detach(sessionId: string): void {
    this.releaseWaiters(sessionId);
  }

  /**
   * Boot-time sweep: discard inboxes whose session did not come back. Every route
   * needs the session to exist, so an orphan could otherwise never be removed and
   * would ride the snapshot forever. Returns how many inboxes were dropped.
   */
  pruneExcept(keep: Iterable<string>): number {
    const alive = new Set(keep);
    let dropped = 0;
    for (const sessionId of [...this.inboxes.keys()]) {
      if (alive.has(sessionId)) continue;
      this.inboxes.delete(sessionId);
      dropped++;
    }
    if (dropped > 0) this.onChange?.();
    return dropped;
  }

  /** The session is gone: discard its inbox and release anyone waiting on it. */
  drop(sessionId: string): void {
    const had = this.inboxes.delete(sessionId);
    this.releaseWaiters(sessionId);
    if (had) this.onChange?.();
  }

  /** Whole-store snapshot for persistence. */
  snapshot(): InboxSnapshot {
    const inboxes: Record<string, InboxMessage[]> = {};
    for (const [sessionId, queue] of this.inboxes) inboxes[sessionId] = [...queue];
    return { version: 1, inboxes };
  }

  /**
   * Replace the store from a snapshot (server boot). Malformed input is ignored
   * entry by entry rather than throwing: a corrupt file must not stop the server.
   */
  restore(snapshot: unknown): number {
    const data = snapshot as Partial<InboxSnapshot> | null;
    if (!data || data.version !== 1 || typeof data.inboxes !== 'object' || data.inboxes === null) return 0;
    let restored = 0;
    this.inboxes.clear();
    for (const [sessionId, queue] of Object.entries(data.inboxes)) {
      if (!Array.isArray(queue)) continue;
      const valid = queue.filter(isInboxMessage).slice(0, MAX_MESSAGES_PER_INBOX);
      if (valid.length === 0) continue;
      this.inboxes.set(sessionId, valid);
      restored += valid.length;
    }
    return restored;
  }

  /** Server shutdown: release every waiter so no response hangs. */
  stop(): void {
    this.stopped = true;
    for (const sessionId of [...this.waiters.keys()]) this.releaseWaiters(sessionId);
  }

  /** Test hook: back to an empty, running store. */
  resetForTests(): void {
    this.stop();
    this.stopped = false;
    this.inboxes.clear();
    this.waiters.clear();
    this.onMessage = undefined;
    this.onChange = undefined;
  }

  /**
   * One waiter, released by a post, by timeout, or by the caller's abort signal;
   * the result names which. The abort path matters for the waiter cap: a client that hangs
   * up mid-poll must give its slot back now, not when the timeout fires.
   */
  private waitForPost(
    sessionId: string,
    waitMs: number,
    abortSignal?: AbortSignal
  ): Promise<'post' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set<Waiter>();
      const remove = () => {
        set.delete(waiter);
        if (set.size === 0 && this.waiters.get(sessionId) === set) this.waiters.delete(sessionId);
      };
      const onAbort = () => {
        clearTimeout(waiter.timer);
        remove();
        resolve('aborted');
      };
      const waiter: Waiter = {
        resolve: () => {
          abortSignal?.removeEventListener('abort', onAbort);
          resolve('post');
        },
        timer: setTimeout(() => {
          abortSignal?.removeEventListener('abort', onAbort);
          remove();
          resolve('timeout');
        }, waitMs),
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      set.add(waiter);
      this.waiters.set(sessionId, set);
    });
  }

  private releaseWaiters(sessionId: string): void {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    this.waiters.delete(sessionId);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

/** Same clamp as the wait primitives, so `?wait=` behaves like `?timeout=` elsewhere. */
export function clampWait(waitMs: number | undefined): number {
  if (waitMs === undefined) return DEFAULT_WAIT_MS;
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, waitMs));
}

function isInboxMessage(value: unknown): value is InboxMessage {
  const m = value as Partial<InboxMessage> | null;
  return (
    !!m &&
    typeof m.id === 'string' &&
    typeof m.from === 'string' &&
    typeof m.text === 'string' &&
    m.text.length <= MAX_TEXT_LENGTH &&
    typeof m.createdAt === 'number'
  );
}

export const agentInbox = new AgentInbox();
