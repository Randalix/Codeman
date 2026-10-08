/**
 * @fileoverview `GET /api/agent-watch` via app.inject(): level-triggered with a cursor,
 * so a turn that ended before the call is still reported and none is lost between calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerAgentWatchRoutes } from '../../src/web/routes/agent-watch-routes.js';
import { turnWatch } from '../../src/web/agent-watch.js';
import { createMockSession } from '../mocks/index.js';

describe('GET /api/agent-watch', () => {
  let harness: RouteTestHarness;
  const url = (query: string) => `/api/agent-watch?${query}`;

  beforeEach(async () => {
    turnWatch.resetForTests();
    harness = await createRouteTestHarness(registerAgentWatchRoutes);
    const second = createMockSession('worker-2');
    harness.ctx.sessions.set('worker-2', second);
  });

  afterEach(async () => {
    turnWatch.resetForTests();
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
});
