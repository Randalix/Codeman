/**
 * Boot pass that reattaches remote (SSH) sessions after a reboot of THIS host,
 * without a click (web/reboot-remote-reattach.ts).
 *
 * `Session` is mocked like in routes/reboot-restore-remote.test.ts, so the pass
 * runs the shared construction path (`rebuildRebootEntry`) and the test can read
 * what it was given. The per-host pane listing is injected.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const constructed: Array<{ id: string; remote?: unknown }> = [];

vi.mock('../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    remote?: unknown;
    claudeSessionId: string | null = null;
    constructor(config: {
      id: string;
      mode?: string;
      name?: string;
      workingDir: string;
      owner?: string;
      remote?: unknown;
    }) {
      constructed.push(config);
      this.id = config.id;
      this.mode = config.mode ?? 'claude';
      this.name = config.name;
      this.workingDir = config.workingDir;
      this.owner = config.owner;
      this.remote = config.remote;
    }
    async startInteractive() {}
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
  },
}));

const { reattachRemoteRebootEntries } = await import('../src/web/reboot-remote-reattach.js');
const { rebootRestoreRegistry } = await import('../src/web/reboot-restore-registry.js');
const { parseRemoteListPanes, buildRemoteListPanesCommand } = await import('../src/remote-hosts.js');
const { createMockRouteContext } = await import('./mocks/index.js');
type RebootRestoreEntry = import('../src/reboot-restore.js').RebootRestoreEntry;
type SessionState = import('../src/types.js').SessionState;
type SessionRemote = import('../src/types.js').SessionRemote;
type RemoteCodemanPane = import('../src/remote-hosts.js').RemoteCodemanPane;

const REMOTE_PATH = '/nonexistent-on-this-host/codeman-boot-reattach';

function entry(
  sessionId: string,
  opts: { host?: string; local?: boolean; conversation?: string } = {}
): RebootRestoreEntry {
  const remote: SessionRemote | undefined = opts.local
    ? undefined
    : {
        hostId: opts.host ?? 'huff',
        label: 'Huff',
        host: opts.host ?? 'huff.test',
        username: 'u',
        remotePath: REMOTE_PATH,
        owned: true,
      };
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: REMOTE_PATH,
    mode: 'claude',
    resumeConversationId: opts.conversation ?? `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: 4242,
      status: 'idle',
      workingDir: REMOTE_PATH,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      ...(remote ? { remote } : {}),
    } as SessionState,
  };
}

function panes(...live: Array<string | [string, boolean]>): Map<string, RemoteCodemanPane> {
  return new Map(
    live.map((p) => {
      const [id, dead] = typeof p === 'string' ? [p, false] : p;
      const sessionName = `codeman-ssh-${id}`;
      return [sessionName, { sessionName, dead, command: 'claude', path: REMOTE_PATH }];
    })
  );
}

const offered = () =>
  rebootRestoreRegistry
    .list(() => true)
    .map((e) => e.sessionId)
    .sort();

const deps = (listPanes: (remote: SessionRemote) => Promise<Map<string, RemoteCodemanPane> | undefined>) => ({
  listPanes,
  readHosts: async () => [],
});

beforeEach(() => {
  constructed.length = 0;
});

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.clearAllMocks();
});

describe('reattachRemoteRebootEntries', () => {
  it('reattaches a session whose remote pane survived, without a click', async () => {
    rebootRestoreRegistry.set([entry('alive')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const res = await reattachRemoteRebootEntries(
      ctx as never,
      deps(async () => panes('alive'))
    );

    expect(res).toEqual({ reattached: ['alive'], leftOnOffer: [] });
    // Without `remote` the launch would be a LOCAL claude in a path that is not here.
    expect(constructed[0].remote).toEqual(expect.objectContaining({ host: 'huff.test' }));
    expect(ctx.sessions.has('alive')).toBe(true);
    expect(offered()).toEqual([]);
    expect(ctx.mux.startStatsCollection).toHaveBeenCalled();
  });

  it('leaves a gone or dead remote pane on the banner, where claude can still be resumed by choice', async () => {
    rebootRestoreRegistry.set([entry('gone'), entry('dead')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const res = await reattachRemoteRebootEntries(
      ctx as never,
      deps(async () => panes(['dead', true]))
    );

    expect(res.reattached).toEqual([]);
    expect(res.leftOnOffer.sort()).toEqual(['dead', 'gone']);
    expect(constructed).toEqual([]);
    expect(offered()).toEqual(['dead', 'gone']);
  });

  it('asks each host once, and keeps every entry of a silent host on offer', async () => {
    rebootRestoreRegistry.set([entry('a'), entry('b'), entry('c', { host: 'other.test' })]);
    const listPanes = vi.fn(async (remote: SessionRemote) => (remote.host === 'huff.test' ? undefined : panes('c')));
    const res = await reattachRemoteRebootEntries(createMockRouteContext() as never, deps(listPanes));

    expect(listPanes).toHaveBeenCalledTimes(2);
    expect(res.reattached).toEqual(['c']);
    expect(offered()).toEqual(['a', 'b']);
  });

  it('treats a listing that throws as a silent host', async () => {
    rebootRestoreRegistry.set([entry('r')]);
    const res = await reattachRemoteRebootEntries(
      createMockRouteContext() as never,
      deps(async () => {
        throw new Error('ssh exploded');
      })
    );
    expect(res).toEqual({ reattached: [], leftOnOffer: ['r'] });
    expect(offered()).toEqual(['r']);
  });

  it('leaves local entries to the banner', async () => {
    rebootRestoreRegistry.set([entry('local', { local: true }), entry('remote')]);
    const listPanes = vi.fn(async () => panes('remote', 'local'));
    const res = await reattachRemoteRebootEntries(createMockRouteContext() as never, deps(listPanes));

    expect(res.reattached).toEqual(['remote']);
    expect(offered()).toEqual(['local']);
  });

  it('a click while the pass waits on ssh cannot take the same entries', async () => {
    rebootRestoreRegistry.set([entry('remote'), entry('local', { local: true })]);
    let answer!: (p: Map<string, RemoteCodemanPane>) => void;
    const pending = reattachRemoteRebootEntries(
      createMockRouteContext() as never,
      deps(() => new Promise((resolve) => (answer = resolve)))
    );

    const clicked = rebootRestoreRegistry.take(() => true, undefined, 'joe');
    expect(clicked.map((e) => e.sessionId)).toEqual(['local']);

    answer(panes('remote'));
    expect((await pending).reattached).toEqual(['remote']);
    expect(constructed.map((c) => c.id)).toEqual(['remote']);
  });

  it('spends an entry whose conversation the user already resumed by hand', async () => {
    rebootRestoreRegistry.set([entry('r', { conversation: 'conv-live' })]);
    const ctx = createMockRouteContext();
    const [existing] = ctx.sessions.values();
    (existing as { claudeSessionId: string | null }).claudeSessionId = 'conv-live';

    const res = await reattachRemoteRebootEntries(
      ctx as never,
      deps(async () => panes('r'))
    );
    expect(res).toEqual({ reattached: [], leftOnOffer: [] });
    expect(constructed).toEqual([]);
    expect(offered()).toEqual([]);
  });

  it('a failed build goes back on offer', async () => {
    rebootRestoreRegistry.set([entry('r')]);
    const ctx = createMockRouteContext();
    ctx.setupSessionListeners.mockRejectedValueOnce(new Error('mux down'));

    const res = await reattachRemoteRebootEntries(
      ctx as never,
      deps(async () => panes('r'))
    );
    expect(res).toEqual({ reattached: [], leftOnOffer: ['r'] });
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('r');
    expect(offered()).toEqual(['r']);
  });

  it('does nothing without remote entries', async () => {
    rebootRestoreRegistry.set([entry('local', { local: true })]);
    const listPanes = vi.fn();
    const res = await reattachRemoteRebootEntries(createMockRouteContext() as never, deps(listPanes));
    expect(res).toEqual({ reattached: [], leftOnOffer: [] });
    expect(listPanes).not.toHaveBeenCalled();
  });
});

describe('remote pane listing', () => {
  it('parses name, dead flag, command and a path that contains the separator', () => {
    const out = 'codeman-ssh-aa|0|claude|/home/j/wiki\ncodeman-ssh-bb|1|bash|/tmp/a|b\n\ngarbage\n';
    expect([...parseRemoteListPanes(out).values()]).toEqual([
      { sessionName: 'codeman-ssh-aa', dead: false, command: 'claude', path: '/home/j/wiki' },
      { sessionName: 'codeman-ssh-bb', dead: true, command: 'bash', path: '/tmp/a|b' },
    ]);
  });

  it('keeps the first pane of a session with several', () => {
    const out = 'codeman-ssh-aa|0|claude|/one\ncodeman-ssh-aa|0|bash|/two\n';
    expect(parseRemoteListPanes(out).get('codeman-ssh-aa')?.path).toBe('/one');
  });

  it('lists the codeman-remote server in one ssh, BatchMode, without tabs in the format', () => {
    const cmd = buildRemoteListPanesCommand({ username: 'u', host: 'huff.test' });
    expect(cmd).toMatch(/^ssh -o BatchMode=yes/);
    expect(cmd).toContain('tmux -L codeman-remote list-panes -a');
    expect(cmd).not.toContain('\t');
  });
});

describe('wake invariant (wiring guard)', () => {
  it('the boot reattach pass never reaches the wake registry', () => {
    const src = readFileSync(join(__dirname, '..', 'src/web/reboot-remote-reattach.ts'), 'utf-8');
    expect(src).not.toMatch(/^import .*remote-wake/m);
    expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
  });
});
