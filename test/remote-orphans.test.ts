/**
 * Orphan safety net (web/remote-orphans.ts): adopt remote sessions this
 * instance launched but no longer shows, proven by its own lifecycle log.
 *
 * `Session` is mocked like in reboot-remote-reattach.test.ts, so adoption runs
 * the shared construction path (`rebuildRebootEntry`).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';

const constructed: Array<{ id: string; mode?: string; name?: string; workingDir: string; remote?: unknown }> = [];

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

const { selectAdoptableOrphans, orphanEntry, adoptRemoteOrphans } = await import('../src/web/remote-orphans.js');
const { runBootRemoteReattach } = await import('../src/web/reboot-remote-reattach.js');
const { rebootRestoreRegistry } = await import('../src/web/reboot-restore-registry.js');
const { registerRebootRestoreRoutes } = await import('../src/web/routes/reboot-restore-routes.js');
const { getLifecycleLog } = await import('../src/session-lifecycle-log.js');
const { createMockRouteContext } = await import('./mocks/index.js');
type LifecycleEntry = import('../src/types.js').LifecycleEntry;
type RemoteHost = import('../src/types.js').RemoteHost;
type SessionState = import('../src/types.js').SessionState;
type RemoteCodemanPane = import('../src/remote-hosts.js').RemoteCodemanPane;

const ID = 'aaaa1111-0000-4000-8000-000000000001';
const HOST: RemoteHost = { id: 'huff', label: 'Huff', host: 'huff.test', username: 'u', identityFile: '~/.ssh/k' };

function pane(id: string, opts: { dead?: boolean; command?: string; path?: string } = {}): RemoteCodemanPane {
  return {
    sessionName: `codeman-ssh-${id.slice(0, 8)}`,
    dead: opts.dead ?? false,
    command: opts.command ?? 'claude',
    path: opts.path ?? '/home/u/proj',
  };
}

const panesOf = (...p: RemoteCodemanPane[]) => new Map(p.map((x) => [x.sessionName, x]));

let ts = 0;
function ev(event: LifecycleEntry['event'], sessionId = ID, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return { ts: ++ts, event, sessionId, ...extra };
}

const nobodyKnows = () => false;

describe('selectAdoptableOrphans', () => {
  it('adopts a pane whose id this instance created and never deleted, with its last name and mode', () => {
    const picked = selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, [
      ev('created', ID, { name: 'first' }),
      ev('recovered', ID, { name: 'w-renamed' }),
    ]);
    expect(picked).toEqual([{ sessionId: ID, name: 'w-renamed', mode: 'claude', pane: pane(ID) }]);
  });

  it('never adopts without provenance: a pane another instance launched on the shared socket', () => {
    expect(selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, [])).toEqual([]);
  });

  it('does not adopt what the user deleted, but does after a later recovery', () => {
    expect(selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, [ev('created'), ev('deleted')])).toEqual([]);
    expect(
      selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, [ev('created'), ev('deleted'), ev('recovered')])
    ).toHaveLength(1);
  });

  it('a pruned record (stale_cleaned) is exactly how an orphan arises, so it does not block', () => {
    const lifecycle = [ev('created'), ev('mux_died'), ev('stale_cleaned')];
    expect(selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, lifecycle)).toHaveLength(1);
  });

  it('leaves an ambiguous prefix alone', () => {
    const twin = 'aaaa1111-ffff-4000-8000-000000000002';
    expect(selectAdoptableOrphans(panesOf(pane(ID)), nobodyKnows, [ev('created'), ev('created', twin)])).toEqual([]);
  });

  it('skips dead panes, foreign names and sessions the board or the plan already holds', () => {
    const foreign: RemoteCodemanPane = { ...pane(ID), sessionName: 'codeman-disco1' };
    expect(selectAdoptableOrphans(panesOf(pane(ID, { dead: true })), nobodyKnows, [ev('created')])).toEqual([]);
    expect(selectAdoptableOrphans(panesOf(foreign), nobodyKnows, [ev('created')])).toEqual([]);
    expect(selectAdoptableOrphans(panesOf(pane(ID)), (id) => id === ID, [ev('created')])).toEqual([]);
  });

  it('a pane running anything but claude comes back as a shell', () => {
    const [picked] = selectAdoptableOrphans(panesOf(pane(ID, { command: 'bash' })), nobodyKnows, [ev('started')]);
    expect(picked.mode).toBe('shell');
  });
});

describe('orphanEntry', () => {
  it('rebuilds the remote block from the host config and the pane path, owned', () => {
    const entry = orphanEntry(HOST, { sessionId: ID, name: 'n', mode: 'claude', pane: pane(ID, { path: '/p' }) });
    expect(entry.state.remote).toEqual(
      expect.objectContaining({
        hostId: 'huff',
        host: 'huff.test',
        username: 'u',
        remotePath: '/p',
        owned: true,
        identityFile: '~/.ssh/k',
      })
    );
    expect(entry.workingDir).toBe('/p');
  });
});

describe('adoptRemoteOrphans', () => {
  beforeEach(() => {
    constructed.length = 0;
  });
  afterEach(() => {
    rebootRestoreRegistry.reset();
    vi.restoreAllMocks();
  });

  const deps = (panes: Map<string, RemoteCodemanPane> | undefined, lifecycle: LifecycleEntry[]) => ({
    readHosts: async () => [HOST],
    listPanes: vi.fn(async () => panes),
    readLifecycle: async () => lifecycle,
  });

  it('rebuilds an orphan through the shared path and logs it as adopted', async () => {
    const logSpy = vi.spyOn(getLifecycleLog(), 'log');
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const res = await adoptRemoteOrphans(ctx as never, deps(panesOf(pane(ID)), [ev('created', ID, { name: 'n' })]));

    expect(res).toEqual({ adopted: [ID], silentHosts: [] });
    expect(constructed[0]).toEqual(
      expect.objectContaining({
        id: ID,
        name: 'n',
        mode: 'claude',
        remote: expect.objectContaining({ host: 'huff.test' }),
      })
    );
    expect(ctx.sessions.has(ID)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'recovered', reason: 'orphan_adopted' }));
  });

  it('reports a silent host and builds nothing', async () => {
    const res = await adoptRemoteOrphans(createMockRouteContext() as never, deps(undefined, [ev('created')]));
    expect(res).toEqual({ adopted: [], silentHosts: ['Huff'] });
    expect(constructed).toEqual([]);
  });

  it('leaves a session the reboot plan still holds to the banner', async () => {
    rebootRestoreRegistry.set([
      { sessionId: ID, workingDir: '/p', mode: 'claude', resumeConversationId: 'c', state: { id: ID } as SessionState },
    ]);
    const res = await adoptRemoteOrphans(createMockRouteContext() as never, deps(panesOf(pane(ID)), [ev('created')]));
    expect(res.adopted).toEqual([]);
  });

  it('asks only the hosts it was given', async () => {
    const d = deps(panesOf(pane(ID)), [ev('created')]);
    await adoptRemoteOrphans(createMockRouteContext() as never, d, ['other-host']);
    expect(d.listPanes).not.toHaveBeenCalled();
  });

  it('is single-flighted: a second trigger joins the running pass', async () => {
    // Created up front: the pass reaches `listPanes` only after reading the hosts.
    let answer!: (p: Map<string, RemoteCodemanPane>) => void;
    const listing = new Promise<Map<string, RemoteCodemanPane>>((r) => (answer = r));
    const d = { ...deps(undefined, [ev('created')]), listPanes: vi.fn(() => listing) };
    const ctx = createMockRouteContext();
    const first = adoptRemoteOrphans(ctx as never, d);
    const second = adoptRemoteOrphans(ctx as never, d);
    expect(second).toBe(first);
    answer(panesOf(pane(ID)));
    expect(await first).toEqual(await second);
    expect(d.listPanes).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveLength(1);
  });
});

describe('boot: reattach and orphan pass share one listing per host', () => {
  afterEach(() => {
    rebootRestoreRegistry.reset();
    vi.restoreAllMocks();
  });

  it('asks a host once for both passes', async () => {
    const planned = 'bbbb2222-0000-4000-8000-000000000003';
    rebootRestoreRegistry.set([
      {
        sessionId: planned,
        workingDir: '/p',
        mode: 'claude',
        resumeConversationId: 'c',
        state: {
          id: planned,
          pid: 1,
          status: 'idle',
          workingDir: '/p',
          currentTaskId: null,
          createdAt: 1,
          mode: 'claude',
          remote: { hostId: 'huff', label: 'Huff', host: 'huff.test', username: 'u', remotePath: '/p', owned: true },
        } as SessionState,
      },
    ]);
    const listPanes = vi.fn(async () => panesOf(pane(planned)));
    await runBootRemoteReattach(createMockRouteContext() as never, { readHosts: async () => [HOST], listPanes });
    expect(listPanes).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/remote-orphans/adopt', () => {
  it('runs the pass with the injected IO and returns its result', async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerRebootRestoreRoutes(app, createMockRouteContext() as never, {
      orphanDeps: {
        readHosts: async () => [HOST],
        listPanes: async () => panesOf(pane(ID)),
        readLifecycle: async () => [ev('created')],
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/remote-orphans/adopt', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ adopted: [ID], silentHosts: [] });
    await app.close();
  });
});

describe('wake invariant (wiring guard)', () => {
  it('the orphan pass never reaches the wake registry', () => {
    const src = readFileSync(join(__dirname, '..', 'src/web/remote-orphans.ts'), 'utf-8');
    expect(src).not.toMatch(/^import .*remote-wake/m);
    expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
  });
});
