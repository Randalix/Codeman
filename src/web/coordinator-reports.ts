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
 * @consumedby web/server (subscribes to turnWatch, drops on delete)
 * @module web/coordinator-reports
 */

import type { WatchRow } from './routes/agent-watch-routes.js';

/** Signals for one worker arriving within this window share one report. */
export const REPORT_DEBOUNCE_MS = 1_500;

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
  /** Post into `to`'s mailbox as `from` (and schedule its nudge). False when refused. */
  post(to: string, from: string, text: string): boolean;
  enabled(): boolean;
  log(message: string): void;
}

/** What the worker looked like when the signal came: an exited one may be gone by report time. */
interface Pending {
  timer: NodeJS.Timeout;
  parent: string;
  name: string;
}

/** HH:MM in server-local time, like `agent watch` prints it. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The report line; the same columns `agent watch` prints, plus where to look next. */
export function reportText(row: WatchRow): string {
  const what =
    row.reason === 'exited' || row.turnEndSource === 'exit' ? 'EXITED' : row.reason === 'blocked' ? 'BLOCKED' : 'IDLE';
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
  private stopped = false;

  constructor(private readonly deps: CoordinatorReportDeps) {}

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
    if (!session) {
      // Closed between the exit and the report: the coordinator must still learn it.
      text = `[codeman watch] GONE  ${sessionId.slice(0, 8)}  ${name}`;
    } else {
      const row = this.deps.row(sessionId);
      if (!row) return 'skipped'; // a new turn already runs
      if (this.reported.get(sessionId) === row.turnEndedAt) return 'skipped';
      if (row.reason !== 'blocked' && row.turnEndSource === 'heuristic' && session.turnEndReady) return 'skipped';
      this.reported.set(sessionId, row.turnEndedAt);
      text = reportText(row);
    }
    if (!this.deps.post(parent, sessionId, text)) {
      this.deps.log(`[CoordinatorReports] ${sessionId.slice(0, 8)} → ${parent.slice(0, 8)}: report not posted`);
      return 'skipped';
    }
    return 'posted';
  }

  /** Forget a session (deleted). A pending exit report still goes out. */
  drop(sessionId: string): void {
    this.reported.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
