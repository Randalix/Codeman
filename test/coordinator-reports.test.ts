/**
 * @fileoverview Coordinator reports (src/web/coordinator-reports.ts): a worker's turn end
 * reaches its parent's mailbox once, a pane that only became ready never does, and the
 * module cannot wake a host.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorReports,
  MAX_MUTE_MS,
  REPORT_DEBOUNCE_MS,
  reportText,
  type MuteSnapshot,
  type ReportSource,
  type SubscriptionSnapshot,
} from '../src/web/coordinator-reports.js';
import { TurnWatch } from '../src/web/agent-watch.js';
import type { WatchRow } from '../src/web/routes/agent-watch-routes.js';

const COORD = 'cccccccc-0000-4000-8000-000000000000';
const WORKER = 'wwwwwwww-0000-4000-8000-000000000000';

interface Fake extends ReportSource {
  parentSessionId: string | undefined;
  turnEndReady: boolean;
  row: WatchRow | null;
}

function row(over: Partial<WatchRow> = {}): WatchRow {
  return {
    id: WORKER,
    name: 'nb-wp1: Fundament',
    mode: 'claude',
    status: 'idle',
    turnEndedAt: 1_000,
    turnEndSource: 'hook',
    reason: 'done',
    openTodos: 1,
    totalTodos: 3,
    inboxPending: 0,
    inboxUnseen: 0,
    ...over,
  };
}

function setup(opts: { enabled?: boolean; postOk?: boolean } = {}) {
  const sessions = new Map<string, Fake>();
  const posts: { to: string; from: string; text: string; quiet: boolean }[] = [];
  const withdrawn: { to: string; from: string }[] = [];
  const logs: string[] = [];
  const saved: MuteSnapshot[] = [];
  const subsSaved: SubscriptionSnapshot[] = [];
  const reports = new CoordinatorReports({
    getSession: (id) => sessions.get(id),
    row: (id) => sessions.get(id)?.row ?? null,
    post: (to, from, text, { quiet }) => {
      if (opts.postOk === false) return false;
      posts.push({ to, from, text, quiet });
      return true;
    },
    withdraw: (to, from) => withdrawn.push({ to, from }),
    enabled: () => opts.enabled ?? true,
    log: (line) => logs.push(line),
    saveMutes: (snapshot) => saved.push(snapshot),
    saveSubscriptions: (snapshot) => subsSaved.push(snapshot),
  });
  const add = (id: string, over: Partial<Fake> = {}): Fake => {
    const s: Fake = { id, name: id.slice(0, 8), parentSessionId: undefined, turnEndReady: false, row: null, ...over };
    sessions.set(id, s);
    return s;
  };
  add(COORD);
  /** The worker, spawned by COORD and subscribed to by it (reports are opt-in). */
  const worker = (over: Partial<Fake> = {}): Fake => {
    const s = add(WORKER, { parentSessionId: COORD, ...over });
    reports.subscribe(WORKER, COORD);
    return s;
  };
  return { sessions, posts, withdrawn, logs, saved, subsSaved, reports, add, worker };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a worker turn end', () => {
  it('posts one line into the parent mailbox, under the worker id, after the burst settles', async () => {
    const { posts, reports, worker } = setup();
    worker({ row: row({ reason: 'inbox-unread', inboxPending: 1 }) });
    reports.notify(WORKER);
    reports.notify(WORKER); // hook + heuristic for the same turn
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS - 1);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].to).toBe(COORD);
    expect(posts[0].from).toBe(WORKER);
    expect(posts[0].text).toMatch(
      /^\[codeman watch\] IDLE {2}wwwwwwww {2}claude {2}since \d\d:\d\d \(hook\) {2}inbox-unread/
    );
    expect(posts[0].text).toContain('todos 1/3');
    expect(posts[0].text).toContain('codeman agent read wwwwwwww');
  });

  it('reports each latch stamp once, and the next turn again', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ row: row() });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    reports.notify(WORKER); // a late signal for the same stamp
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    w.row = row({ turnEndedAt: 9_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(2);
  });

  it('says BLOCKED for a dialog and EXITED for a pane exit', () => {
    expect(reportText(row({ reason: 'blocked', turnEndSource: null }))).toMatch(/BLOCKED .*\(dialog\) {2}blocked/);
    const exited = reportText(row({ reason: 'exited', turnEndSource: 'exit' }));
    expect(exited).toMatch(/^\[codeman watch\] EXITED /);
    expect(exited).not.toContain('agent read');
  });

  it('still tells the coordinator when the worker was closed before the report', async () => {
    const { sessions, posts, reports, worker } = setup();
    worker({ row: row({ reason: 'exited', turnEndSource: 'exit' }) });
    reports.notify(WORKER);
    sessions.delete(WORKER);
    reports.drop(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^\[codeman watch\] GONE {2}wwwwwwww {2}wwwwwwww$/);
  });
});

describe('when nothing is reported', () => {
  it('no subscriber, a self-subscription, or a subscriber that is gone', async () => {
    const { sessions, posts, reports, add } = setup();
    const SELF = 'ssssssss-0000-4000-8000-000000000000';
    add(WORKER, { parentSessionId: COORD, row: row() }); // spawned by COORD, but nobody subscribed
    reports.notify(WORKER);
    add(SELF, { row: row() });
    expect(reports.subscribe(SELF, SELF)).toBe(false);
    reports.notify(SELF);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    reports.subscribe(WORKER, COORD);
    sessions.delete(COORD);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('a pane that only became ready (launch, adoption after a restart)', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ turnEndReady: true, row: row({ turnEndSource: 'heuristic' }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
    // ...but a dialog on that pane is news
    w.row = row({ turnEndSource: 'heuristic', reason: 'blocked', turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
  });

  it('a turn that started again within the debounce', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ row: row() });
    reports.notify(WORKER);
    w.row = null;
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('switched off, or stopped', async () => {
    const off = setup({ enabled: false });
    off.worker({ row: row() });
    off.reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(off.posts).toEqual([]);

    const on = setup();
    on.worker({ row: row() });
    on.reports.notify(WORKER);
    on.reports.stop();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(on.posts).toEqual([]);
  });

  it('a refused post (full mailbox) is logged, not thrown', async () => {
    const { logs, reports, worker } = setup({ postOk: false });
    worker({ row: row() });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(logs).toEqual([expect.stringContaining('report not posted')]);
  });
});

describe('mute', () => {
  const MIN = 60_000;

  it('holds IDLE reports, but BLOCKED and EXITED still go out', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ row: row() });
    reports.mute(WORKER, 30 * MIN);
    for (const [t, over] of [
      [1_000, {}],
      [2_000, { reason: 'inbox-unread' }],
      [3_000, { reason: 'blocked', turnEndSource: null }],
      [4_000, { reason: 'exited', turnEndSource: 'exit' }],
    ] as const) {
      w.row = row({ turnEndedAt: t, ...over } as Partial<WatchRow>);
      reports.notify(WORKER);
      await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    }
    expect(posts.map((p) => p.text.split('  ')[0])).toEqual(['[codeman watch] BLOCKED', '[codeman watch] EXITED']);
  });

  it('when it runs out, reports the idle state it held back — once', async () => {
    const { posts, saved, reports, worker } = setup();
    worker({ row: row({ turnEndedAt: 5_000 }) });
    const until = reports.mute(WORKER, 10 * MIN);
    expect(reports.mutedUntil(WORKER)).toBe(until);
    expect(saved.at(-1)).toEqual({ [WORKER]: until });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('IDLE');
    expect(reports.mutedUntil(WORKER)).toBeNull();
    expect(saved.at(-1)).toEqual({});
  });

  it('runs out quietly when the worker is busy again, or its last stamp was reported', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ row: row() });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    reports.mute(WORKER, MIN);
    await vi.advanceTimersByTimeAsync(MIN + REPORT_DEBOUNCE_MS); // same stamp, already reported
    reports.mute(WORKER, MIN);
    w.row = null; // a turn runs
    await vi.advanceTimersByTimeAsync(MIN + REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
  });

  it('unmute lifts it at once and catches up; a second mute replaces the first', async () => {
    const { posts, reports, worker } = setup();
    worker({ row: row() });
    reports.mute(WORKER, MIN);
    const later = reports.mute(WORKER, 60 * MIN);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(posts).toEqual([]); // the first (1 min) timer is gone
    expect(reports.mutedUntil(WORKER)).toBe(later);
    expect(reports.unmute(WORKER)).toBe(true);
    expect(reports.unmute(WORKER)).toBe(false);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
  });

  it('is capped at 24 h, and a deleted worker takes its mute along', () => {
    const { saved, reports, worker } = setup();
    worker({ row: row() });
    expect(reports.mute(WORKER, 99 * MAX_MUTE_MS) - Date.now()).toBe(MAX_MUTE_MS);
    reports.drop(WORKER);
    expect(reports.mutedUntil(WORKER)).toBeNull();
    expect(saved.at(-1)).toEqual({});
  });

  it('survives a restart: live mutes re-armed, run-out and orphaned ones dropped', async () => {
    const { posts, saved, reports, worker } = setup();
    worker({ row: row() });
    const now = Date.now();
    const restored = reports.restoreMutes(
      { [WORKER]: now + 5 * MIN, 'gone-0000': now + 5 * MIN, [COORD]: now - 1 },
      (id) => id === WORKER || id === COORD
    );
    expect(restored).toBe(1);
    expect(reports.mutedUntil(WORKER)).toBe(now + 5 * MIN);
    expect(saved.at(-1)).toEqual({ [WORKER]: now + 5 * MIN });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(posts).toHaveLength(1);
  });

  it('shutdown keeps the persisted mutes (stop does not save an empty set)', () => {
    const { saved, reports, worker } = setup();
    worker({ row: row() });
    reports.mute(WORKER, MIN);
    const writes = saved.length;
    reports.stop();
    expect(saved).toHaveLength(writes);
  });
});

describe('digest (w3c, 2026-10-11: one IDLE post per turn cost the coordinator a turn each)', () => {
  it('IDLE goes out quiet; BLOCKED, EXITED and GONE stay loud', async () => {
    const { sessions, posts, reports, worker } = setup();
    const w = worker({ row: row({ reason: 'open-todos' }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'blocked', turnEndSource: null, turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'exited', turnEndSource: 'exit', turnEndedAt: 3_000 });
    reports.notify(WORKER);
    sessions.delete(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.map((p) => [p.text.split('  ')[0], p.quiet])).toEqual([
      ['[codeman watch] IDLE', true],
      ['[codeman watch] BLOCKED', false],
      ['[codeman watch] GONE', false],
    ]);
  });

  it('an IDLE whose reason is done goes out loud (Joe, 2026-10-17: the hand-off sat up to 10 min)', async () => {
    const { posts, reports, worker } = setup();
    const w = worker({ row: row({ reason: 'inbox-unread', inboxPending: 1 }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'done', openTodos: 0, turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'open-todos', turnEndedAt: 3_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.map((p) => [p.text.split('  ')[0], p.text.includes('  done  '), p.quiet])).toEqual([
      ['[codeman watch] IDLE', false, true],
      ['[codeman watch] IDLE', true, false],
      ['[codeman watch] IDLE', false, true],
    ]);
  });

  it('an IDLE whose reason is api-error goes out loud too (the worker hangs until someone acts)', async () => {
    const { posts, reports, worker } = setup();
    worker({ row: row({ reason: 'api-error' }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.map((p) => [p.text.includes('  api-error  '), p.quiet])).toEqual([[true, false]]);
  });

  it('a muted worker reports no done either', async () => {
    const { posts, reports, worker } = setup();
    worker({ row: row({ reason: 'done', openTodos: 0 }) });
    reports.mute(WORKER, 60_000);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('a worker parked on its own inbox (waiting-inbox) is not reported; its old line is withdrawn', async () => {
    const { posts, withdrawn, reports, worker } = setup();
    const w = worker({ row: row({ reason: 'done' }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'waiting-inbox', turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    reports.notify(WORKER); // same stamp again: no second withdraw
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    expect(withdrawn).toEqual([{ to: COORD, from: WORKER }]);
  });

  it('a pane exit is reported as EXITED even when the row still says waiting-inbox', async () => {
    const { posts, withdrawn, reports, worker } = setup();
    worker({ row: row({ reason: 'waiting-inbox', turnEndSource: 'exit' }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.map((p) => [p.text.split('  ')[0], p.quiet])).toEqual([['[codeman watch] EXITED', false]]);
    expect(withdrawn).toEqual([]);
  });
});

describe('subscriptions (Joe, 2026-10-23: reports are opt-in, they spammed sessions that never asked)', () => {
  const OTHER = 'oooooooo-0000-4000-8000-000000000000';

  it('without a subscription not even BLOCKED or EXITED goes to the parent', async () => {
    const { posts, reports, add } = setup();
    const w = add(WORKER, { parentSessionId: COORD, row: row({ reason: 'blocked', turnEndSource: null }) });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ reason: 'exited', turnEndSource: 'exit', turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('any session may subscribe, and every live subscriber gets the line', async () => {
    const { sessions, posts, subsSaved, reports, add } = setup();
    add(WORKER, { row: row() }); // no parent at all
    add(OTHER);
    expect(reports.subscribe(WORKER, COORD)).toBe(true);
    expect(reports.subscribe(WORKER, OTHER)).toBe(true);
    expect(reports.subscribe(WORKER, OTHER)).toBe(true); // idempotent, no second save
    expect(subsSaved).toEqual([{ [WORKER]: [COORD] }, { [WORKER]: [COORD, OTHER] }]);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.map((p) => [p.to, p.from])).toEqual([
      [COORD, WORKER],
      [OTHER, WORKER],
    ]);
    // A subscriber that is gone is skipped, the others still get it.
    sessions.delete(OTHER);
    sessions.get(WORKER)!.row = row({ turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts.slice(2).map((p) => p.to)).toEqual([COORD]);
  });

  it('an unsubscribe ends the reports, also one already settling in the debounce, and withdraws the unseen line', async () => {
    const { posts, withdrawn, subsSaved, reports, worker } = setup();
    const w = worker({ row: row() });
    reports.notify(WORKER);
    expect(reports.unsubscribe(WORKER, COORD)).toBe(true);
    expect(reports.unsubscribe(WORKER, COORD)).toBe(false);
    expect(withdrawn).toEqual([{ to: COORD, from: WORKER }]);
    expect(reports.subscribers(WORKER)).toEqual([]);
    expect(subsSaved.at(-1)).toEqual({});
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    w.row = row({ turnEndedAt: 2_000 });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('a waiting-inbox line is withdrawn from every subscriber', async () => {
    const { withdrawn, reports, add } = setup();
    add(WORKER, { row: row({ reason: 'waiting-inbox' }) });
    add(OTHER);
    reports.subscribe(WORKER, COORD);
    reports.subscribe(WORKER, OTHER);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(withdrawn).toEqual([
      { to: COORD, from: WORKER },
      { to: OTHER, from: WORKER },
    ]);
  });

  it('a deleted session takes its subscriptions along, as worker and as subscriber; a detach keeps them', () => {
    const { subsSaved, reports, add } = setup();
    add(WORKER, { row: row() });
    add(OTHER);
    reports.subscribe(WORKER, COORD);
    reports.subscribe(OTHER, WORKER); // the worker is itself a coordinator
    reports.drop(WORKER, { keepSubscriptions: true });
    expect(reports.subscriptions()).toEqual({ [WORKER]: [COORD], [OTHER]: [WORKER] });
    reports.drop(WORKER);
    expect(reports.subscriptions()).toEqual({});
    expect(subsSaved.at(-1)).toEqual({});
  });

  it('every line but GONE names the command that stops it', () => {
    expect(reportText(row())).toMatch(
      /— answer: `codeman agent read wwwwwwww` · no more reports: `codeman agent unsubscribe wwwwwwww`$/
    );
    const exited = reportText(row({ reason: 'exited', turnEndSource: 'exit' }));
    expect(exited).toMatch(/— no more reports: `codeman agent unsubscribe wwwwwwww`$/);
    expect(exited).not.toContain('agent read');
  });

  it('survive a restart: pairs whose worker or subscriber did not come back are dropped', () => {
    const { subsSaved, reports, add } = setup();
    add(WORKER);
    add(OTHER);
    const live = new Set([COORD, WORKER, OTHER]);
    const restored = reports.restoreSubscriptions(
      { [WORKER]: [COORD, 'gone-0000', WORKER], [OTHER]: [COORD], 'gone-1111': [COORD] },
      (id) => live.has(id)
    );
    expect(restored).toBe(2);
    expect(reports.subscriptions()).toEqual({ [WORKER]: [COORD], [OTHER]: [COORD] });
    expect(subsSaved.at(-1)).toEqual({ [WORKER]: [COORD], [OTHER]: [COORD] });
  });

  it('a clean restore does not rewrite the file', () => {
    const { subsSaved, reports, add } = setup();
    add(WORKER);
    expect(reports.restoreSubscriptions({ [WORKER]: [COORD] }, () => true)).toBe(1);
    expect(subsSaved).toEqual([]);
  });

  it('the first boot adopts each living parent once; a dead parent or a self-parent is not adopted', () => {
    const { subsSaved, reports, add } = setup();
    add(WORKER, { parentSessionId: COORD });
    add(OTHER, { parentSessionId: 'dead-0000' });
    add('ssssssss-0000-4000-8000-000000000000', { parentSessionId: 'ssssssss-0000-4000-8000-000000000000' });
    expect(reports.adoptParents([COORD, WORKER, OTHER, 'ssssssss-0000-4000-8000-000000000000'])).toBe(1);
    expect(reports.subscriptions()).toEqual({ [WORKER]: [COORD] });
    expect(subsSaved).toEqual([{ [WORKER]: [COORD] }]);
  });

  it('adopting nothing still writes the file, so the next boot does not adopt again', () => {
    const { subsSaved, reports } = setup();
    expect(reports.adoptParents([COORD])).toBe(0);
    expect(subsSaved).toEqual([{}]);
  });
});

describe('turnWatch subscription', () => {
  it('every notify reaches the subscribers, until they unsubscribe', () => {
    const watch = new TurnWatch();
    const heard: string[] = [];
    const off = watch.subscribe((id) => heard.push(id));
    watch.notify(WORKER);
    off();
    watch.notify(WORKER);
    expect(heard).toEqual([WORKER]);
  });
});

describe('wiring guard', () => {
  const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf-8');

  it('boot subscribes the reports to turnWatch after the restore, and shutdown unsubscribes', () => {
    const restore = server.indexOf('await this.restoreMuxSessions()');
    const subscribe = server.indexOf('turnWatch.subscribe((id) => this.coordinatorReports.notify(id))', restore);
    expect(restore).toBeGreaterThan(0);
    expect(subscribe).toBeGreaterThan(restore);
    expect(server).toContain('this.unsubscribeCoordinatorReports?.();');
    expect(server).toContain('this.coordinatorReports.drop(sessionId, { keepSubscriptions: !killMux });');
  });

  it('boot restores the subscriptions (or adopts the parents) before it subscribes, and persists them', () => {
    const restoreSubs = server.indexOf('this.restoreReportSubscriptions();');
    const subscribe = server.indexOf('turnWatch.subscribe((id) => this.coordinatorReports.notify(id))');
    expect(restoreSubs).toBeGreaterThan(0);
    expect(restoreSubs).toBeLessThan(subscribe);
    expect(server).toContain('saveSubscriptions: (snapshot) => this.persistReportSubscriptions(snapshot),');
    expect(server).toContain('this.coordinatorReports.adoptParents(this.sessions.keys())');
    expect(server).toContain('this.coordinatorReports.drop(sessionId, { keepSubscriptions: !killMux });');
  });

  it('boot restores the mutes before it subscribes, and the route gets the reporter', () => {
    const restoreMutes = server.indexOf('this.restoreReportMutes();');
    const subscribe = server.indexOf('turnWatch.subscribe((id) => this.coordinatorReports.notify(id))');
    expect(restoreMutes).toBeGreaterThan(0);
    expect(restoreMutes).toBeLessThan(subscribe);
    expect(server).toContain('registerAgentWatchRoutes(this.app, ctx, { reports: this.coordinatorReports });');
    expect(server).toContain('saveMutes: (snapshot) => this.persistReportMutes(snapshot),');
  });

  it('posts through the nudger path, never the wake registry', () => {
    const src = readFileSync(new URL('../src/web/coordinator-reports.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/^import .*remote-wake/m);
    expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
    const block = server.slice(
      server.indexOf('new CoordinatorReports('),
      server.indexOf('private unsubscribeCoordinatorReports')
    );
    expect(block).toContain('this.inboxNudger.schedule(');
    expect(block).not.toMatch(/remoteWake|RemoteWake|ensureAwake/);
  });

  it('a quiet report replaces the old line and draws no nudge; quiet mail is never a nudge reason', () => {
    const block = server.slice(
      server.indexOf('new CoordinatorReports('),
      server.indexOf('private unsubscribeCoordinatorReports')
    );
    expect(block).toContain('agentInbox.post(to, from, text, { quiet, replaceQuiet: true })');
    expect(block).toContain('if (!quiet) this.inboxNudger.schedule(');
    expect(block).toContain('agentInbox.withdrawQuiet(to, from)');
    expect(server).toContain('unseen: (id) => agentInbox.unseen(id).filter((m) => !m.quiet),');
  });
});
