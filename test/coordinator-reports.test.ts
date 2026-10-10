/**
 * @fileoverview Coordinator reports (src/web/coordinator-reports.ts): a worker's turn end
 * reaches its parent's mailbox once, a pane that only became ready never does, and the
 * module cannot wake a host.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorReports,
  REPORT_DEBOUNCE_MS,
  reportText,
  type ReportSource,
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
  const posts: { to: string; from: string; text: string }[] = [];
  const logs: string[] = [];
  const reports = new CoordinatorReports({
    getSession: (id) => sessions.get(id),
    row: (id) => sessions.get(id)?.row ?? null,
    post: (to, from, text) => {
      if (opts.postOk === false) return false;
      posts.push({ to, from, text });
      return true;
    },
    enabled: () => opts.enabled ?? true,
    log: (line) => logs.push(line),
  });
  const add = (id: string, over: Partial<Fake> = {}): Fake => {
    const s: Fake = { id, name: id.slice(0, 8), parentSessionId: undefined, turnEndReady: false, row: null, ...over };
    sessions.set(id, s);
    return s;
  };
  add(COORD);
  return { sessions, posts, logs, reports, add };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a worker turn end', () => {
  it('posts one line into the parent mailbox, under the worker id, after the burst settles', async () => {
    const { posts, reports, add } = setup();
    add(WORKER, { parentSessionId: COORD, row: row({ reason: 'inbox-unread', inboxPending: 1 }) });
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
    const { posts, reports, add } = setup();
    const w = add(WORKER, { parentSessionId: COORD, row: row() });
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
    const { sessions, posts, reports, add } = setup();
    add(WORKER, { parentSessionId: COORD, row: row({ reason: 'exited', turnEndSource: 'exit' }) });
    reports.notify(WORKER);
    sessions.delete(WORKER);
    reports.drop(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^\[codeman watch\] GONE {2}wwwwwwww {2}wwwwwwww$/);
  });
});

describe('when nothing is reported', () => {
  it('no parent, a self-parent, or a parent that is gone', async () => {
    const { sessions, posts, reports, add } = setup();
    add(WORKER, { row: row() });
    reports.notify(WORKER);
    add('ssssssss-0000-4000-8000-000000000000', {
      parentSessionId: 'ssssssss-0000-4000-8000-000000000000',
      row: row(),
    });
    reports.notify('ssssssss-0000-4000-8000-000000000000');
    sessions.get(WORKER)!.parentSessionId = COORD;
    sessions.delete(COORD);
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('a pane that only became ready (launch, adoption after a restart)', async () => {
    const { posts, reports, add } = setup();
    const w = add(WORKER, { parentSessionId: COORD, turnEndReady: true, row: row({ turnEndSource: 'heuristic' }) });
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
    const { posts, reports, add } = setup();
    const w = add(WORKER, { parentSessionId: COORD, row: row() });
    reports.notify(WORKER);
    w.row = null;
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(posts).toEqual([]);
  });

  it('switched off, or stopped', async () => {
    const off = setup({ enabled: false });
    off.add(WORKER, { parentSessionId: COORD, row: row() });
    off.reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(off.posts).toEqual([]);

    const on = setup();
    on.add(WORKER, { parentSessionId: COORD, row: row() });
    on.reports.notify(WORKER);
    on.reports.stop();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(on.posts).toEqual([]);
  });

  it('a refused post (full mailbox) is logged, not thrown', async () => {
    const { logs, reports, add } = setup({ postOk: false });
    add(WORKER, { parentSessionId: COORD, row: row() });
    reports.notify(WORKER);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(logs).toEqual([expect.stringContaining('report not posted')]);
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
    expect(server).toContain('this.coordinatorReports.drop(sessionId);');
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
});
