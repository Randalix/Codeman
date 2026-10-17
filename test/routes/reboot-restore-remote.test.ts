/**
 * Reboot-restore route: remote (SSH) entries.
 *
 * A host reboot takes only the LOCAL ssh wrapper of a remote session; the agent
 * keeps running in the remote host's own tmux. The route asks the host whether
 * that pane survived (an injected probe here), then rebuilds the session WITH its
 * `remote`, so the launch is `ssh … new-session -A` and attaches to it.
 *
 * `Session` is mocked like in reboot-restore-rebuild-failure.test.ts, so the route
 * runs its whole construction path and the test can read what it was given.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

/** Every config the mocked `Session` was constructed with. */
const constructed: Array<{ id: string; remote?: unknown; workingDir: string }> = [];

vi.mock('../../src/session.js', () => ({
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

const { registerRebootRestoreRoutes } = await import('../../src/web/routes/reboot-restore-routes.js');
const { rebootRestoreRegistry } = await import('../../src/web/reboot-restore-registry.js');
const { installRouteErrorHandler } = await import('../../src/web/route-error-handler.js');
const { createMockRouteContext } = await import('../mocks/index.js');
type RebootRestoreEntry = import('../../src/reboot-restore.js').RebootRestoreEntry;
type SessionState = import('../../src/types.js').SessionState;
type SessionRemote = import('../../src/types.js').SessionRemote;

/** A path that exists only "on the remote host": absent here on purpose. */
const REMOTE_PATH = '/nonexistent-on-this-host/codeman-reboot-remote';

function remoteFor(host: string): SessionRemote {
  return { hostId: host, label: `Label ${host}`, host, username: 'u', remotePath: REMOTE_PATH, owned: true };
}

function remoteEntry(
  sessionId: string,
  opts: { host?: string; mode?: string; pid?: number | null } = {}
): RebootRestoreEntry {
  const mode = opts.mode ?? 'claude';
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: REMOTE_PATH,
    mode,
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: opts.pid === undefined ? 4242 : opts.pid,
      status: 'idle',
      workingDir: REMOTE_PATH,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode,
      remote: remoteFor(opts.host ?? 'huff.test'),
    } as SessionState,
  };
}

async function createHarness(
  ctx: ReturnType<typeof createMockRouteContext>,
  remoteSessionAlive: (remote: SessionRemote, name: string) => Promise<boolean | undefined>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx as never, { remoteSessionAlive });
  app.addHook('preSerialization', (req, _reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api') || payload === null || typeof payload !== 'object') return done(null, payload);
    if ('success' in (payload as object)) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

async function restoreAll(app: FastifyInstance) {
  return (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
}

beforeEach(() => {
  constructed.length = 0;
});

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.clearAllMocks();
});

describe('remote entries on the reboot banner', () => {
  it('names the host, so the banner can say where a session lives', async () => {
    rebootRestoreRegistry.set([remoteEntry('r')]);
    const app = await createHarness(createMockRouteContext({ workspaceHooksEnabled: false }), async () => true);
    const body = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(body.sessions[0].remote).toBe('Label huff.test');
    await app.close();
  });

  it('rebuilds a session whose remote pane survived, with its remote and without a local path check', async () => {
    rebootRestoreRegistry.set([remoteEntry('r')]);
    const probe = vi.fn(async () => true);
    const app = await createHarness(createMockRouteContext({ workspaceHooksEnabled: true }), probe);

    const res = await restoreAll(app);
    expect(res.skipped).toEqual([]);
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['r']);
    // The probe asks for THIS session's remote tmux name.
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ host: 'huff.test' }), 'codeman-ssh-r');
    // Without `remote` the launch would be a LOCAL claude in a path that is not here.
    expect(constructed[0].remote).toEqual(expect.objectContaining({ host: 'huff.test', remotePath: REMOTE_PATH }));
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    await app.close();
  });

  it('keeps a sleeping host on offer, and asks it only once per click', async () => {
    rebootRestoreRegistry.set([remoteEntry('a'), remoteEntry('b'), remoteEntry('c', { host: 'other.test' })]);
    const probe = vi.fn(async (remote: SessionRemote) => (remote.host === 'huff.test' ? undefined : true));
    const app = await createHarness(createMockRouteContext({ workspaceHooksEnabled: false }), probe);

    const res = await restoreAll(app);
    expect(res.skipped).toEqual([
      { sessionId: 'a', reason: 'host-unreachable' },
      { sessionId: 'b', reason: 'host-unreachable' },
    ]);
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['c']);
    // One timeout for the sleeping host, not one per session on it.
    expect(probe.mock.calls.filter(([remote]) => remote.host === 'huff.test')).toHaveLength(1);
    expect(constructed.map((c) => c.id)).toEqual(['c']);
    // Wake the host, click again.
    expect(
      rebootRestoreRegistry
        .list(() => true)
        .map((e) => e.sessionId)
        .sort()
    ).toEqual(['a', 'b']);
    await app.close();
  });

  it('spends the offer for a gone remote pane it cannot resume, and resumes a claude one', async () => {
    rebootRestoreRegistry.set([remoteEntry('sh', { mode: 'shell' }), remoteEntry('cl')]);
    const app = await createHarness(createMockRouteContext({ workspaceHooksEnabled: false }), async () => false);

    const res = await restoreAll(app);
    expect(res.skipped).toEqual([{ sessionId: 'sh', reason: 'remote-session-gone' }]);
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['cl']);
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    await app.close();
  });

  it('treats a probe that throws as an unreachable host', async () => {
    rebootRestoreRegistry.set([remoteEntry('r')]);
    const app = await createHarness(createMockRouteContext({ workspaceHooksEnabled: false }), async () => {
      throw new Error('ssh exploded');
    });
    const res = await restoreAll(app);
    expect(res.skipped).toEqual([{ sessionId: 'r', reason: 'host-unreachable' }]);
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['r']);
    await app.close();
  });
});

describe('wake invariant (wiring guard)', () => {
  it('the reboot restore path never reaches the wake registry', () => {
    for (const file of [
      'src/web/routes/reboot-restore-routes.ts',
      'src/web/reboot-restore-rebuild.ts',
      'src/reboot-restore.ts',
    ]) {
      const src = readFileSync(join(__dirname, '..', '..', file), 'utf-8');
      expect(src).not.toMatch(/^import .*remote-wake/m);
      expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
    }
  });
});
