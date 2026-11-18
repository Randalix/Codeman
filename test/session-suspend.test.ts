/**
 * @fileoverview Session suspend (session-suspend.ts): stop an idle session's CLI to
 * free memory, keep the session, resume the same conversation on the next input.
 *
 * Pinned here:
 *  1. Only an idle LOCAL claude session is suspendable; everything else is refused
 *     with a reason, and nothing is stopped.
 *  2. The session is marked suspended BEFORE the stop (the pane watcher's exit read
 *     must meet a suspended session), and unmarked again when the stop fails.
 *  3. Input while suspended is held, starts ONE resume, and is written only after
 *     the composer shows, in arrival order. Input that arrives during the resume is
 *     held too, so it cannot overtake.
 *  4. A failed relaunch keeps the session suspended and the held input.
 *  5. The buffer is capped; the oldest chunk goes first, an oversize chunk is dropped.
 *  6. The clean-exit sweep never closes a suspended session.
 *
 * Port: none (pure, fake deps)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUSPEND_INPUT_BUFFER_BYTES,
  SessionSuspendRegistry,
  attachSuspendRegistry,
  paneShowsComposer,
  suspendRefusal,
  suspendRegistryOf,
  type SessionSuspendDeps,
  type SuspendableSession,
} from '../src/session-suspend.js';
import { shouldCloseCleanlyExitedSession } from '../src/pane-exit-sweep.js';
import { Session } from '../src/session.js';

const COMPOSER = 'previous answer\n\n────\n❯ \n────\n  Opus  ctx:14%\n';

class FakeSession implements SuspendableSession {
  id = '11111111-2222-3333-4444-555555555555';
  mode = 'claude';
  status = 'idle';
  isWorking = false;
  remote: SuspendableSession['remote'] = undefined;
  docker: unknown = undefined;
  adopt: unknown = undefined;
  muxName: string | null = 'codeman-11111111';
  suspendedAt: number | null = null;
  restartResult = true;
  restarts = 0;
  written: string[] = [];
  events: string[] = [];
  get suspended(): boolean {
    return this.suspendedAt !== null;
  }
  setSuspended(at: number | null): void {
    this.suspendedAt = at;
    this.events.push(at === null ? 'unmark' : 'mark');
  }
  async restartCli(): Promise<boolean> {
    this.restarts += 1;
    this.events.push('restart');
    return this.restartResult;
  }
  async writeViaMux(data: string): Promise<boolean> {
    this.written.push(`mux:${data}`);
    return true;
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
}

function deps(
  session: FakeSession,
  overrides: Partial<SessionSuspendDeps> = {}
): SessionSuspendDeps & { persisted: number; logs: string[]; screens: (string | null)[] } {
  let clock = 1_000;
  const screens: (string | null)[] = [];
  const out = {
    persisted: 0,
    logs: [] as string[],
    screens,
    stopPane: async () => {
      session.events.push(`stop(suspended=${session.suspended})`);
      return true;
    },
    capturePane: () => (screens.length > 1 ? screens.shift()! : (screens[0] ?? COMPOSER)),
    persist: () => {
      out.persisted += 1;
    },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (m: string) => out.logs.push(m),
    readyTimeoutMs: 2_000,
    readyPollMs: 100,
    ...overrides,
  };
  return out;
}

describe('background work blocks a suspend (Ark0N, #836)', () => {
  // The real Session reader over the registry's claude patterns, on a fake pane.
  const real = (screen: string) =>
    new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux: { isAvailable: () => true, capturePaneText: () => screen } as never,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
  const footer = (row: string) => `answer\n╭────╮\n│ ❯  │\n╰────╯\n  ~/x [main] Opus ctx: 11%\n  ${row}\n`;
  const MONITOR = footer('⏵⏵ bypass permissions on · 1 monitor · ← for agents');
  const SHELLS = footer('⏵⏵ bypass permissions on · 2 shells · ← for agents');
  const WORKFLOW = [
    '⏺ The research is running now.',
    '✻ Waiting for 1 dynamic workflow to finish',
    '────',
    '❯ ',
    '────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '',
  ].join('\n');
  const PLAIN = footer('⏵⏵ bypass permissions on (shift+tab to cycle)');

  it('Session.backgroundWorkOnScreen reads the chip and the waiting row', () => {
    const s = real('');
    expect(s.backgroundWorkOnScreen(MONITOR)).toBe('1 monitor');
    expect(s.backgroundWorkOnScreen(SHELLS)).toBe('2 shells');
    expect(s.backgroundWorkOnScreen(WORKFLOW)).toBe('workers it is waiting for');
    expect(s.backgroundWorkOnScreen(PLAIN)).toBeNull();
  });

  it('refuses with background-work, read fresh off the pane, and stops nothing', async () => {
    const s = new FakeSession();
    const reader = real('');
    Object.assign(s, { backgroundWorkOnScreen: (t: string) => reader.backgroundWorkOnScreen(t) });
    const d = deps(s);
    d.screens.push(MONITOR);
    const r = new SessionSuspendRegistry(d);
    const result = await r.suspend(s);
    expect(result).toMatchObject({ ok: false, reason: 'background-work' });
    expect(!result.ok && result.message).toContain('1 monitor');
    expect(s.events).toEqual([]);
    expect(s.suspended).toBe(false);
  });

  it('a fresh screen without work wins over a stale cached label', async () => {
    const s = new FakeSession();
    const reader = real('');
    Object.assign(s, {
      watching: '1 monitor',
      backgroundWorkOnScreen: (t: string) => reader.backgroundWorkOnScreen(t),
    });
    const d = deps(s);
    d.screens.push(PLAIN);
    expect((await new SessionSuspendRegistry(d).suspend(s)).ok).toBe(true);
  });

  it('an unreadable pane falls back to the cached label', async () => {
    const s = new FakeSession();
    Object.assign(s, { watching: '1 shell', backgroundWorkOnScreen: () => null });
    const d = deps(s, { capturePane: () => null });
    expect(await new SessionSuspendRegistry(d).suspend(s)).toMatchObject({ ok: false, reason: 'background-work' });
  });
});

describe('suspendRefusal', () => {
  it('accepts an idle local claude session', () => {
    expect(suspendRefusal(new FakeSession())).toBeNull();
  });

  it('accepts an owned remote claude session', () => {
    const s = new FakeSession();
    s.remote = { owned: true };
    expect(suspendRefusal(s)).toBeNull();
    s.remote = {}; // pre-`owned` records count as owned
    expect(suspendRefusal(s)).toBeNull();
  });

  it.each([
    ['remote-not-owned', (s: FakeSession) => (s.remote = { owned: false })],
    ['remote-override', (s: FakeSession) => (s.remote = { commands: { claude: 'my-claude' } })],
    ['docker', (s: FakeSession) => (s.docker = { container: 'x' })],
    ['adopted', (s: FakeSession) => (s.adopt = { pane: '%1' })],
    ['unsupported-mode', (s: FakeSession) => (s.mode = 'opencode')],
    ['no-mux', (s: FakeSession) => (s.muxName = null)],
    ['busy', (s: FakeSession) => (s.isWorking = true)],
    ['busy', (s: FakeSession) => (s.status = 'busy')],
    ['already-suspended', (s: FakeSession) => (s.suspendedAt = 5)],
  ])('refuses %s', (reason, mutate) => {
    const s = new FakeSession();
    mutate(s);
    expect(suspendRefusal(s)?.reason).toBe(reason);
  });
});

describe('paneShowsComposer', () => {
  it('needs a ❯ row among the last rows', () => {
    expect(paneShowsComposer(COMPOSER)).toBe(true);
    expect(paneShowsComposer(null)).toBe(false);
    expect(paneShowsComposer('Resuming conversation…\n')).toBe(false);
  });

  it('ignores a ❯ far up in the scrolled-back conversation', () => {
    const old = ['❯ an old prompt', ...Array.from({ length: 12 }, (_, i) => `answer line ${i}`)].join('\n');
    expect(paneShowsComposer(old)).toBe(false);
  });
});

describe('SessionSuspendRegistry.suspend', () => {
  it('marks before the stop, persists, and leaves the session suspended', async () => {
    const s = new FakeSession();
    const d = deps(s);
    const reg = new SessionSuspendRegistry(d);
    expect(await reg.suspend(s)).toEqual({ ok: true });
    expect(s.events).toEqual(['mark', 'stop(suspended=true)']);
    expect(s.suspended).toBe(true);
    expect(d.persisted).toBe(1);
    expect(reg.isHolding(s)).toBe(true);
  });

  it('refuses without stopping anything', async () => {
    const s = new FakeSession();
    s.isWorking = true;
    const reg = new SessionSuspendRegistry(deps(s));
    expect(await reg.suspend(s)).toMatchObject({ ok: false, reason: 'busy' });
    expect(s.events).toEqual([]);
  });

  it('unmarks again when the stop fails', async () => {
    const s = new FakeSession();
    const reg = new SessionSuspendRegistry(deps(s, { stopPane: async () => false }));
    expect(await reg.suspend(s)).toMatchObject({ ok: false, reason: 'stop-failed' });
    expect(s.suspended).toBe(false);
    expect(s.events).toEqual(['mark', 'unmark']);
  });
});

describe('SessionSuspendRegistry: input wakes the session', () => {
  it('holds input, resumes once, writes after the composer, in order', async () => {
    const s = new FakeSession();
    const d = deps(s);
    const reg = new SessionSuspendRegistry(d);
    await reg.suspend(s);
    d.screens.push('Resuming…', COMPOSER, COMPOSER);

    expect(reg.handleInput(s, 'h')).toBe('buffered');
    expect(reg.handleInput(s, 'i')).toBe('buffered');
    const run = reg.resume(s); // joins the resume handleInput started
    expect(reg.handleInput(s, '\r')).toBe('buffered');
    expect(s.written).toEqual([]);
    expect(await run).toBe(true);

    expect(s.restarts).toBe(1);
    expect(s.written).toEqual(['h', 'i', '\r']);
    expect(s.suspended).toBe(false);
    expect(reg.isHolding(s)).toBe(false);
  });

  it('keystrokes go back raw, so a lone space survives; a plain prompt goes through the mux', async () => {
    // Live 2026-11-18: typed in the browser, "Reply with exactly" arrived as
    // "Replywithexactly" because each held keystroke went through writeViaMux, which
    // trims whitespace.
    const s = new FakeSession();
    const d = deps(s);
    const reg = new SessionSuspendRegistry(d);
    await reg.suspend(s);
    for (const k of ['a', ' ', 'b', '\r']) reg.handleInput(s, k);
    reg.handleInput(s, 'next prompt\r', 'mux');
    expect(await reg.resume(s)).toBe(true);
    expect(s.written).toEqual(['a', ' ', 'b', '\r', 'mux:next prompt\r']);
  });

  it('delivers after the timeout when the composer never shows', async () => {
    const s = new FakeSession();
    const d = deps(s);
    const reg = new SessionSuspendRegistry(d);
    await reg.suspend(s);
    d.screens.push('loading', 'loading');
    reg.handleInput(s, 'go\r');
    expect(await reg.resume(s)).toBe(true);
    expect(s.written).toEqual(['go\r']);
    expect(d.logs.some((l) => l.includes('composer not seen'))).toBe(true);
  });

  it('keeps the session suspended and the input when the relaunch fails', async () => {
    const s = new FakeSession();
    s.restartResult = false;
    const reg = new SessionSuspendRegistry(deps(s));
    await reg.suspend(s);
    reg.handleInput(s, 'x');
    expect(await reg.resume(s)).toBe(false);
    expect(s.suspended).toBe(true);
    expect(s.written).toEqual([]);
    // A later successful resume still delivers it.
    s.restartResult = true;
    expect(await reg.resume(s)).toBe(true);
    expect(s.written).toEqual(['x']);
  });

  it('remote: wakes the host before the relaunch, and lifts the reconnect lock after it', async () => {
    const s = new FakeSession();
    s.remote = { owned: true };
    const order: string[] = [];
    const d = deps(s, {
      wakeHostForResume: async () => {
        order.push(`wake(restarts=${s.restarts})`);
        return true;
      },
      onResumed: () => order.push(`resumed(suspended=${s.suspended})`),
    });
    const reg = new SessionSuspendRegistry(d);
    await reg.suspend(s);
    reg.handleInput(s, 'x');
    expect(await reg.resume(s)).toBe(true);
    expect(order).toEqual(['wake(restarts=0)', 'resumed(suspended=false)']);
    expect(s.written).toEqual(['x']);
  });

  it('remote: a host that stays unreachable keeps the session suspended and the input held', async () => {
    const s = new FakeSession();
    s.remote = { owned: true };
    let awake = false;
    const reg = new SessionSuspendRegistry(deps(s, { wakeHostForResume: async () => awake }));
    await reg.suspend(s);
    reg.handleInput(s, 'x');
    expect(await reg.resume(s)).toBe(false);
    expect(s.restarts).toBe(0);
    expect(s.suspended).toBe(true);
    awake = true;
    expect(await reg.resume(s)).toBe(true);
    expect(s.written).toEqual(['x']);
  });

  it('a local session never asks for a host wake', async () => {
    const s = new FakeSession();
    let asked = 0;
    const reg = new SessionSuspendRegistry(
      deps(s, {
        wakeHostForResume: async () => {
          asked++;
          return false;
        },
      })
    );
    await reg.suspend(s);
    expect(await reg.resume(s)).toBe(true);
    expect(asked).toBe(0);
  });

  it('resume of a running session is a no-op', async () => {
    const s = new FakeSession();
    const reg = new SessionSuspendRegistry(deps(s));
    expect(await reg.resume(s)).toBe(true);
    expect(s.restarts).toBe(0);
  });

  it('caps the buffer: oldest goes first, an oversize chunk is dropped', async () => {
    const s = new FakeSession();
    s.restartResult = false;
    const reg = new SessionSuspendRegistry(deps(s));
    await reg.suspend(s);
    expect(reg.handleInput(s, 'x'.repeat(SUSPEND_INPUT_BUFFER_BYTES + 1))).toBe('dropped');
    const half = 'a'.repeat(SUSPEND_INPUT_BUFFER_BYTES / 2);
    reg.handleInput(s, 'first');
    reg.handleInput(s, half);
    reg.handleInput(s, half);
    await reg.resume(s);
    s.restartResult = true;
    await reg.resume(s);
    expect(s.written).toEqual([half, half]);
  });

  it('forget drops held input', async () => {
    const s = new FakeSession();
    s.restartResult = false;
    const reg = new SessionSuspendRegistry(deps(s));
    await reg.suspend(s);
    reg.handleInput(s, 'x');
    await reg.resume(s);
    reg.forget(s.id);
    s.restartResult = true;
    await reg.resume(s);
    expect(s.written).toEqual([]);
  });
});

describe('ctx wiring', () => {
  it('hangs the registry on the shared ctx', () => {
    const ctx = {};
    expect(suspendRegistryOf(ctx)).toBeUndefined();
    const reg = new SessionSuspendRegistry(deps(new FakeSession()));
    attachSuspendRegistry(ctx, reg);
    expect(suspendRegistryOf(ctx)).toBe(reg);
  });
});

describe('clean-exit sweep', () => {
  it('never closes a suspended session, even on a clean 0 exit', () => {
    const base = {
      paneExit: { status: 0, at: 100_000 },
      confirmingReads: 5,
      paneLifecycleInFlight: false,
      closing: false,
      paneStartedAt: 1,
    };
    expect(shouldCloseCleanlyExitedSession(base)).toBe(true);
    expect(shouldCloseCleanlyExitedSession({ ...base, suspended: true })).toBe(false);
  });
});

describe('suspend wiring guard', () => {
  // A remote resume wakes the host (`wakeHostForResume`), which is allowed only on a
  // user's request. The registry is reachable from the HTTP and WebSocket input routes
  // only; the server holds it for cleanup (`forget`). Boot recovery, the reconnect
  // watcher, the nudger or a timer must never resume a suspended session.
  it('only the routes reach the registry, and the server only forgets', () => {
    const SRC = join(__dirname, '..', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
      );
    const users = walk(SRC)
      .filter((f) => /suspendRegistryOf\s*\(|new SessionSuspendRegistry\s*\(/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f))
      .sort();
    expect(users).toEqual(
      [
        'session-suspend.ts', // the definition
        join('web', 'routes', 'inbox-routes.ts'), // a post resumes the receiver (request only)
        join('web', 'routes', 'session-routes.ts'),
        join('web', 'routes', 'ws-routes.ts'),
        join('web', 'server.ts'),
      ].sort()
    );
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    expect(server).not.toMatch(/sessionSuspend\??\.(resume|handleInput|suspend)\s*\(/);
  });
});
