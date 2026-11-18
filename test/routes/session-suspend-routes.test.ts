/**
 * @fileoverview Route tests for session suspend (session-suspend.ts):
 * `POST /api/sessions/:id/suspend|resume`, and input to a suspended session on
 * `POST /api/sessions/:id/input` (also what `codeman agent send` uses).
 *
 * The behavior pinned here cannot be seen at the registry level: input to a
 * suspended session must NOT be written into its dead pane (the bytes would
 * vanish); it is answered `buffered` + `resuming` and delivered after the resume,
 * and send-and-wait awaits the resume and then writes as usual.
 *
 * Port: none (Fastify inject)
 */
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { SessionSuspendRegistry, suspendRegistryOf } from '../../src/session-suspend.js';

const SESSION_ID = 'suspend-session';

function installEnvelope(app: FastifyInstance): void {
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
}

afterEach(() => {
  sessionWaits.cancelAll(SESSION_ID);
  _resetPaneLivenessState();
});

async function harness(opts: { stopOk?: boolean } = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const session = ctx.sessions.get(SESSION_ID)! as unknown as {
    mode: string;
    suspended: boolean;
    suspendedAt?: number;
    writeBuffer: string[];
    restartCli: { mock: { calls: unknown[] } };
  };
  session.mode = 'claude';
  const stops: string[] = [];
  const registry = new SessionSuspendRegistry({
    stopPane: async (id) => {
      stops.push(id);
      return opts.stopOk ?? true;
    },
    capturePane: () => '❯ \n',
    persist: () => {},
    now: () => 42,
    sleep: async () => {},
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 50,
  });
  registerSessionRoutes(app, ctx as never, { suspend: registry });
  installEnvelope(app);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, session, registry, stops };
}

describe('POST /api/sessions/:id/suspend', () => {
  it('stops the pane and marks the session suspended', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/suspend` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { suspended: true, suspendedAt: 42 } });
    expect(h.stops).toEqual([SESSION_ID]);
    expect(h.session.suspended).toBe(true);
    expect(suspendRegistryOf(h.ctx)).toBe(h.registry);
  });

  it('refuses an unsupported session with 409 and a reason', async () => {
    const h = await harness();
    h.session.mode = 'opencode';
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/suspend` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, reason: 'unsupported-mode' });
    expect(h.stops).toEqual([]);
  });

  it('answers 500 when the process could not be stopped', async () => {
    const h = await harness({ stopOk: false });
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/suspend` });
    expect(res.statusCode).toBe(500);
    expect(h.session.suspended).toBe(false);
  });
});

describe('POST /api/sessions/:id/resume', () => {
  it('relaunches a suspended session', async () => {
    const h = await harness();
    await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/suspend` });
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/resume` });
    expect(res.json()).toEqual({ success: true, data: { suspended: false } });
    expect(h.session.restartCli.mock.calls.length).toBe(1);
    expect(h.session.suspended).toBe(false);
  });

  it('is a no-op for a running session', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/resume` });
    expect(res.json()).toEqual({ success: true, data: { suspended: false, alreadyRunning: true } });
    expect(h.session.restartCli.mock.calls.length).toBe(0);
  });
});

describe('POST /api/sessions/:id/input to a suspended session', () => {
  it('holds the input, resumes, and delivers it after the composer', async () => {
    const h = await harness();
    await h.app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/suspend` });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/input`,
      payload: { input: 'hello\r', useMux: true },
    });
    expect(res.json()).toEqual({ success: true, data: { buffered: true, resuming: true } });
    // Nothing went into the dead pane synchronously; the resume delivers it.
    await h.registry.resume(h.session as never);
    expect(h.session.restartCli.mock.calls.length).toBe(1);
    expect(h.session.writeBuffer).toEqual(['hello\r']);
    expect(h.session.suspended).toBe(false);
  });

  it('a running session keeps the normal path', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/input`,
      payload: { input: 'x', useMux: true },
    });
    expect(res.json().data?.resuming).toBeUndefined();
    expect(h.session.restartCli.mock.calls.length).toBe(0);
  });
});
