/**
 * @fileoverview Downstream (Randalix fork): `codeman agent rm --safe` — the host check
 * script against real temp git repos, the evaluation of its facts, the composer reader,
 * and `POST /api/sessions/:id/safe-delete` (blocked, dry run, delete with archive).
 *
 * Port: none (Fastify inject; the host script runs locally under `sh`)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOCK_TTL_SECONDS,
  composerDraftText,
  evaluateHostFacts,
  parseHostCheck,
  readHostFacts,
  shortDraft,
  type HostFacts,
} from '../src/safe-delete.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { registerSessionRoutes, _resetPaneLivenessState } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { agentInbox } from '../src/web/agent-inbox.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../src/types.js';
import { createMockRouteContext } from './mocks/index.js';

const SID = 'safedel1-1111-4111-8111-111111111111';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      LC_ALL: 'C',
    },
  }).toString();

/** A repo with one commit pushed to a bare `origin`. */
function pushedRepo(): string {
  const bare = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', bare);
  const dir = join(root, 'work');
  git(root, 'init', '-q', '-b', 'main', dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'a');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeman-safe-delete-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('host check script (real git, local sh)', () => {
  it('clean and pushed: git green; untracked only a hint', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'new.txt'), 'n\n');
    const facts = await readHostFacts(dir);
    expect(facts).toMatchObject({ repo: true, dirty: 0, untracked: 1, branch: 'main', remotes: 1, ahead: 0 });
    const [gitCheck] = evaluateHostFacts(facts, SID);
    expect(gitCheck).toMatchObject({ key: 'git', ok: true, message: 'git sauber+gepusht', hint: '1 untracked' });
  });

  it('uncommitted tracked change and unpushed commits are red', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'b');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const [gitCheck] = evaluateHostFacts(await readHostFacts(dir), SID);
    expect(gitCheck.ok).toBe(false);
    expect(gitCheck.message).toBe('uncommittete Änderungen (1 Dateien); ungepushte Commits (1, Branch main)');
  });

  it('a feature branch whose HEAD is on some remote branch counts as pushed; detached HEAD too', async () => {
    const dir = pushedRepo();
    git(dir, 'checkout', '-q', '-b', 'feature');
    expect(evaluateHostFacts(await readHostFacts(dir), SID)[0].ok).toBe(true);
    git(dir, 'checkout', '-q', '--detach');
    const facts = await readHostFacts(dir);
    expect(facts?.branch).toBe('');
    expect(evaluateHostFacts(facts, SID)[0]).toMatchObject({ ok: true });
  });

  it('a repo without any remote is red; no repo and a missing dir are green', async () => {
    const dir = join(root, 'local');
    git(root, 'init', '-q', dir);
    writeFileSync(join(dir, 'x'), 'x');
    git(dir, 'add', 'x');
    git(dir, 'commit', '-q', '-m', 'x');
    expect(evaluateHostFacts(await readHostFacts(dir), SID)[0]).toMatchObject({
      ok: false,
      message: 'Repo ohne Remote, nichts gepusht',
    });
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(evaluateHostFacts(await readHostFacts(plain), SID)[0]).toMatchObject({ ok: true, message: 'kein Git-Repo' });
    expect(evaluateHostFacts(await readHostFacts(join(root, 'gone')), SID)[0]).toMatchObject({ ok: true });
  });

  it('a path with spaces and quotes reaches the script intact', async () => {
    const dir = join(root, "it's a dir");
    mkdirSync(dir);
    expect(await readHostFacts(dir)).toMatchObject({ noDir: false, repo: false });
  });

  it('agent lock: session= decides the holder; without it a fresh lock blocks, an old one does not', async () => {
    const dir = pushedRepo();
    const lock = join(dir, '.agent-lock');
    writeFileSync(lock, `agent=car-pickup\nsession=${SID.slice(0, 8)}\nsince=2026-11-25T11:36:41+01:00\n`);
    expect(evaluateHostFacts(await readHostFacts(dir), SID)[1]).toMatchObject({
      key: 'lock',
      ok: false,
      message: 'hält Sperre „car-pickup"',
    });
    expect(evaluateHostFacts(await readHostFacts(dir), 'otherses-2222-4222-8222-222222222222')[1].ok).toBe(true);
    writeFileSync(lock, 'agent=car-pickup\npid=1\n');
    expect(evaluateHostFacts(await readHostFacts(dir), SID)[1]).toMatchObject({ ok: false });
    const old = Date.now() / 1000 - AGENT_LOCK_TTL_SECONDS - 60;
    utimesSync(lock, old, old);
    expect(evaluateHostFacts(await readHostFacts(dir), SID)[1]).toMatchObject({
      ok: true,
      message: 'Sperre abgelaufen',
    });
  });

  it('a lock in the repo root counts for a session in a subdirectory', async () => {
    const dir = pushedRepo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, '.agent-lock'), 'agent=x\n');
    expect(evaluateHostFacts(await readHostFacts(join(dir, 'sub')), SID)[1].ok).toBe(false);
  });

  it('output that is not the script, or a failing runner, means: not checkable (both red)', async () => {
    expect(parseHostCheck('ssh: connect to host huff port 22: No route to host')).toBeNull();
    const facts = await readHostFacts('/x', undefined, async () => {
      throw new Error('timeout');
    });
    expect(facts).toBeNull();
    expect(evaluateHostFacts(null, SID).map((c) => c.ok)).toEqual([false, false]);
  });

  it('builds an ssh line with sh -c for a remote session', async () => {
    let seen = '';
    await readHostFacts(
      '/mnt/build/x',
      { hostId: 'h', label: 'h', host: 'huff', username: 'j', remotePath: '/mnt/build/x' } as never,
      async (command) => {
        seen = command;
        return '';
      }
    );
    expect(seen).toMatch(/^ssh -o BatchMode=yes .* j@huff 'sh -c /);
  });
});

describe('composer reader (claude)', () => {
  const claude = getCli('claude');
  const frame = '─'.repeat(40);
  it('reads a draft, an empty composer, a dimmed placeholder, and a multi-row draft', () => {
    expect(composerDraftText(`out\n${frame}\n❯ mach weiter mit EG und KG\n${frame}\n  ⏵⏵ bypass`, claude)).toBe(
      'mach weiter mit EG und KG'
    );
    expect(composerDraftText(`out\n${frame}\n❯ \n${frame}\n`, claude)).toBe('');
    expect(composerDraftText(`${frame}\n❯ \x1b[2mTry "fix lint"\x1b[22m\n${frame}\n`, claude)).toBe('');
    expect(composerDraftText(`${frame}\n❯ Neuer Auftrag\n  in deiner Mailbox\n${frame}\n`, claude)).toBe(
      'Neuer Auftrag in deiner Mailbox'
    );
  });
  it('null when there is no framed composer to read', () => {
    expect(composerDraftText('just output\n', claude)).toBeNull();
    expect(composerDraftText(`❯ text\n${frame}\n`, claude)).toBeNull();
  });
  it('shortDraft cuts long drafts to one line', () => {
    expect(shortDraft('a\nb')).toBe('a b');
    expect(shortDraft('x'.repeat(100)).length).toBe(60);
  });
});

describe('POST /api/sessions/:id/safe-delete', () => {
  let app: FastifyInstance;
  let ctx: ReturnType<typeof createMockRouteContext>;
  let screen: string;
  let session: Record<string, unknown>;

  beforeEach(async () => {
    agentInbox.resetForTests();
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext({ sessionId: SID });
    session = ctx.sessions.get(SID)! as unknown as Record<string, unknown>;
    const frame = '─'.repeat(20);
    screen = `done\n${frame}\n❯ \n${frame}\n`;
    Object.assign(session, {
      mode: 'claude',
      workingDir: pushedRepo(),
      hasDraft: () => false,
      backgroundWorkOnScreen: () => null,
      dialogOnScreen: () => false,
    });
    (ctx.mux as Record<string, unknown>).capturePaneText = vi.fn(() => screen);
    registerSessionRoutes(app, ctx as never);
    app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
      const p = payload as { success?: unknown; errorCode?: unknown } | null;
      if (!p || typeof p !== 'object') return done(null, payload);
      if (p.success === false) {
        if (reply.statusCode === 200 && typeof p.errorCode === 'string')
          reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
        return done(null, payload);
      }
      return done(null, p.success === true ? payload : { success: true, data: payload });
    });
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    agentInbox.resetForTests();
    _resetPaneLivenessState();
  });

  const call = async (body: Record<string, unknown> = {}) =>
    JSON.parse((await app.inject({ method: 'POST', url: `/api/sessions/${SID}/safe-delete`, payload: body })).body)
      .data;

  it('dry run: all green, nothing deleted', async () => {
    const data = await call({ dryRun: true });
    expect(data.deleted).toBe(false);
    expect(data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
  });

  it('blocks on unread mail, a draft, a running turn — and deletes nothing', async () => {
    agentInbox.post(SID, 'someone', 'Neuer Auftrag');
    screen = screen.replace('❯ ', '❯ mach weiter mit EG und KG');
    session.isWorking = true;
    const data = await call();
    expect(data.deleted).toBe(false);
    const red = Object.fromEntries(
      data.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { key: string; message: string }) => [c.key, c.message])
    );
    expect(red).toEqual({
      inbox: 'ungelesene Post (1)',
      composer: 'ungesendete Eingabe: mach weiter mit EG und KG',
      idle: 'Turn läuft',
    });
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
  });

  it('green: archives the pane tail, then deletes', async () => {
    const data = await call();
    expect(data.deleted).toBe(true);
    expect(data.archive).toMatch(/archive\/safedel1-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(readFileSync(data.archive, 'utf-8')).toContain('done');
    expect(ctx.cleanupSession).toHaveBeenCalledWith(SID, true, 'user_delete');
  });

  it('a draft typed but not readable on screen still blocks (keystroke latch)', async () => {
    screen = 'no composer here';
    session.hasDraft = () => true;
    const data = await call({ dryRun: true });
    expect(data.checks.find((c: { key: string }) => c.key === 'composer')).toMatchObject({ ok: false });
  });
});
