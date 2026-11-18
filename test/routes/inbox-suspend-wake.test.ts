/**
 * @fileoverview A mailbox post brings a suspended receiver back (inbox-routes.ts +
 * session-suspend.ts): the post request resumes it, and only once the resume has
 * landed is the nudge scheduled that tells it to read. `nudge:false` leaves it parked.
 * Plus the guard that the nudger itself never reaches the suspend registry (its timers
 * and boot rearm() must not resume, a remote resume wakes the host).
 *
 * Port: none (app.inject)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerInboxRoutes } from '../../src/web/routes/inbox-routes.js';
import { agentInbox } from '../../src/web/agent-inbox.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { SessionSuspendRegistry, attachSuspendRegistry } from '../../src/session-suspend.js';
import { createMockRouteContext } from '../mocks/index.js';

const RX = 'aaaaaaaa-1111-4111-8111-111111111111';

describe('inbox post to a suspended session', () => {
  let app: FastifyInstance;
  let holding: boolean;
  let resumeResult: boolean;
  let resolveResume: (ok: boolean) => void;
  const resume = vi.fn();
  const schedule = vi.fn();

  beforeEach(async () => {
    agentInbox.resetForTests();
    holding = true;
    resumeResult = true;
    resume.mockReset().mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveResume = r;
        })
    );
    schedule.mockReset();
    app = Fastify({ logger: false });
    const ctx = createMockRouteContext({ sessionId: RX });
    const registry = Object.assign(Object.create(SessionSuspendRegistry.prototype), {
      isHolding: () => holding,
      resume,
    });
    attachSuspendRegistry(ctx, registry);
    registerInboxRoutes(app, ctx as never, { nudger: { schedule } });
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    sessionWaits.cancelAll(RX);
    await app.close();
    agentInbox.resetForTests();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/sessions/${RX}/inbox`, payload });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('resumes it and nudges only after the resume landed', async () => {
    const res = await post({ text: 'new order' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.resuming).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    resolveResume(resumeResult);
    await flush();
    expect(schedule).toHaveBeenCalledWith(RX, 'user', expect.objectContaining({ messageId: expect.any(String) }));
  });

  it('a failed resume leaves the mail waiting, without a nudge into a dead pane', async () => {
    await post({ text: 'new order' });
    resolveResume(false);
    await flush();
    expect(schedule).not.toHaveBeenCalled();
    expect(agentInbox.unseen(RX)).toHaveLength(1);
  });

  it('nudge:false (--no-nudge) leaves it suspended', async () => {
    const res = await post({ text: 'fyi', nudge: false });
    expect(JSON.parse(res.body).data.resuming).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
  });

  it('a running receiver is nudged as before, nothing resumed', async () => {
    holding = false;
    const res = await post({ text: 'hello' });
    expect(JSON.parse(res.body).data.resuming).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('wiring guard', () => {
  it('the inbox nudger has no access to the suspend registry', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/web/inbox-nudger.ts'), 'utf8');
    expect(src).not.toMatch(/session-suspend\.js|suspendRegistryOf|\.resume\(/);
  });
});
