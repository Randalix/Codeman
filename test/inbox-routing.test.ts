/**
 * @fileoverview Downstream (Randalix fork): `routing.json` and the inbox route's
 * `routing: { lead }` hint. A post to the coordinator from a session with a lead is
 * still delivered; only the answer names the lead, and `direct: true` skips it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerInboxRoutes } from '../src/web/routes/inbox-routes.js';
import { agentInbox } from '../src/web/agent-inbox.js';
import { sessionWaits } from '../src/web/session-wait-registry.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import {
  loadInboxRouting,
  parseInboxRouting,
  routingLeadFor,
  sameSession,
  type InboxRouting,
} from '../src/web/inbox-routing.js';
import { createMockRouteContext, createMockSession } from './mocks/index.js';

const COORD = 'cccccccc-1111-4111-8111-111111111111';
const WORKER = 'wwwwwwww-2222-4222-8222-222222222222';
const LEAD = 'llllllll-3333-4333-8333-333333333333';
const OTHER = 'oooooooo-4444-4444-8444-444444444444';

const routing: InboxRouting = { coordinator: COORD.slice(0, 8), leadOf: { [WORKER.slice(0, 8)]: LEAD.slice(0, 8) } };

describe('inbox routing — rules', () => {
  it('sameSession: exact, or a prefix of at least 8 chars either way', () => {
    expect(sameSession(COORD, COORD)).toBe(true);
    expect(sameSession(COORD.slice(0, 8), COORD)).toBe(true);
    expect(sameSession(COORD, COORD.slice(0, 8))).toBe(true);
    expect(sameSession(COORD.slice(0, 7), COORD)).toBe(false);
    expect(sameSession(COORD, WORKER)).toBe(false);
  });

  it('parse: koordinator (or coordinator) plus lead_of; anything else is no routing', () => {
    expect(parseInboxRouting({ koordinator: 'c', lead_of: { a: 'b', bad: 3 } })).toEqual({
      coordinator: 'c',
      leadOf: { a: 'b' },
    });
    expect(parseInboxRouting({ coordinator: 'c', lead_of: {} })).toEqual({ coordinator: 'c', leadOf: {} });
    expect(parseInboxRouting({ lead_of: {} })).toBeNull();
    expect(parseInboxRouting({ koordinator: 'c', lead_of: [] })).toBeNull();
    expect(parseInboxRouting(null)).toBeNull();
  });

  it('lead only for a post from a session with a lead TO the coordinator', () => {
    expect(routingLeadFor(routing, WORKER, COORD)).toBe(LEAD.slice(0, 8));
    expect(routingLeadFor(routing, WORKER, OTHER)).toBeNull(); // not to the coordinator
    expect(routingLeadFor(routing, OTHER, COORD)).toBeNull(); // sender has no lead
    expect(routingLeadFor(routing, null, COORD)).toBeNull(); // the user posting
    expect(routingLeadFor(null, WORKER, COORD)).toBeNull(); // no file
  });

  it('no hint when the lead is the coordinator itself or the sender', () => {
    expect(routingLeadFor({ coordinator: COORD, leadOf: { [WORKER]: COORD.slice(0, 8) } }, WORKER, COORD)).toBeNull();
    expect(routingLeadFor({ coordinator: COORD, leadOf: { [LEAD]: LEAD } }, LEAD, COORD)).toBeNull();
  });

  it('load: missing or broken file is null, a valid one parses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-routing-'));
    try {
      const file = join(dir, 'routing.json');
      expect(loadInboxRouting(file)).toBeNull();
      writeFileSync(file, '{ not json');
      expect(loadInboxRouting(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ koordinator: 'c', lead_of: { w: 'l' } }));
      expect(loadInboxRouting(file)).toEqual({ coordinator: 'c', leadOf: { w: 'l' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('inbox routing — POST /api/sessions/:id/inbox', () => {
  let app: FastifyInstance;
  let current: InboxRouting | null;
  const as = (caller?: string) => (caller ? { 'x-codeman-parent-session': caller } : {});
  const post = (to: string, payload: Record<string, unknown>, caller?: string) =>
    app.inject({ method: 'POST', url: `/api/sessions/${to}/inbox`, payload, headers: as(caller) });

  beforeEach(async () => {
    agentInbox.resetForTests();
    current = routing;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const ctx = createMockRouteContext({ sessionId: COORD });
    for (const id of [WORKER, LEAD, OTHER]) ctx.sessions.set(id, createMockSession(id) as never);
    app.decorateRequest('authUser', undefined);
    registerInboxRoutes(app, ctx as never, { routing: () => current });
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    for (const id of [COORD, WORKER, LEAD, OTHER]) sessionWaits.cancelAll(id);
    await app.close();
    agentInbox.resetForTests();
  });

  it('delivers to the coordinator and names the lead', async () => {
    const res = JSON.parse((await post(COORD, { text: 'status' }, WORKER)).body);
    expect(res.success).toBe(true);
    expect(res.data.routing).toEqual({ lead: LEAD.slice(0, 8) });
    expect(agentInbox.read(COORD, { receiver: false }).messages.map((m) => m.text)).toEqual(['status']);
  });

  it('direct: true delivers without a hint', async () => {
    const res = JSON.parse((await post(COORD, { text: 'on purpose', direct: true }, WORKER)).body);
    expect(res.success).toBe(true);
    expect(res.data).not.toHaveProperty('routing');
  });

  it('no hint for other receivers, senders without a lead, the user, or without a file', async () => {
    expect(JSON.parse((await post(LEAD, { text: 'x' }, WORKER)).body).data).not.toHaveProperty('routing');
    expect(JSON.parse((await post(COORD, { text: 'x' }, OTHER)).body).data).not.toHaveProperty('routing');
    expect(JSON.parse((await post(COORD, { text: 'x' })).body).data).not.toHaveProperty('routing');
    current = null;
    expect(JSON.parse((await post(COORD, { text: 'x' }, WORKER)).body).data).not.toHaveProperty('routing');
  });
});
