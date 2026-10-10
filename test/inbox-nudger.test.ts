/**
 * @fileoverview The inbox nudger (src/web/inbox-nudger.ts): when a post is announced
 * in the receiver's pane, when it is deliberately not, and that it can never wake a host.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInbox } from '../src/web/agent-inbox.js';
import {
  InboxNudger,
  NUDGE_COOLDOWN_MS,
  NUDGE_DEBOUNCE_MS,
  NUDGE_MAX_DEFER_MS,
  NUDGE_RESTART_DELAY_MS,
  nudgeText,
  type NudgeTarget,
} from '../src/web/inbox-nudger.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000000';
const B = 'bbbbbbbb-0000-4000-8000-000000000000';

class FakeSession extends EventEmitter implements NudgeTarget {
  status = 'idle';
  draft = false;
  written: string[] = [];
  hasDraft(): boolean {
    return this.draft;
  }
  constructor(
    readonly id: string,
    readonly mode = 'claude',
    readonly remote: { host: string; port?: number } | undefined = undefined
  ) {
    super();
  }
  async writeViaMux(data: string): Promise<boolean> {
    this.written.push(data);
    return true;
  }
}

function setup(opts: { foreground?: string | null; reachable?: boolean; enabled?: boolean } = {}) {
  const inbox = new AgentInbox();
  const sessions = new Map<string, FakeSession>();
  const probes: string[] = [];
  const logs: string[] = [];
  const nudger = new InboxNudger({
    getSession: (id) => sessions.get(id),
    unseen: (id) => inbox.unseen(id),
    pendingCount: (id) => inbox.pendingCount(id),
    isWaiting: (id) => inbox.summary().get(id)?.waiting === true,
    isShellMode: (mode) => mode === 'shell',
    agentInForeground: () => ['codex', 'claude'].includes(opts.foreground ?? ''),
    probeRemote: async (remote) => {
      probes.push(remote.host);
      return opts.reachable ?? true;
    },
    enabled: () => opts.enabled ?? true,
    now: () => Date.now(),
    log: (line) => logs.push(line),
  });
  const post = (to: string, from: string, text = 'hi', nudge?: boolean) => {
    const receiverWaiting = inbox.waiterCount(to) > 0; // what the route does
    const r = inbox.post(to, from, text);
    if (!r.ok) throw new Error(r.reason);
    nudger.schedule(to, from, { nudge, messageId: r.message.id, receiverWaiting });
    return r.message;
  };
  return { inbox, sessions, nudger, post, probes, logs };
}

/** Let the debounce fire and the async check (probe + write) settle. */
async function settle(ms = NUDGE_DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('when a post is announced', () => {
  it('types one line into an idle receiver after the burst settles', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    post(A, B, 'one');
    post(A, B, 'two');
    await settle(NUDGE_DEBOUNCE_MS - 1);
    expect(s.written).toEqual([]);
    await settle(1);
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toMatch(/^\[codeman inbox\] 2 new messages from bbbbbbbb \(2 pending\)\..*\r$/);
    expect(s.written[0]).toContain('codeman agent inbox');
  });

  it('text is printable apart from the trailing CR, and strips control bytes from the sender label', () => {
    const text = nudgeText([{ id: 'x', from: 'evil\u001b[2J\u0003', text: 't', createdAt: 0 }], 1);
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    expect(text).toContain('evil[2J');
  });

  it('waits for a busy receiver to go idle', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    post(A, B);
    await settle();
    expect(s.written).toEqual([]);
    s.status = 'idle';
    s.emit('idle');
    await settle(0);
    expect(s.written).toHaveLength(1);
  });

  it('types anyway once a busy receiver has been left alone for the max defer', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    post(A, B);
    await settle();
    await settle(NUDGE_MAX_DEFER_MS - 1);
    expect(s.written).toEqual([]);
    await settle(1);
    expect(s.written).toHaveLength(1);
    expect(s.listenerCount('idle')).toBe(0);
  });

  it('nudges again for a later message, but not inside the cooldown', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    post(A, B, 'one');
    await settle();
    expect(s.written).toHaveLength(1);
    post(A, B, 'two');
    await settle();
    expect(s.written).toHaveLength(1); // cooldown
    await settle(NUDGE_COOLDOWN_MS);
    expect(s.written).toHaveLength(2);
    expect(s.written[1]).toMatch(/1 new message from bbbbbbbb \(2 pending\)/);
  });

  it('waits while a human has a draft in the composer, and never types over it', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    s.draft = true;
    sessions.set(A, s);
    post(A, B);
    await settle();
    expect(s.written).toEqual([]);
    s.draft = false; // submitted
    await settle(NUDGE_COOLDOWN_MS);
    expect(s.written).toHaveLength(1);

    const stuck = setup();
    const t = new FakeSession(A);
    t.draft = true;
    stuck.sessions.set(A, t);
    stuck.post(A, B);
    await settle();
    await settle(NUDGE_MAX_DEFER_MS + NUDGE_COOLDOWN_MS);
    expect(t.written).toEqual([]); // never submits the draft, however long it sits
  });

  it('does not give up on a long draft: the nudge follows once it is gone', async () => {
    const { sessions, post, logs } = setup();
    const s = new FakeSession(A);
    s.draft = true;
    sessions.set(A, s);
    post(A, B);
    await settle();
    for (let i = 0; i < 4; i++) await settle(NUDGE_MAX_DEFER_MS);
    expect(s.written).toEqual([]);
    expect(logs.filter((l) => l.includes('draft'))).toHaveLength(1); // once per draft, not per retry
    s.draft = false; // sent or cleared, 20 min later
    await settle(NUDGE_COOLDOWN_MS);
    expect(s.written).toHaveLength(1);
  });

  it('a submitted draft gets the full idle wait: no typing into the turn it started', async () => {
    const { sessions, post } = setup();
    const s = new FakeSession(A);
    s.draft = true;
    sessions.set(A, s);
    post(A, B);
    await settle();
    await settle(NUDGE_MAX_DEFER_MS + NUDGE_COOLDOWN_MS); // draft outlived the busy max defer
    s.draft = false;
    s.status = 'busy'; // the submitted draft runs a turn
    await settle(NUDGE_COOLDOWN_MS);
    expect(s.written).toEqual([]);
    s.status = 'idle';
    s.emit('idle');
    await settle();
    expect(s.written).toHaveLength(1);
  });

  it('types into a shell-mode pane only when an agent CLI is in the foreground', async () => {
    for (const [fg, expected] of [
      ['codex', 1],
      ['bash', 0],
      [null, 0],
    ] as const) {
      const { sessions, post } = setup({ foreground: fg });
      const s = new FakeSession(A, 'shell');
      sessions.set(A, s);
      post(A, B);
      await settle();
      expect(s.written, String(fg)).toHaveLength(expected);
    }
  });

  it('probes a remote host and types only when it answers', async () => {
    for (const reachable of [true, false]) {
      const { sessions, post, probes } = setup({ reachable });
      const s = new FakeSession(A, 'claude', { host: 'hufflepuff' });
      sessions.set(A, s);
      post(A, B);
      await settle();
      expect(probes).toEqual(['hufflepuff']);
      expect(s.written).toHaveLength(reachable ? 1 : 0);
    }
  });
});

describe('when it is deliberately not announced', () => {
  it('a receiver parked on inbox --wait has already seen it', async () => {
    const { inbox, sessions, post } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    const reading = inbox.read(A, 60_000);
    post(A, B);
    await reading;
    await settle();
    expect(s.written).toEqual([]);
  });

  it('a --peek monitor loop parked on the inbox is not typed at either', async () => {
    const { inbox, sessions, post } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    const peeking = inbox.read(A, 60_000, undefined, { peek: true });
    post(A, B);
    await peeking;
    await settle();
    expect(s.written).toEqual([]);
  });

  it('a deferral that ended in a read does not make the next post skip the wait', async () => {
    const { inbox, sessions, post } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    post(A, B, 'one');
    await settle();
    await settle(NUDGE_MAX_DEFER_MS / 2);
    await inbox.read(A);
    s.emit('idle'); // turn ended after reading: nothing left to announce
    await settle(0);
    await settle(NUDGE_MAX_DEFER_MS);
    post(A, B, 'two'); // still busy: must wait again, not inherit the old deferral
    await settle();
    expect(s.written).toEqual([]);
  });

  it('mail read during the debounce is not announced', async () => {
    const { inbox, sessions, post } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    post(A, B);
    await inbox.read(A);
    await settle();
    expect(s.written).toEqual([]);
  });

  it('opt-outs: nudge:false, the global switch, a note to self, a stopped or unknown session', async () => {
    const cases: Array<[string, (x: ReturnType<typeof setup>, s: FakeSession) => void]> = [
      ['nudge:false', (x) => x.post(A, B, 'hi', false)],
      ['self', (x) => x.post(A, A)],
      [
        'stopped',
        (x, s) => {
          s.status = 'stopped';
          x.post(A, B);
        },
      ],
      [
        'unknown',
        (x) => {
          x.sessions.delete(A);
          x.post(A, B);
        },
      ],
    ];
    for (const [name, act] of cases) {
      const x = setup();
      const s = new FakeSession(A);
      x.sessions.set(A, s);
      act(x, s);
      await settle();
      expect(s.written, name).toEqual([]);
    }
    const off = setup({ enabled: false });
    const s = new FakeSession(A);
    off.sessions.set(A, s);
    off.post(A, B);
    await settle();
    expect(s.written, 'CODEMAN_INBOX_NUDGE=0').toEqual([]);
  });

  it('drop() cancels a pending nudge and its idle listener', async () => {
    const { sessions, nudger, post } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    post(A, B);
    await settle();
    expect(s.listenerCount('idle')).toBe(1);
    nudger.drop(A);
    expect(s.listenerCount('idle')).toBe(0);
    await settle(NUDGE_MAX_DEFER_MS);
    expect(s.written).toEqual([]);
  });
});

describe('after a server restart', () => {
  it('rearm announces mail that is already there, after the settle delay', async () => {
    const { inbox, sessions, nudger } = setup();
    const s = new FakeSession(A);
    sessions.set(A, s);
    inbox.post(A, B, 'restored'); // in the store, no schedule(): what boot sees
    nudger.rearm(A);
    await settle(NUDGE_RESTART_DELAY_MS - 1);
    expect(s.written).toEqual([]);
    await settle(1);
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toMatch(/1 new message from bbbbbbbb/);
  });

  it('rearm keeps every rule: no mail, disabled, busy and draft all hold', async () => {
    const empty = setup();
    const e = new FakeSession(A);
    empty.sessions.set(A, e);
    empty.nudger.rearm(A);
    await settle(NUDGE_RESTART_DELAY_MS);
    expect(e.written).toEqual([]);

    const off = setup({ enabled: false });
    const o = new FakeSession(A);
    off.sessions.set(A, o);
    off.inbox.post(A, B, 'x');
    off.nudger.rearm(A);
    await settle(NUDGE_RESTART_DELAY_MS);
    expect(o.written).toEqual([]);

    const busy = setup();
    const b = new FakeSession(A);
    b.status = 'busy';
    b.draft = true;
    busy.sessions.set(A, b);
    busy.inbox.post(A, B, 'x');
    busy.nudger.rearm(A);
    await settle(NUDGE_RESTART_DELAY_MS);
    expect(b.written).toEqual([]);
    b.status = 'idle';
    b.emit('idle');
    await settle();
    expect(b.written).toEqual([]); // still a draft
    b.draft = false;
    await settle(NUDGE_COOLDOWN_MS);
    expect(b.written).toHaveLength(1);
  });
});

describe('a restart does not restart the busy wait', () => {
  // 2026-10-10: post 23:53:55 to a busy receiver, deploy 23:56:22, nudge only 00:01:55 —
  // the restart began the 5-minute wait again instead of counting from the post.
  it('counts the max defer from the post, not from the restart', async () => {
    const { inbox, sessions, nudger } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    inbox.post(A, B, 'restored'); // landed before the restart, still busy since
    await settle(4 * 60_000);
    nudger.rearm(A); // the new process
    await settle(NUDGE_RESTART_DELAY_MS);
    expect(s.written).toEqual([]); // 4.5 min since the post: still within the defer
    await settle(NUDGE_MAX_DEFER_MS - 4 * 60_000 - NUDGE_RESTART_DELAY_MS);
    expect(s.written).toHaveLength(1);
  });

  it('types right after the settle delay when the post is older than the max defer', async () => {
    const { inbox, sessions, nudger } = setup();
    const s = new FakeSession(A);
    s.status = 'busy';
    sessions.set(A, s);
    inbox.post(A, B, 'restored');
    await settle(NUDGE_MAX_DEFER_MS * 2);
    nudger.rearm(A);
    await settle(NUDGE_RESTART_DELAY_MS);
    expect(s.written).toHaveLength(1);
  });
});

describe('wiring guard', () => {
  it('boot rearms the nudger for restored mail, after the restore and its prune', () => {
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf-8');
    const restore = server.indexOf('await this.restoreMuxSessions()');
    const prune = server.indexOf('agentInbox.pruneExcept(', restore);
    const rearm = server.indexOf('this.inboxNudger.rearm(', prune);
    expect(restore).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(restore);
    expect(rearm).toBeGreaterThan(prune);
  });

  it('the nudger cannot reach the wake registry (a post must never wake a host)', () => {
    const src = readFileSync(new URL('../src/web/inbox-nudger.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/^import .*remote-wake/m);
    expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf-8');
    const block = server.slice(
      server.indexOf('new InboxNudger('),
      server.indexOf('});', server.indexOf('new InboxNudger('))
    );
    expect(block).toContain('probeRemoteHostReachable');
    expect(block).not.toMatch(/remoteWake|ensureAwake|wake\(/);
  });
});
