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
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { AgentWatchQuerySchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { clampWait } from '../agent-inbox.js';
import { turnWatch, MAX_TURN_WATCHERS, MAX_WATCH_SESSIONS } from '../agent-watch.js';
import type { SessionPort } from '../ports/index.js';

export interface WatchRow {
  id: string;
  name: string;
  mode: string;
  status: string;
  turnEndedAt: number;
  turnEndSource: string | null;
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
        const at = session.turnEndedAt;
        if (at === null || (since !== undefined && at < since)) continue;
        ended.push({
          id,
          name: session.name,
          mode: session.mode,
          status: session.status,
          turnEndedAt: at,
          turnEndSource: session.turnEndSource,
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
