/**
 * @fileoverview `GET /api/agent-watch` — a coordinator's "which of my workers is
 * waiting for input?", answered from a latch instead of an edge.
 *
 * Query: `sessions` (comma list of full ids), `since` (the `cursor` of the previous
 * answer), `wait` (ms to block while nothing qualifies; absent = answer at once).
 *
 * Level-triggered with a cursor: every session whose `turnEndedAt >= since` (or, with
 * no `since`, whose turn is over at all) is reported at once; otherwise the request
 * parks on `turnWatch` until a stamp lands. The answer's `cursor` is the server time
 * of the scan that produced it, so feeding it back as `since` can neither lose a turn
 * that ended after that scan nor report again one that ended before it (a stamp in the
 * same millisecond may repeat; a duplicate is harmless, a gap is not). A session that
 * is gone, or that the caller may not see, is listed under `gone` — never a 404 that
 * would abort the whole watch.
 *
 * A pending permission/question dialog (`approvalInbox`) qualifies a session too, at
 * the dialog's time: a worker stuck on its own menu has not ended its turn, but it is
 * exactly the one a coordinator must hear about first.
 *
 * Each row carries a `reason`, classified from data Codeman already holds, so the
 * coordinator does not have to read every transcript to decide what to do:
 *   exited · blocked (dialog) · api-error (pane tail) · waiting-inbox (parked on
 *   `inbox --wait`, a deliberate wait) · inbox-unread · inbox-unacked (read, never
 *   acknowledged) · open-todos · done
 * The order is the precedence. It is a hint for the coordinator, never a verdict.
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { AgentWatchQuerySchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { agentInbox, clampWait } from '../agent-inbox.js';
import { approvalInbox } from '../approval-inbox.js';
import type { Session } from '../../session.js';
import { turnWatch, MAX_TURN_WATCHERS, MAX_WATCH_SESSIONS } from '../agent-watch.js';
import type { SessionPort } from '../ports/index.js';

export type WatchReason =
  | 'exited'
  | 'blocked'
  | 'api-error'
  | 'waiting-inbox'
  | 'inbox-unread'
  | 'inbox-unacked'
  | 'open-todos'
  | 'done';

export interface WatchRow {
  id: string;
  name: string;
  mode: string;
  status: string;
  /** When it qualified: the turn end, or the pending dialog's time if later. */
  turnEndedAt: number;
  turnEndSource: string | null;
  reason: WatchReason;
  /** Todos not completed / all todos on the session's list. */
  openTodos: number;
  totalTodos: number;
  /** Mail in the session's inbox: all pending, and the part no read has handed out yet. */
  inboxPending: number;
  inboxUnseen: number;
}

/**
 * Claude prints a failed request as its own line under the turn
 * (`⎿  API Error: Can't reach the API server (ENOTFOUND)`, measured on a worker that
 * then sat idle overnight). Anchored to a line start so prose that merely mentions
 * the phrase does not count.
 */
const API_ERROR_LINE = /^[\s⎿]*API Error\b/m;

export function classifyWatchReason(
  session: Pick<Session, 'turnEndSource' | 'paneText'>,
  facts: { blocked: boolean; inboxWaiting: boolean; inboxUnseen: number; inboxPending: number; openTodos: number }
): WatchReason {
  if (session.turnEndSource === 'exit') return 'exited';
  if (facts.blocked) return 'blocked';
  if (API_ERROR_LINE.test(session.paneText())) return 'api-error';
  if (facts.inboxWaiting) return 'waiting-inbox';
  if (facts.inboxUnseen > 0) return 'inbox-unread';
  if (facts.inboxPending > 0) return 'inbox-unacked';
  if (facts.openTodos > 0) return 'open-todos';
  return 'done';
}

/** A dialog waiting on an answer; `idle` items are Claude's own idle notice, not a block. */
function pendingDialogAt(sessionId: string): number | null {
  const item = approvalInbox.getForSession(sessionId);
  return item && item.kind !== 'idle' ? item.createdAt : null;
}

/** Same shape as inbox-routes' helper: abort only when the socket dies before the answer. */
function abortOnClientHangUp(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}

export function registerAgentWatchRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/agent-watch', async (req, reply) => {
    const query = parseBody(AgentWatchQuerySchema, req.query ?? {});
    const ids = [
      ...new Set(
        query.sessions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
    if (ids.length === 0) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'sessions: no ids given');
    if (ids.length > MAX_WATCH_SESSIONS) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `sessions: at most ${MAX_WATCH_SESSIONS} ids`);
    }
    const user = isMultiUserMode() ? getAuthUser(req) : null;

    const scan = (since: number | undefined) => {
      const cursor = Date.now();
      const ended: WatchRow[] = [];
      const gone: string[] = [];
      for (const id of ids) {
        const session = ctx.sessions.get(id);
        if (!session || (user && user.role !== 'admin' && !canAccessOwned(user, session.owner))) {
          gone.push(id);
          continue;
        }
        const dialogAt = pendingDialogAt(id);
        const stamps = [session.turnEndedAt, dialogAt].filter(
          (t): t is number => t !== null && (since === undefined || t >= since)
        );
        if (stamps.length === 0) continue;
        const todos = session.ralphTracker.getTodoStats();
        const openTodos = todos.pending + todos.inProgress;
        const inboxPending = agentInbox.pendingCount(id);
        const inboxUnseen = agentInbox.unseen(id).length;
        ended.push({
          id,
          name: session.name,
          mode: session.mode,
          status: session.status,
          turnEndedAt: Math.max(...stamps),
          turnEndSource: session.turnEndSource,
          reason: classifyWatchReason(session, {
            blocked: dialogAt !== null,
            inboxWaiting: agentInbox.waiterCount(id) > 0,
            inboxUnseen,
            inboxPending,
            openTodos,
          }),
          openTodos,
          totalTodos: todos.total,
          inboxPending,
          inboxUnseen,
        });
      }
      return { cursor, ended, gone };
    };

    let result = scan(query.since);
    if (result.ended.length > 0 || result.gone.length > 0 || query.wait === undefined) {
      return { success: true, data: { ...result, timedOut: false } };
    }
    if (turnWatch.size >= MAX_TURN_WATCHERS) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, `Too many parked watches (max ${MAX_TURN_WATCHERS})`);
    }
    // Nothing qualified at the first scan, so from here on anything stamped at or
    // after that scan is new, whether or not the caller passed `since`.
    const since = query.since ?? result.cursor;
    const deadline = Date.now() + clampWait(query.wait);
    const abort = abortOnClientHangUp(reply);
    for (;;) {
      const outcome = await turnWatch.wait(ids, Math.max(0, deadline - Date.now()), abort.signal);
      if (outcome === 'aborted') return { success: true, data: { ...result, timedOut: true } };
      result = scan(since);
      if (result.ended.length > 0 || result.gone.length > 0) {
        return { success: true, data: { ...result, timedOut: false } };
      }
      if (outcome !== 'woken' || Date.now() >= deadline) {
        return { success: true, data: { ...result, timedOut: true } };
      }
    }
  });
}
