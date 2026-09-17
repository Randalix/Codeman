/**
 * @fileoverview Agent inbox routes: the mailbox channel between sessions.
 *
 * - `POST   /api/sessions/:id/inbox`      store a message for the session (never types)
 * - `GET    /api/sessions/:id/inbox`      read, non-destructive; `?wait=<ms>` long-polls
 *                                         while the inbox is empty
 * - `POST   /api/sessions/:id/inbox/ack`  remove messages the reader has processed
 * - `DELETE /api/sessions/:id/inbox`      discard everything pending
 *
 * Store and invariants: `web/agent-inbox.ts`. Ownership is the session-route rule
 * (`findSessionOrFail`: a session the caller cannot see is a 404, never a 403). The
 * poster's identity is whatever it says in `from`, falling back to the
 * `X-Codeman-Parent-Session` header every skill/CLI call carries — it is a label for
 * the reader, not an authorization claim.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { InboxAckSchema, InboxPostSchema, InboxReadQuerySchema } from '../schemas.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { agentInbox, MAX_INBOX_WAITERS_PER_SESSION, MAX_MESSAGES_PER_INBOX, MAX_TEXT_LENGTH } from '../agent-inbox.js';
import type { SessionPort } from '../ports/index.js';

/** The sender label: an explicit `from`, else the caller's session header, else "api". */
export function senderLabel(req: FastifyRequest, from: string | undefined): string {
  if (from) return from;
  const header = req.headers['x-codeman-parent-session'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : 'api';
}

/**
 * Same shape as session-routes' `abortOnClientHangUp`: `reply.raw` emits `close` both
 * when the response completes and when the socket dies; `writableFinished` tells
 * them apart. Only observable over real HTTP (`app.inject()` never emits `close`).
 */
function abortOnClientHangUp(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}

export function registerInboxRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.post('/api/sessions/:id/inbox', async (req) => {
    const { id } = req.params as { id: string };
    findSessionOrFail(ctx, id, req);
    const body = parseBody(InboxPostSchema, req.body);
    const result = agentInbox.post(id, senderLabel(req, body.from), body.text);
    if (!result.ok) {
      switch (result.reason) {
        case 'full':
          return createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            `Inbox of ${id} is full (${MAX_MESSAGES_PER_INBOX} messages); the receiver has to ack or clear first`
          );
        case 'text-too-long':
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, `text exceeds ${MAX_TEXT_LENGTH} characters`);
        case 'stopped':
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Server is shutting down');
        default:
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Invalid message: ${result.reason}`);
      }
    }
    return { message: result.message, pending: result.pending };
  });

  app.get('/api/sessions/:id/inbox', async (req, reply) => {
    const { id } = req.params as { id: string };
    findSessionOrFail(ctx, id, req);
    const query = parseBody(InboxReadQuerySchema, req.query ?? {});
    if (query.wait !== undefined && agentInbox.waiterCount(id) >= MAX_INBOX_WAITERS_PER_SESSION) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Too many inbox waiters on ${id} (max ${MAX_INBOX_WAITERS_PER_SESSION})`
      );
    }
    // A client that hangs up mid-poll hands its waiter slot back at once (the cap
    // above is small on purpose); nobody is reading the answer anyway.
    const abort = query.wait === undefined ? undefined : abortOnClientHangUp(reply);
    return agentInbox.read(id, query.wait, abort?.signal);
  });

  app.post('/api/sessions/:id/inbox/ack', async (req) => {
    const { id } = req.params as { id: string };
    findSessionOrFail(ctx, id, req);
    const body = parseBody(InboxAckSchema, req.body);
    const removed = agentInbox.ack(id, body.ids);
    return { removed, pending: agentInbox.pendingCount(id) };
  });

  app.delete('/api/sessions/:id/inbox', async (req) => {
    const { id } = req.params as { id: string };
    findSessionOrFail(ctx, id, req);
    return { removed: agentInbox.clear(id), pending: 0 };
  });
}
