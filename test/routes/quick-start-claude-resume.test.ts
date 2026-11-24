/**
 * @fileoverview `resumeSessionId` on POST /api/quick-start — continue a claude conversation.
 *
 * New remote sessions are only made by quick-start (`POST /api/sessions` attaches to a
 * remote one, it does not launch one), so this is the only way to bring a remote claude
 * conversation back into a new session. A remote transcript lives on the host, which
 * this machine cannot check: the id is passed through and the remote command falls back
 * to a fresh conversation. A local id is checked here, because a local claude given an
 * unknown id prints "No conversation found" and exits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';
import { safeRmHomeTree } from '../mocks/index.js';
import { getDataDir } from '../../src/config/instance.js';
import { claudeProjectsDir } from '../../src/utils/claude-transcript.js';

vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const CONV = 'd5cfef48-103c-4f55-82a8-ba3f539903ad';

describe('quick-start resumeSessionId (claude)', () => {
  let harness: RouteTestHarness;
  const workingDir = join(homedir(), 'resume-test');
  const projectDir = join(claudeProjectsDir(), '-resume-test');

  beforeEach(async () => {
    for (const name of ['docker-hosts.json', 'docker-cases.json', 'remote-hosts.json', 'remote-cases.json']) {
      await rm(join(getDataDir(), name), { force: true });
    }
    await mkdir(workingDir, { recursive: true });
    harness = await createRouteTestHarness(registerSessionRoutes);
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness.app.close();
    safeRmHomeTree(CASES_DIR);
    safeRmHomeTree(workingDir);
    safeRmHomeTree(projectDir);
    vi.restoreAllMocks();
  });

  const quickStart = (payload: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/quick-start', payload });
  const lastSession = () => [...harness.ctx.sessions.values()].at(-1) as Session | undefined;

  it('passes a remote conversation through to the launch', async () => {
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'huff', label: 'Huff', host: '10.0.0.5', username: 'j' }])
    );
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([{ name: 'resume-test', type: 'remote', hostId: 'huff', remotePath: '/mnt/build/x' }])
    );
    const res = await quickStart({ caseName: 'resume-test', mode: 'claude', resumeSessionId: CONV });
    expect(res.json().success, res.body).not.toBe(false);
    const state = lastSession()!.toState();
    expect(state.remote?.hostId).toBe('huff');
    expect(state.resumeSessionId).toBe(CONV);
    expect(lastSession()!.claudeSessionId).toBe(CONV);
  });

  it('resumes a local conversation whose transcript is on this machine', async () => {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${CONV}.jsonl`), '{}\n');
    const res = await quickStart({ caseName: 'resume-test', mode: 'claude', resumeSessionId: CONV });
    expect(res.json().success, res.body).not.toBe(false);
    expect(lastSession()!.toState().resumeSessionId).toBe(CONV);
  });

  it('refuses a local conversation with no transcript here, creating nothing', async () => {
    const before = harness.ctx.sessions.size;
    const res = await quickStart({ caseName: 'resume-test', mode: 'claude', resumeSessionId: CONV });
    expect(res.json()).toMatchObject({ success: false });
    expect(res.body).toContain('No claude conversation');
    expect(harness.ctx.sessions.size).toBe(before);
  });

  it('refuses it for another CLI, whose resume id lives in its own config object', async () => {
    const before = harness.ctx.sessions.size;
    const res = await quickStart({ caseName: 'resume-test', mode: 'codex', resumeSessionId: CONV });
    expect(res.json()).toMatchObject({ success: false });
    expect(res.body).toContain('codexConfig.resumeSessionId');
    expect(harness.ctx.sessions.size).toBe(before);
  });

  it('rejects a value that is not an id', async () => {
    const res = await quickStart({ caseName: 'resume-test', mode: 'claude', resumeSessionId: '--yolo' });
    expect(res.statusCode).toBe(400);
  });
});
