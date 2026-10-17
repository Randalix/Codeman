/**
 * @fileoverview Coordinator reports: a worker's turn end, dialog or exit, posted into the
 * mailbox of the session that spawned it.
 *
 * `agent watch` answers "which of my workers needs me?" — but only while the
 * coordinator runs it. A coordinator that ended its turn, or sat parked on its own
 * `inbox --wait`, heard nothing: workers finished and stayed idle until someone read
 * `agent ls` (nb-wp*, w3c, 2026-10-10). This is the push side of the same signal. It
 * hears every `turnWatch.notify` (stop hook, idle heuristic, pane exit, blocking
 * dialog), builds the row `agent watch` would print, and posts it to the parent's
 * mailbox under the worker's id. The post goes through the normal path, so a parked
 * `inbox --wait` wakes, an idle coordinator gets a nudge, a busy one is left to finish.
 *
 * Invariants:
 * - Receiver is the worker's `parentSessionId`, only while that session exists. No
 *   parent, a dead parent or a self-parent → nothing.
 * - One report per latch stamp: hook + heuristic for the same turn report once.
 * - A pane that merely became ready (launch, adoption after a restart) reports
 *   nothing (`turnEndReady`); its turn has not ended, it never began. Without this,
 *   every deploy posted an IDLE for every idle worker.
 * - A turn that restarted within the debounce reports nothing — the worker is busy.
 * - A full mailbox drops the report with a log line; never throws into the session.
 * - NEVER wakes a host: posting is local; the nudger keeps its own remote rule.
 * - Off globally with `CODEMAN_COORDINATOR_REPORTS=0`.
 *
 * Digest (w3c, 2026-10-11: ~20 IDLE posts an hour, each one ended the coordinator's
 * `inbox --wait` and cost it a turn with nothing to do; the real result comes as the
 * worker's own post anyway):
 * - IDLE reports are QUIET mailbox messages (`agent-inbox.ts`): they never end a wait
 *   and draw no nudge, and are read together with the next loud mail or when the
 *   coordinator's wait slice runs out. BLOCKED, EXITED and GONE stay loud.
 * - Except an IDLE whose reason is `done` or `api-error` (LOUD_IDLE_REASONS): `done`
 *   means nothing is left open on the worker's side, the hand-off the coordinator is
 *   waiting for; `api-error` is a worker that sits until someone acts. Quiet, either sat
 *   up to a whole wait slice (10 min) in the mailbox (Joe, 2026-10-17). They go out
 *   loud; a muted worker still reports no IDLE at all.
 * - Every report from a worker replaces that worker's unseen quiet line, so the
 *   mailbox holds one current status per worker, not a backlog.
 * - `waiting-inbox` is not reported at all: the worker is correctly parked on its own
 *   mailbox (`agent ls` shows it under WAIT). Its older unseen line is withdrawn,
 *   since it no longer holds.
 *
 * Mute (`agent mute <worker> --for 30m`): a worker that babysits a long process ends a
 * short turn every minute, and each one was an IDLE in the coordinator's mailbox (w3c,
 * ~45 in 34 minutes, 2026-10-11). A muted worker's IDLE reports are dropped; BLOCKED,
 * EXITED and GONE still go out — a dialog or a dead worker needs the coordinator either
 * way. A skipped stamp is not marked reported, so when the mute ends (expiry or
 * `unmute`) the worker's current state is reported once if it still stands idle. Mutes
 * are persisted: a deploy must not lift one (the nudger's restart lesson, 2026-10-11).
 *
 * @consumedby web/server (subscribes to turnWatch, drops on delete)
 * @module web/coordinator-reports
 */

import type { WatchRow } from './routes/agent-watch-routes.js';

/** Signals for one worker arriving within this window share one report. */
export const REPORT_DEBOUNCE_MS = 1_500;

/** Longest mute one call may set; a forgotten mute must run out on its own. */
export const MAX_MUTE_MS = 24 * 60 * 60_000;

/** Persisted mutes: worker id → epoch ms when its IDLE reports resume. */
export type MuteSnapshot = Record<string, number>;

/** The slice of a Session the reporter reads. */
export interface ReportSource {
  readonly id: string;
  readonly name: string;
  readonly parentSessionId: string | undefined;
  readonly turnEndReady: boolean;
}

export interface CoordinatorReportDeps {
  getSession(id: string): ReportSource | undefined;
  /** The row `GET /api/agent-watch` would report for this session now, or null. */
  row(id: string): WatchRow | null;
  /**
   * Post into `to`'s mailbox as `from`, replacing `from`'s unseen quiet line there. A
   * loud post also schedules the nudge; a quiet one neither wakes a wait nor nudges.
   * False when refused.
   */
  post(to: string, from: string, text: string, options: { quiet: boolean }): boolean;
  /** Withdraw `from`'s unseen quiet lines from `to`'s mailbox. */
  withdraw(to: string, from: string): void;
  enabled(): boolean;
  log(message: string): void;
  /** Persist the current mutes (called on every change). */
  saveMutes?(snapshot: MuteSnapshot): void;
  now?(): number;
}

/** What the worker looked like when the signal came: an exited one may be gone by report time. */
interface Pending {
  timer: NodeJS.Timeout;
  parent: string;
  name: string;
}

/**
 * IDLE reasons that wake the coordinator at once instead of waiting in the digest:
 * `done` is the worker's hand-off, `api-error` a worker that hangs until someone acts.
 */
const LOUD_IDLE_REASONS: ReadonlySet<WatchRow['reason']> = new Set(['done', 'api-error']);

/** HH:MM in server-local time, like `agent watch` prints it. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The headline word, as `agent watch` prints it. */
function reportKind(row: WatchRow): 'EXITED' | 'BLOCKED' | 'IDLE' {
  return row.reason === 'exited' || row.turnEndSource === 'exit'
    ? 'EXITED'
    : row.reason === 'blocked'
      ? 'BLOCKED'
      : 'IDLE';
}

/** The report line; the same columns `agent watch` prints, plus where to look next. */
export function reportText(row: WatchRow): string {
  const what = reportKind(row);
  const next = what === 'EXITED' ? '' : ` — answer: \`codeman agent read ${row.id.slice(0, 8)}\``;
  return (
    `[codeman watch] ${what}  ${row.id.slice(0, 8)}  ${row.mode}  since ${clock(row.turnEndedAt)} ` +
    `(${row.turnEndSource ?? 'dialog'})  ${row.reason}  todos ${row.openTodos}/${row.totalTodos}  ` +
    `inbox ${row.inboxPending}  ${row.name}${next}`
  );
}

export class CoordinatorReports {
  private readonly pending = new Map<string, Pending>();
  /** Worker id → the latch stamp last reported. */
  private readonly reported = new Map<string, number>();
  /** Worker id → when its mute ends, and the timer that ends it. */
  private readonly mutes = new Map<string, { until: number; timer: NodeJS.Timeout }>();
  private stopped = false;

  constructor(private readonly deps: CoordinatorReportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Hold `sessionId`'s IDLE reports for `ms` (capped at MAX_MUTE_MS); a second call
   * replaces the first. Returns when the mute ends.
   */
  mute(sessionId: string, ms: number): number {
    const until = this.now() + Math.min(Math.max(0, ms), MAX_MUTE_MS);
    this.arm(sessionId, until);
    this.saveMutes();
    return until;
  }

  /** Lift a mute now; the worker's current state is reported if it stands idle unreported. */
  unmute(sessionId: string): boolean {
    const had = this.clearMute(sessionId);
    if (had) {
      this.saveMutes();
      this.notify(sessionId);
    }
    return had;
  }

  /** When `sessionId`'s mute ends, or null when it is not muted. */
  mutedUntil(sessionId: string): number | null {
    return this.mutes.get(sessionId)?.until ?? null;
  }

  /** Re-arm persisted mutes at boot; ones that ran out while the server was down are dropped. */
  restoreMutes(snapshot: MuteSnapshot, keep: (sessionId: string) => boolean): number {
    let restored = 0;
    for (const [id, until] of Object.entries(snapshot)) {
      if (typeof until !== 'number' || until <= this.now() || !keep(id)) continue;
      this.arm(id, Math.min(until, this.now() + MAX_MUTE_MS));
      restored++;
    }
    if (restored !== Object.keys(snapshot).length) this.saveMutes();
    return restored;
  }

  private arm(sessionId: string, until: number): void {
    this.clearMute(sessionId);
    const timer = setTimeout(() => {
      this.mutes.delete(sessionId);
      this.saveMutes();
      this.notify(sessionId); // catch up on what the mute held back
    }, until - this.now());
    timer.unref?.();
    this.mutes.set(sessionId, { until, timer });
  }

  private clearMute(sessionId: string): boolean {
    const mute = this.mutes.get(sessionId);
    if (!mute) return false;
    clearTimeout(mute.timer);
    this.mutes.delete(sessionId);
    return true;
  }

  private saveMutes(): void {
    if (this.stopped) return;
    const snapshot: MuteSnapshot = {};
    for (const [id, m] of this.mutes) snapshot[id] = m.until;
    this.deps.saveMutes?.(snapshot);
  }

  /** A turn ended, a dialog opened or the pane exited in `sessionId`. Settles, then reports. */
  notify(sessionId: string): void {
    if (this.stopped || !this.deps.enabled()) return;
    const session = this.deps.getSession(sessionId);
    const parent = session?.parentSessionId;
    if (!session || !parent || parent === sessionId) return;
    const prev = this.pending.get(sessionId);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      this.report(sessionId, parent, session.name);
    }, REPORT_DEBOUNCE_MS);
    this.pending.set(sessionId, { timer, parent, name: session.name });
  }

  /** Decide and post. Public for tests; the timer calls it. */
  report(sessionId: string, parent: string, name: string): 'posted' | 'skipped' {
    if (this.stopped || !this.deps.getSession(parent)) return 'skipped';
    const session = this.deps.getSession(sessionId);
    let text: string;
    let quiet = false;
    if (!session) {
      // Closed between the exit and the report: the coordinator must still learn it.
      text = `[codeman watch] GONE  ${sessionId.slice(0, 8)}  ${name}`;
    } else {
      const row = this.deps.row(sessionId);
      if (!row) return 'skipped'; // a new turn already runs
      if (this.reported.get(sessionId) === row.turnEndedAt) return 'skipped';
      if (row.reason !== 'blocked' && row.turnEndSource === 'heuristic' && session.turnEndReady) return 'skipped';
      // Muted: drop an IDLE without marking it reported, so the end of the mute catches up.
      if (this.mutes.has(sessionId) && reportKind(row) === 'IDLE') return 'skipped';
      this.reported.set(sessionId, row.turnEndedAt);
      // Only an IDLE line is suppressed: a pane exit still says EXITED.
      if (row.reason === 'waiting-inbox' && reportKind(row) === 'IDLE') {
        this.deps.withdraw(parent, sessionId);
        return 'skipped';
      }
      text = reportText(row);
      quiet = reportKind(row) === 'IDLE' && !LOUD_IDLE_REASONS.has(row.reason);
    }
    if (!this.deps.post(parent, sessionId, text, { quiet })) {
      this.deps.log(`[CoordinatorReports] ${sessionId.slice(0, 8)} → ${parent.slice(0, 8)}: report not posted`);
      return 'skipped';
    }
    return 'posted';
  }

  /** Forget a session (deleted). A pending exit report still goes out. */
  drop(sessionId: string): void {
    this.reported.delete(sessionId);
    if (this.clearMute(sessionId)) this.saveMutes();
  }

  stop(): void {
    this.stopped = true;
    for (const m of this.mutes.values()) clearTimeout(m.timer);
    this.mutes.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
