/**
 * @fileoverview Inbox nudger: one short prompt typed into a session that has mail it
 * would otherwise never read.
 *
 * The inbox (`agent-inbox.ts`) is pull-only by design — nothing reaches the pane. That
 * holds up while the receiver is parked on `codeman agent inbox --wait`, and fails the
 * moment it ends its turn with "waiting for review": an idle agent reads its mailbox
 * only when something prompts it, so a coordinator's order (and the worker's report
 * back) sat unread until a human typed `agent send` by hand — every hand-off, both
 * directions.
 *
 * So after a post the nudger checks, once the burst has settled, whether the receiver
 * will see the mail on its own. Only when it will not does it type ONE line into the
 * composer, through the same path `agent send` uses.
 *
 * Invariants:
 * - Nudges only for UNSEEN mail (`agentInbox.unseen`) and never while someone is
 *   parked on the inbox (`--peek` monitor loops included): a waiting receiver reacts
 *   to the post by itself and is never typed at. Each message
 *   is nudged at most once; later posts nudge again, but no more often than
 *   `NUDGE_COOLDOWN_MS` per session.
 * - A busy session is nudged on its next `idle` event, not mid-turn. Status is a
 *   heuristic for some modes, so after `NUDGE_MAX_DEFER_MS` it is typed anyway — the
 *   agent CLIs queue input that arrives during a turn.
 * - Never types over a human's half-written prompt (`hasDraft`): that would submit it.
 *   Never gives up on it either: while the mail is unread it looks again every
 *   `NUDGE_COOLDOWN_MS`, and once the draft is sent or cleared the normal path runs.
 * - Shell mode types only when the pane's foreground process is an agent CLI; into a
 *   bare shell the text would run as a command.
 * - NEVER wakes a host. A remote session is nudged only when its host answers a plain
 *   TCP probe; a sleeping host keeps the mail until something legitimate wakes it.
 *   This module has no access to the wake registry (wiring guard in the tests).
 * - Opt-out per post (`nudge: false`, CLI `--no-nudge`) and globally
 *   (`CODEMAN_INBOX_NUDGE=0`).
 *
 * @consumedby web/routes/inbox-routes (schedule), web/server (deps)
 * @module web/inbox-nudger
 */

import type { InboxMessage } from './agent-inbox.js';

/** Posts arriving within this window share one nudge. */
export const NUDGE_DEBOUNCE_MS = 2_000;
/** Minimum gap between two nudges into the same session. */
export const NUDGE_COOLDOWN_MS = 30_000;
/** How long a busy session is left alone before the nudge is typed anyway. */
export const NUDGE_MAX_DEFER_MS = 5 * 60_000;

/** The slice of a Session the nudger reads. */
export interface NudgeTarget {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly remote: { host: string; port?: number } | undefined;
  writeViaMux(data: string): Promise<boolean>;
  /** Someone has unsubmitted text in the composer (see Session.hasDraft). */
  hasDraft(): boolean;
  once(event: 'idle', listener: () => void): unknown;
  off(event: 'idle', listener: () => void): unknown;
}

export interface InboxNudgerDeps {
  getSession(id: string): NudgeTarget | undefined;
  unseen(id: string): InboxMessage[];
  pendingCount(id: string): number;
  /**
   * Someone is (or within the grace just was) parked on this inbox. Covers a `--peek`
   * monitor loop, whose reads mark nothing seen but which does react to the post.
   */
  isWaiting(id: string): boolean;
  /** The session's CLI is a plain shell (registry `kind: 'shell'`), not an agent. */
  isShellMode(mode: string): boolean;
  /**
   * The pane's foreground process (`#{pane_current_command}`) is an agent CLI binary
   * from the registry. False when unknown.
   */
  agentInForeground(session: NudgeTarget): boolean;
  /** Plain TCP probe of a remote host. Must never wake it. */
  probeRemote(remote: { host: string; port?: number }): Promise<boolean>;
  enabled(): boolean;
  now(): number;
  log(message: string): void;
}

interface NudgeState {
  timer: NodeJS.Timeout | null;
  /** Message ids already announced to the session. */
  nudged: Set<string>;
  lastNudgeAt: number;
  /** Set while waiting for a busy session's `idle`. */
  deferredSince: number | null;
  idleListener: (() => void) | null;
  /** A draft blocked the nudge and was logged; cleared once the draft is gone. */
  draftLogged: boolean;
}

/** The line typed into the receiver's composer. Printable only, plus the caller's `\r`. */
export function nudgeText(fresh: readonly InboxMessage[], pending: number): string {
  const senders = [...new Set(fresh.map((m) => shortId(m.from)))].join(', ');
  const count = fresh.length === 1 ? '1 new message' : `${fresh.length} new messages`;
  return (
    `[codeman inbox] ${count} from ${senders} (${pending} pending). ` +
    'Read it with `codeman agent inbox`, act on it, then `codeman agent ack`.'
  );
}

function shortId(from: string): string {
  const clean = from.replace(/[^\x20-\x7e]/g, '');
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clean) ? clean.slice(0, 8) : clean.slice(0, 40);
}

export class InboxNudger {
  private readonly states = new Map<string, NudgeState>();
  private stopped = false;

  constructor(private readonly deps: InboxNudgerDeps) {}

  /**
   * A message was posted to `sessionId` by `from`. Settles, then decides.
   * `receiverWaiting`: a long-poll was parked when it landed — the post released it,
   * which also cleared the inbox's wait state, so only the caller can still tell.
   * That message counts as announced (a `--peek` loop saw it without marking it seen).
   */
  schedule(
    sessionId: string,
    from: string,
    opts: { nudge?: boolean; messageId?: string; receiverWaiting?: boolean } = {}
  ): void {
    if (this.stopped || opts.nudge === false || from === sessionId || !this.deps.enabled()) return;
    const state = this.state(sessionId);
    if (opts.receiverWaiting) {
      if (opts.messageId) state.nudged.add(opts.messageId);
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.check(sessionId);
    }, NUDGE_DEBOUNCE_MS);
  }

  /** Forget a session (deleted). */
  drop(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.clearTimers(sessionId, state);
    this.states.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    for (const [id, state] of this.states) this.clearTimers(id, state);
    this.states.clear();
  }

  /** Decide and, when needed, type. Public for tests; the timer calls it. */
  async check(sessionId: string): Promise<'nudged' | 'deferred' | 'skipped'> {
    if (this.stopped) return 'skipped';
    const state = this.state(sessionId);
    const fresh = this.deps.unseen(sessionId).filter((m) => !state.nudged.has(m.id));
    if (fresh.length === 0 || this.deps.isWaiting(sessionId)) {
      // Read (or about to be) without us: forget any deferral, or a later post would
      // inherit its age and be typed into a busy session at once.
      this.clearTimers(sessionId, state);
      state.deferredSince = null;
      return 'skipped';
    }

    const session = this.deps.getSession(sessionId);
    if (!session || session.status === 'stopped' || session.status === 'error') return 'skipped';

    const now = this.deps.now();
    const sinceLast = now - state.lastNudgeAt;
    if (state.lastNudgeAt > 0 && sinceLast < NUDGE_COOLDOWN_MS) {
      this.retryIn(sessionId, state, NUDGE_COOLDOWN_MS - sinceLast);
      return 'deferred';
    }

    if (session.status === 'busy') {
      if (state.deferredSince === null) state.deferredSince = now;
      if (now - state.deferredSince < NUDGE_MAX_DEFER_MS) {
        this.deferUntilIdle(sessionId, session, state, NUDGE_MAX_DEFER_MS - (now - state.deferredSince));
        return 'deferred';
      }
    }

    if (session.hasDraft()) {
      // A human is mid-prompt: our line plus Enter would submit their draft. Look again
      // until it is sent or cleared — giving up left the mail unannounced for hours
      // (2026-10-09/10). Waiting for the human is not a busy defer: reset it, so a
      // submitted draft's turn gets the full idle wait before we type.
      state.deferredSince = null;
      if (!state.draftLogged) {
        state.draftLogged = true;
        this.deps.log(
          `[InboxNudger] ${sessionId.slice(0, 8)}: unsubmitted draft in the composer, retrying until it is gone`
        );
      }
      this.retryIn(sessionId, state, NUDGE_COOLDOWN_MS);
      return 'deferred';
    }
    state.draftLogged = false;

    if (this.deps.isShellMode(session.mode) && !this.deps.agentInForeground(session)) return 'skipped';
    if (session.remote && !(await this.deps.probeRemote(session.remote))) {
      this.deps.log(`[InboxNudger] ${sessionId.slice(0, 8)}: remote host unreachable, mail stays unannounced`);
      return 'skipped';
    }

    // The probe awaited; a read may have happened meanwhile.
    const still = this.deps.unseen(sessionId).filter((m) => !state.nudged.has(m.id));
    if (still.length === 0 || this.stopped) return 'skipped';

    this.clearTimers(sessionId, state);
    state.deferredSince = null;
    state.lastNudgeAt = this.deps.now();
    for (const m of still) state.nudged.add(m.id);
    this.pruneNudged(sessionId, state);
    const ok = await session.writeViaMux(`${nudgeText(still, this.deps.pendingCount(sessionId))}\r`).catch(() => false);
    if (!ok) {
      this.deps.log(`[InboxNudger] ${sessionId.slice(0, 8)}: nudge could not be written`);
      return 'skipped';
    }
    return 'nudged';
  }

  private state(sessionId: string): NudgeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        timer: null,
        nudged: new Set(),
        lastNudgeAt: 0,
        deferredSince: null,
        idleListener: null,
        draftLogged: false,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private retryIn(sessionId: string, state: NudgeState, ms: number): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(
      () => {
        state.timer = null;
        void this.check(sessionId);
      },
      Math.max(0, ms)
    );
  }

  private deferUntilIdle(sessionId: string, session: NudgeTarget, state: NudgeState, fallbackMs: number): void {
    if (!state.idleListener) {
      const listener = () => {
        state.idleListener = null;
        void this.check(sessionId);
      };
      state.idleListener = listener;
      session.once('idle', listener);
    }
    this.retryIn(sessionId, state, fallbackMs);
  }

  private clearTimers(sessionId: string, state: NudgeState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.idleListener) {
      this.deps.getSession(sessionId)?.off('idle', state.idleListener);
      state.idleListener = null;
    }
  }

  /** Keep `nudged` bounded: ids that are no longer pending cannot come back. */
  private pruneNudged(sessionId: string, state: NudgeState): void {
    if (state.nudged.size <= this.deps.pendingCount(sessionId)) return;
    const pending = new Set(this.deps.unseen(sessionId).map((m) => m.id));
    for (const id of state.nudged) if (!pending.has(id)) state.nudged.delete(id);
  }
}
