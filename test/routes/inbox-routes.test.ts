/**
 * Agent inbox routes (src/web/routes/inbox-routes.ts) via app.inject(), no live port.
 * Harness mirrors approval-routes.test.ts (envelope hook so guards carry their 4xx).
 * The routes read the process-wide `agentInbox` singleton, so every test resets it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerInboxRoutes } from '../../src/web/routes/inbox-routes.js';
import { agentInbox, MAX_INBOX_WAITERS_PER_SESSION, MAX_MESSAGES_PER_INBOX } from '../../src/web/agent-inbox.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { createMockRouteContext } from '../mocks/index.js';

const SESSION_ID = 'inbox-test-session';

async function createHarness(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  registerInboxRoutes(app, ctx as never);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

describe('agent inbox routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    agentInbox.resetForTests();
    app = await createHarness();
  });

  afterEach(async () => {
    await app.close();
    agentInbox.resetForTests();
  });

  it('POST stores, GET reads non-destructively, ack removes, DELETE clears', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/inbox`,
      payload: { text: 'review\nthe diff', from: 'sender-1' },
    });
    expect(post.statusCode).toBe(200);
    const { message, pending } = post.json().data;
    expect(message).toMatchObject({ from: 'sender-1', text: 'review\nthe diff' });
    expect(pending).toBe(1);

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox` });
    expect(read.json().data).toMatchObject({ pending: 1, timedOut: false, waitedMs: 0 });
    expect(read.json().data.messages).toHaveLength(1);
    const again = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox` });
    expect(again.json().data.messages).toHaveLength(1); // a read never drains

    const ack = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/inbox/ack`,
      payload: { ids: [message.id] },
    });
    expect(ack.json().data).toEqual({ removed: 1, pending: 0 });

    await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: 'a' } });
    await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: 'b' } });
    const clear = await app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/inbox` });
    expect(clear.json().data).toEqual({ removed: 2, pending: 0 });
  });

  it('the sender label falls back to X-Codeman-Parent-Session, then "api"', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/inbox`,
      headers: { 'x-codeman-parent-session': 'caller-session' },
      payload: { text: 'hi' },
    });
    await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: 'hi' } });
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox` });
    expect(read.json().data.messages.map((m: { from: string }) => m.from)).toEqual(['caller-session', 'api']);
  });

  it('an unknown session is a 404 on every verb', async () => {
    for (const [method, url, payload] of [
      ['POST', '/api/sessions/nope/inbox', { text: 'x' }],
      ['GET', '/api/sessions/nope/inbox', undefined],
      ['POST', '/api/sessions/nope/inbox/ack', { ids: ['x'] }],
      ['DELETE', '/api/sessions/nope/inbox', undefined],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('validates the body and query: empty text, unknown fields, non-positive wait are 400', async () => {
    const empty = await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: '' } });
    expect(empty.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/inbox`,
      payload: { text: 'x', notify: true },
    });
    expect(extra.statusCode).toBe(400);
    const wait0 = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=0` });
    expect(wait0.statusCode).toBe(400);
    const waitStr = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=30s` });
    expect(waitStr.statusCode).toBe(400);
  });

  it('a full inbox is a 422 the sender can read, and nothing is evicted', async () => {
    for (let i = 0; i < MAX_MESSAGES_PER_INBOX; i++) agentInbox.post(SESSION_ID, 'x', `m${i}`);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/inbox`,
      payload: { text: 'more' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(agentInbox.list(SESSION_ID)[0].text).toBe('m0');
  });

  it('?wait long-polls and a post releases it with the message', async () => {
    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=5000` });
    await new Promise((r) => setTimeout(r, 20));
    expect(agentInbox.waiterCount(SESSION_ID)).toBe(1);
    await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: 'now' } });
    const res = await pending;
    expect(res.json().data.messages.map((m: { text: string }) => m.text)).toEqual(['now']);
    expect(res.json().data.timedOut).toBe(false);
  });

  it('GET /api/agent-inbox/summary reports pending + wait state for sessions that exist', async () => {
    await app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/inbox`, payload: { text: 'unread' } });
    // A wait parked on the inbox shows up with its start time...
    const parked = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=5000` });
    await new Promise((r) => setTimeout(r, 20));
    // ...but the inbox has mail, so the wait resolves at once: the summary sees pending only.
    await parked;
    const withMail = (await app.inject({ method: 'GET', url: '/api/agent-inbox/summary' })).json().data;
    expect(withMail[SESSION_ID]).toEqual({ pending: 1, waiting: false, waitingSince: null });

    await app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}/inbox` });
    const waiting = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=5000` });
    await new Promise((r) => setTimeout(r, 20));
    const summary = (await app.inject({ method: 'GET', url: '/api/agent-inbox/summary' })).json().data;
    expect(summary[SESSION_ID].pending).toBe(0);
    expect(summary[SESSION_ID].waiting).toBe(true);
    expect(typeof summary[SESSION_ID].waitingSince).toBe('string');
    expect(Number.isNaN(Date.parse(summary[SESSION_ID].waitingSince))).toBe(false);
    agentInbox.drop(SESSION_ID);
    await waiting;

    // Mail for a session the server does not know (gone, or another user's) is not listed.
    agentInbox.post('ghost-session', 'api', 'orphan');
    const after = (await app.inject({ method: 'GET', url: '/api/agent-inbox/summary' })).json().data;
    expect(after['ghost-session']).toBeUndefined();
  });

  it('the per-session waiter cap answers SESSION_BUSY instead of queueing', async () => {
    const waits = Array.from({ length: MAX_INBOX_WAITERS_PER_SESSION }, () =>
      app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=5000` })
    );
    await new Promise((r) => setTimeout(r, 20));
    const extra = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/inbox?wait=5000` });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().errorCode).toBe('SESSION_BUSY');
    agentInbox.drop(SESSION_ID);
    await Promise.all(waits);
  });
});
