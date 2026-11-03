/**
 * @fileoverview Downstream (Randalix fork) layer on upstream's agent inbox: the store's
 * quiet status lines, ack-all and clear, the legacy snapshot, and the routes' nudger
 * hand-off, `?peek=1`, ack without ids, `DELETE`, the quiet-aware wait and the
 * summary's `parkedSince`. Upstream's own rules stay pinned in agent-inbox.test.ts and
 * routes/inbox-routes.test.ts; this file only covers what the fork adds on top.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerInboxRoutes } from '../src/web/routes/inbox-routes.js';
import { AgentInbox, agentInbox, MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_INBOX } from '../src/web/agent-inbox.js';
import { sessionWaits } from '../src/web/session-wait-registry.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../src/types.js';
import { createMockRouteContext, createMockSession } from './mocks/index.js';

const RX = 'aaaaaaaa-1111-4111-8111-111111111111';
const TX = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('AgentInbox — downstream layer', () => {
  let now: number;
  let inbox: AgentInbox;
  beforeEach(() => {
    now = 1_000_000;
    inbox = new AgentInbox(() => now);
  });

  it('replaceQuiet keeps one current status line per sender, never touching seen, loud or other senders', () => {
    inbox.post(RX, TX, 'IDLE 1', { quiet: true, replaceQuiet: true });
    inbox.post(RX, TX, 'loud');
    inbox.post(RX, 'other', 'IDLE other', { quiet: true, replaceQuiet: true });
    inbox.post(RX, TX, 'IDLE 2', { quiet: true, replaceQuiet: true });
    expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.text)).toEqual(['loud', 'IDLE other', 'IDLE 2']);
    inbox.read(RX, { receiver: true }); // all seen now
    inbox.post(RX, TX, 'IDLE 3', { quiet: true, replaceQuiet: true });
    expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.text)).toEqual([
      'loud',
      'IDLE other',
      'IDLE 2',
      'IDLE 3',
    ]);
    expect(inbox.withdrawQuiet(RX, TX)).toBe(1); // only the unseen one
  });

  it('replaceQuiet frees room in a full inbox for the replacing line', () => {
    inbox.post(RX, TX, 'IDLE 1', { quiet: true, replaceQuiet: true });
    for (let i = 1; i < MAX_MESSAGES_PER_INBOX; i++) inbox.post(RX, 'other', `m${i}`);
    expect(inbox.post(RX, 'other', 'one too many').ok).toBe(false);
    const replaced = inbox.post(RX, TX, 'IDLE 2', { quiet: true, replaceQuiet: true });
    expect(replaced).toMatchObject({ ok: true, pending: MAX_MESSAGES_PER_INBOX });
  });

  it('a post refused after replaceQuiet withdrew the old line still fires onChange (snapshot stays true)', () => {
    inbox.post(RX, TX, 'IDLE', { quiet: true });
    const big = 'x'.repeat(MAX_MESSAGE_BYTES);
    for (let i = 0; i < 31; i++) inbox.post(RX, 'other', big);
    inbox.post(RX, 'other', 'x'.repeat(MAX_MESSAGE_BYTES - 4)); // exactly MAX_INBOX_BYTES now
    const onChange = vi.fn();
    inbox.onChange = onChange;
    expect(inbox.post(RX, TX, big, { quiet: true, replaceQuiet: true })).toEqual({
      ok: false,
      reason: 'inbox-full-bytes',
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(inbox.read(RX, { receiver: false }).messages.some((m) => m.text === 'IDLE')).toBe(false);
  });

  it('loudUnseenCount ignores quiet lines; unseen() lists both', () => {
    inbox.post(RX, TX, 'IDLE', { quiet: true });
    expect(inbox.loudUnseenCount(RX)).toBe(0);
    inbox.post(RX, TX, 'result');
    expect(inbox.loudUnseenCount(RX)).toBe(1);
    expect(inbox.unseen(RX).map((m) => [m.text, m.quiet ?? false])).toEqual([
      ['IDLE', true],
      ['result', false],
    ]);
  });

  it('ackSeen removes exactly what a receiver read handed out; a later post stays', () => {
    inbox.post(RX, TX, 'a');
    inbox.read(RX, { receiver: false }); // a peek marks nothing
    expect(inbox.ackSeen(RX)).toBe(0);
    inbox.read(RX, { receiver: true });
    inbox.post(RX, TX, 'b');
    expect(inbox.ackSeen(RX)).toBe(1);
    expect(inbox.read(RX, { receiver: false }).messages.map((m) => m.text)).toEqual(['b']);
  });

  it('clear empties the inbox and fires onChange once; an empty clear is silent', () => {
    const onChange = vi.fn();
    inbox.post(RX, TX, 'a');
    inbox.post(RX, TX, 'b');
    inbox.onChange = onChange;
    expect(inbox.clear(RX)).toBe(2);
    expect(inbox.clear(RX)).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(inbox.pendingCount(RX)).toBe(0);
  });

  it('quiet survives a snapshot round trip; a legacy downstream snapshot (no seenAt) restores as unseen', () => {
    inbox.post(RX, TX, 'IDLE', { quiet: true });
    const again = new AgentInbox(() => now);
    expect(again.restore(inbox.snapshot())).toBe(1);
    expect(again.read(RX, { receiver: false }).messages[0]).toMatchObject({ quiet: true, seen: false });

    const legacy = { version: 1, inboxes: { [RX]: [{ id: 'm1', from: TX, text: 'old', createdAt: now - 1000 }] } };
    const fresh = new AgentInbox(() => now);
    expect(fresh.restore(legacy)).toBe(1);
    expect(fresh.read(RX, { receiver: false }).messages[0]).toMatchObject({ id: 'm1', text: 'old', seen: false });
  });
});

describe('inbox routes — downstream layer', () => {
  let app: FastifyInstance;
  const schedule = vi.fn();
  const as = (caller?: string) => (caller ? { 'x-codeman-parent-session': caller } : {});
  const data = (res: { body: string }) => JSON.parse(res.body).data;

  beforeEach(async () => {
    agentInbox.resetForTests();
    schedule.mockReset();
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const ctx = createMockRouteContext({ sessionId: RX });
    ctx.sessions.set(TX, createMockSession(TX) as never);
    app.decorateRequest('authUser', undefined);
    registerInboxRoutes(app, ctx as never, { nudger: { schedule } });
    app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
      const p = payload as { success?: unknown; errorCode?: unknown } | null;
      if (p && p.success === false && reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      done(null, payload);
    });
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    for (const id of [RX, TX]) sessionWaits.cancelAll(id);
    await app.close();
    agentInbox.resetForTests();
  });

  const post = (payload: Record<string, unknown>, caller?: string) =>
    app.inject({ method: 'POST', url: `/api/sessions/${RX}/inbox`, payload, headers: as(caller) });

  it('accepts the legacy body field `from` of a pre-1.47 CLI but takes the sender from the header only', async () => {
    const res = await post({ text: 'old cli', from: 'spoofed-sender' }, TX);
    expect(res.statusCode).toBe(200);
    const mail = agentInbox.read(RX, { receiver: false }).messages;
    expect(mail.map((m) => [m.text, m.from])).toEqual([['old cli', TX]]);
    expect((await post({ text: 'x', fromm: TX }, TX)).statusCode).toBe(400); // still strict otherwise
  });

  it('a stored post hands the nudger receiver, sender (or "user") and the opt-out; a refused one does not', async () => {
    await post({ text: 'hi' }, TX);
    await post({ text: 'quiet please', nudge: false });
    await post({ text: '' }, TX);
    expect(schedule.mock.calls.map(([to, from, o]) => [to, from, o.nudge, o.receiverWaiting])).toEqual([
      [RX, TX, undefined, false],
      [RX, 'user', false, false],
    ]);
  });

  it('tells the nudger when the receiver was parked at post time', async () => {
    const parked = app.inject({ method: 'GET', url: `/api/sessions/${RX}/inbox?wait=5000`, headers: as(RX) });
    await vi.waitFor(() => expect(sessionWaits.inboxWaiterCount(RX, true)).toBe(1));
    await post({ text: 'wake' }, TX);
    expect(schedule.mock.calls[0][2]).toMatchObject({ receiverWaiting: true });
    expect(data(await parked).messages.map((m: { text: string }) => m.text)).toEqual(['wake']);
  });

  it('?peek=1 keeps even the receiver’s own read from marking anything seen', async () => {
    await post({ text: 'a' }, TX);
    const peek = data(await app.inject({ method: 'GET', url: `/api/sessions/${RX}/inbox?peek=1`, headers: as(RX) }));
    expect(peek).toMatchObject({ receiver: false, unseen: 1 });
    const own = data(await app.inject({ method: 'GET', url: `/api/sessions/${RX}/inbox`, headers: as(RX) }));
    expect(own).toMatchObject({ receiver: true, unseen: 0 });
  });

  it('ack without ids removes what the receiver read; an empty id list is still a 400', async () => {
    await post({ text: 'a' }, TX);
    await app.inject({ method: 'GET', url: `/api/sessions/${RX}/inbox`, headers: as(RX) });
    await post({ text: 'b' }, TX);
    const ack = await app.inject({
      method: 'POST',
      url: `/api/sessions/${RX}/inbox/ack`,
      payload: {},
      headers: as(RX),
    });
    expect(data(ack)).toMatchObject({ removed: 1, pending: 1 });
    const empty = await app.inject({
      method: 'POST',
      url: `/api/sessions/${RX}/inbox/ack`,
      payload: { ids: [] },
      headers: as(RX),
    });
    expect(empty.statusCode).toBe(400);
  });

  it('DELETE empties the inbox for the receiver only', async () => {
    await post({ text: 'a' }, TX);
    await post({ text: 'b' }, TX);
    const foreign = await app.inject({ method: 'DELETE', url: `/api/sessions/${RX}/inbox`, headers: as(TX) });
    expect(foreign.statusCode).toBe(403);
    expect(agentInbox.pendingCount(RX)).toBe(2);
    const own = await app.inject({ method: 'DELETE', url: `/api/sessions/${RX}/inbox`, headers: as(RX) });
    expect(data(own)).toMatchObject({ removed: 2, pending: 0 });
    expect(agentInbox.pendingCount(RX)).toBe(0);
  });

  it('a wait that finds only quiet status lines parks instead of answering at once', async () => {
    agentInbox.post(RX, TX, 'IDLE', { quiet: true });
    const parked = app.inject({ method: 'GET', url: `/api/sessions/${RX}/inbox?wait=5000`, headers: as(RX) });
    await vi.waitFor(() => expect(sessionWaits.inboxWaiterCount(RX, true)).toBe(1));
    await post({ text: 'result' }, TX);
    expect(data(await parked).messages.map((m: { text: string }) => m.text)).toEqual(['IDLE', 'result']);
  });

  it('the summary carries parkedSince while the receiver is parked, null otherwise', async () => {
    await post({ text: 'a' }, TX);
    const before = Date.now();
    const parked = app.inject({ method: 'GET', url: `/api/sessions/${TX}/inbox?wait=5000`, headers: as(TX) });
    await vi.waitFor(() => expect(sessionWaits.inboxWaiterCount(TX, true)).toBe(1));
    const sessions = data(await app.inject({ method: 'GET', url: '/api/agent-inbox/summary' })).sessions;
    expect(sessions[RX]).toMatchObject({ pending: 1, parked: false, parkedSince: null });
    expect(sessions[TX].parked).toBe(true);
    expect(sessions[TX].parkedSince).toBeGreaterThanOrEqual(before);
    sessionWaits.cancelAll(TX);
    await parked;
  });
});
