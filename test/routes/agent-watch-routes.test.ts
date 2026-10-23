/**
 * @fileoverview `GET /api/agent-watch` via app.inject(): level-triggered with a cursor,
 * so a turn that ended before the call is still reported and none is lost between calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerAgentWatchRoutes } from '../../src/web/routes/agent-watch-routes.js';
import { turnWatch } from '../../src/web/agent-watch.js';
import { agentInbox } from '../../src/web/agent-inbox.js';
import { approvalInbox } from '../../src/web/approval-inbox.js';
import { classifyWatchReason } from '../../src/web/routes/agent-watch-routes.js';
import { createMockSession, type MockSession } from '../mocks/index.js';
import { CoordinatorReports } from '../../src/web/coordinator-reports.js';
import { vi } from 'vitest';

/** The slice of the real tracker the route reads. */
function withTodos(session: MockSession, open = 0, total = open): void {
  (session as unknown as { ralphTracker: unknown }).ralphTracker = {
    getTodoStats: () => ({ total, pending: open, inProgress: 0, completed: total - open }),
  };
}

describe('GET /api/agent-watch', () => {
  let harness: RouteTestHarness;
  const url = (query: string) => `/api/agent-watch?${query}`;

  beforeEach(async () => {
    turnWatch.resetForTests();
    agentInbox.resetForTests();
    harness = await createRouteTestHarness(registerAgentWatchRoutes);
    const second = createMockSession('worker-2');
    harness.ctx.sessions.set('worker-2', second);
    withTodos(harness.ctx._session);
    withTodos(second);
  });

  afterEach(async () => {
    turnWatch.resetForTests();
    agentInbox.resetForTests();
    vi.restoreAllMocks();
    await harness.app.close();
  });

  const body = async (query: string) => JSON.parse((await harness.app.inject({ method: 'GET', url: url(query) })).body);

  it('reports a turn that ended BEFORE the call (the latch, not the edge)', async () => {
    harness.ctx._session.markTurnEnded('hook');
    const res = await body(`sessions=${harness.ctx._sessionId},worker-2`);
    expect(res.success).toBe(true);
    expect(res.data.ended).toEqual([
      expect.objectContaining({ id: harness.ctx._sessionId, turnEndSource: 'hook', turnEndedAt: expect.any(Number) }),
    ]);
    expect(res.data.gone).toEqual([]);
    expect(res.data.timedOut).toBe(false);
    expect(res.data.cursor).toBeGreaterThanOrEqual(res.data.ended[0].turnEndedAt);
  });

  it('since=<cursor> hides what was already reported, then shows what ended later', async () => {
    harness.ctx._session.markTurnEnded('hook');
    const first = await body(`sessions=${harness.ctx._sessionId}`);
    harness.ctx._session.turnEndedAt = first.data.cursor - 1; // ended before the cursor
    const quiet = await body(`sessions=${harness.ctx._sessionId}&since=${first.data.cursor}`);
    expect(quiet.data.ended).toEqual([]);
    harness.ctx._session.turnEndedAt = first.data.cursor + 5;
    const later = await body(`sessions=${harness.ctx._sessionId}&since=${first.data.cursor}`);
    expect(later.data.ended).toHaveLength(1);
  });

  it('parks while nothing qualifies and answers when a watched turn ends', async () => {
    const pending = harness.app.inject({ method: 'GET', url: url('sessions=worker-2&wait=5000') });
    await new Promise((r) => setTimeout(r, 50));
    expect(turnWatch.size).toBe(1);
    (harness.ctx.sessions.get('worker-2') as unknown as { markTurnEnded(s: string): void }).markTurnEnded('heuristic');
    turnWatch.notify('worker-2'); // what the session wiring does on `turnEnded`
    const res = JSON.parse((await pending).body);
    expect(res.data.ended.map((s: { id: string }) => s.id)).toEqual(['worker-2']);
    expect(res.data.timedOut).toBe(false);
    expect(turnWatch.size).toBe(0);
  });

  it('a wake for a stale stamp re-parks instead of answering with nothing', async () => {
    const pending = harness.app.inject({ method: 'GET', url: url('sessions=worker-2&wait=1000') });
    await new Promise((r) => setTimeout(r, 50));
    turnWatch.notify('worker-2'); // woken, but no stamp: keep waiting until the budget
    await new Promise((r) => setTimeout(r, 50));
    expect(turnWatch.size).toBe(1);
    const res = JSON.parse((await pending).body);
    expect(res.data).toMatchObject({ ended: [], gone: [], timedOut: true });
  });

  it('lists an unknown session under gone instead of failing the whole watch', async () => {
    const res = await body(`sessions=nope,worker-2&wait=5000`);
    expect(res.data.gone).toEqual(['nope']);
    expect(turnWatch.size).toBe(0);
  });

  it('answers at once without wait, and rejects an empty list and unknown params', async () => {
    const res = await body('sessions=worker-2');
    expect(res.data).toMatchObject({ ended: [], timedOut: false });
    expect((await harness.app.inject({ method: 'GET', url: url('sessions=,') })).json().success).toBe(false);
    expect((await harness.app.inject({ method: 'GET', url: url('sessions=a&bogus=1') })).statusCode).toBe(400);
  });

  it('carries the reason and the facts behind it', async () => {
    withTodos(harness.ctx._session, 2, 5);
    harness.ctx._session.markTurnEnded('hook');
    const res = await body(`sessions=${harness.ctx._sessionId}`);
    expect(res.data.ended[0]).toMatchObject({ reason: 'open-todos', openTodos: 2, totalTodos: 5, inboxPending: 0 });
  });

  it('a pending dialog qualifies a session whose turn has not ended, at the dialog time', async () => {
    vi.spyOn(approvalInbox, 'getForSession').mockImplementation((id) =>
      id === 'worker-2' ? ({ kind: 'question', createdAt: 4_242 } as never) : undefined
    );
    const res = await body('sessions=worker-2');
    expect(res.data.ended).toEqual([
      expect.objectContaining({ id: 'worker-2', reason: 'blocked', turnEndedAt: 4_242 }),
    ]);
    // Claude's own idle notice is no block.
    vi.spyOn(approvalInbox, 'getForSession').mockReturnValue({ kind: 'idle', createdAt: 1 } as never);
    expect((await body('sessions=worker-2')).data.ended).toEqual([]);
  });
});

describe('POST /api/sessions/:id/report-mute', () => {
  const calls: string[] = [];
  const reports = {
    mute: (id: string, ms: number) => {
      calls.push(`mute ${id} ${ms}`);
      return 1_000 + ms;
    },
    unmute: (id: string) => {
      calls.push(`unmute ${id}`);
      return true;
    },
  };
  let harness: RouteTestHarness;
  const post = (id: string, payload: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/report-mute`, payload });

  beforeEach(async () => {
    calls.length = 0;
    harness = await createRouteTestHarness((app, ctx) => registerAgentWatchRoutes(app, ctx, { reports }));
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('mutes for forMs and answers when it ends; 0 unmutes', async () => {
    const id = harness.ctx._sessionId;
    expect(JSON.parse((await post(id, { forMs: 60_000 })).body)).toMatchObject({ id, mutedUntil: 61_000 });
    expect(JSON.parse((await post(id, { forMs: 0 })).body)).toMatchObject({ id, mutedUntil: null });
    expect(calls).toEqual([`mute ${id} 60000`, `unmute ${id}`]);
  });

  it('refuses an unknown session, a bad body, more than 24 h', async () => {
    expect((await post('nope', { forMs: 1 })).statusCode).toBe(404);
    expect((await post(harness.ctx._sessionId, { forMs: -1 })).statusCode).toBe(400);
    expect((await post(harness.ctx._sessionId, { forMs: 25 * 3_600_000 })).statusCode).toBe(400);
    expect((await post(harness.ctx._sessionId, { forMs: 1, extra: 1 })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('report subscriptions (opt-in reports, Joe 2026-10-23)', () => {
  let harness: RouteTestHarness;
  let reports: CoordinatorReports;
  const post = (id: string, payload: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/report-subscription`, payload });
  const list = async () =>
    JSON.parse((await harness.app.inject({ method: 'GET', url: '/api/agent-report-subscriptions' })).body);

  beforeEach(async () => {
    turnWatch.resetForTests();
    agentInbox.resetForTests();
    harness = await createRouteTestHarness((app, ctx) => {
      reports = new CoordinatorReports({
        getSession: (id) => ctx.sessions.get(id),
        row: () => null,
        post: () => true,
        withdraw: () => {},
        enabled: () => true,
        log: () => {},
      });
      registerAgentWatchRoutes(app, ctx, { reports });
    });
    harness.ctx.sessions.set('coord-1', createMockSession('coord-1'));
    withTodos(harness.ctx._session);
  });
  afterEach(async () => {
    turnWatch.resetForTests();
    agentInbox.resetForTests();
    await harness.app.close();
  });

  it('subscribes, answers with the subscribers and where the worker stands now, and lists it', async () => {
    const id = harness.ctx._sessionId;
    harness.ctx._session.markTurnEnded('hook');
    const on = JSON.parse((await post(id, { subscriber: 'coord-1', subscribed: true })).body);
    expect(on).toMatchObject({ id, subscribers: ['coord-1'], row: expect.objectContaining({ id, reason: 'done' }) });
    expect(await list()).toEqual({ [id]: ['coord-1'] });
    const off = JSON.parse((await post(id, { subscriber: 'coord-1', subscribed: false })).body);
    expect(off).toMatchObject({ id, subscribers: [] });
    expect(await list()).toEqual({});
  });

  it('says null while a turn runs', async () => {
    harness.ctx._session.turnEndedAt = null;
    const on = JSON.parse((await post(harness.ctx._sessionId, { subscriber: 'coord-1', subscribed: true })).body);
    expect(on.row).toBeNull();
  });

  it('refuses a self-subscription, an unknown worker or subscriber, a bad body', async () => {
    const id = harness.ctx._sessionId;
    // This module answers a refusal as {success:false} (like `sessions: no ids given`).
    expect(JSON.parse((await post(id, { subscriber: id, subscribed: true })).body)).toMatchObject({
      success: false,
      error: expect.stringContaining('own reports'),
    });
    expect((await post('nope', { subscriber: 'coord-1', subscribed: true })).statusCode).toBe(404);
    expect((await post(id, { subscriber: 'nope', subscribed: true })).statusCode).toBe(404);
    expect((await post(id, { subscriber: 'coord-1' })).statusCode).toBe(400);
    expect((await post(id, { subscriber: 'coord-1', subscribed: true, extra: 1 })).statusCode).toBe(400);
    expect(await list()).toEqual({});
  });

  it('a subscriber that is gone can still be taken off; the list hides workers that are gone', async () => {
    const id = harness.ctx._sessionId;
    reports.subscribe(id, 'gone-subscriber');
    reports.subscribe('gone-worker', 'coord-1');
    expect(await list()).toEqual({ [id]: ['gone-subscriber'] });
    const off = JSON.parse((await post(id, { subscriber: 'gone-subscriber', subscribed: false })).body);
    expect(off).toMatchObject({ id, subscribers: [] });
  });
});

describe('classifyWatchReason', () => {
  const none = { blocked: false, inboxWaiting: false, inboxUnseen: 0, inboxPending: 0, openTodos: 0 };
  const session = (pane = '', source: 'hook' | 'heuristic' | 'exit' | null = 'hook') => ({
    turnEndSource: source,
    paneText: () => pane,
  });

  it('follows the documented precedence', () => {
    const all = { blocked: true, inboxWaiting: true, inboxUnseen: 1, inboxPending: 1, openTodos: 1 };
    const errPane = "  ⎿  API Error: Can't reach the API server (ENOTFOUND)\n";
    expect(classifyWatchReason(session(errPane, 'exit'), all)).toBe('exited');
    expect(classifyWatchReason(session(errPane), all)).toBe('blocked');
    expect(classifyWatchReason(session(errPane), { ...all, blocked: false })).toBe('api-error');
    expect(classifyWatchReason(session(), { ...all, blocked: false })).toBe('waiting-inbox');
    expect(classifyWatchReason(session(), { ...none, inboxUnseen: 1, inboxPending: 1, openTodos: 1 })).toBe(
      'inbox-unread'
    );
    expect(classifyWatchReason(session(), { ...none, inboxPending: 1, openTodos: 1 })).toBe('inbox-unacked');
    expect(classifyWatchReason(session(), { ...none, openTodos: 1 })).toBe('open-todos');
    expect(classifyWatchReason(session(), none)).toBe('done');
  });

  it('counts an API error only as its own line, not prose that mentions one', () => {
    expect(classifyWatchReason(session('we discussed the API Error yesterday'), none)).toBe('done');
    expect(classifyWatchReason(session('done.\nAPI Error: 529 overloaded'), none)).toBe('api-error');
  });
});
