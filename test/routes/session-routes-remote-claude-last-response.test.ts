/**
 * @fileoverview `last-response` for a claude session in a remote-SSH case.
 *
 * The transcript of a remote claude worker is written into ~/.claude/projects on the
 * REMOTE host, so the local scan can never find it and `codeman agent read` printed
 * "nothing answered yet" for a worker that had answered. The ssh layer
 * (`src/remote-files.ts`) is mocked — a test never opens a connection — and the local
 * HOME holds a decoy transcript under the same id to prove it is not the one read.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { TEST_HOME_PREFIX } from '../mocks/test-helpers.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import type { SessionRemote } from '../../src/types/session.js';

vi.mock('../../src/remote-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-files.js')>();
  return { ...actual, remoteReadClaudeTranscriptTail: vi.fn() };
});

import { RemoteFileAccessError, remoteReadClaudeTranscriptTail } from '../../src/remote-files.js';

const mockedReadTail = vi.mocked(remoteReadClaudeTranscriptTail);

const CONVERSATION_ID = '30d8d84e-b3fb-40ef-8ca7-f8eb722a3366';
const remote: SessionRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.0.2.10',
  username: 'j',
  remotePath: '/mnt/work/case',
};

const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
const user = (text: string) => ({
  type: 'user',
  timestamp: '2026-10-11T15:00:00Z',
  message: { content: [{ type: 'text', text }] },
});
const assistant = (text: string, timestamp: string) => ({
  type: 'assistant',
  timestamp,
  message: { content: [{ type: 'text', text }] },
});

describe('GET /api/sessions/:id/last-response — remote claude session', () => {
  let harness: RouteTestHarness;
  let testHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    // Named like test/setup.ts's HOME: the shared harness refuses any other (assertSandboxedHome).
    testHome = mkdtempSync(join(tmpdir(), `${TEST_HOME_PREFIX}remote-rv-`));
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
    harness = await createRouteTestHarness(registerSessionRoutes);
    const session = harness.ctx._session as typeof harness.ctx._session & { claudeSessionId?: string };
    session.mode = 'claude';
    session.claudeSessionId = CONVERSATION_ID;
    session.workingDir = remote.remotePath;
    session.remote = { ...remote };
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    await harness.app.close();
    vi.clearAllMocks();
  });

  const get = async (context?: string) => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/last-response${context ? `?context=${context}` : ''}`,
    });
    return { status: res.statusCode, data: JSON.parse(res.body).data ?? JSON.parse(res.body) };
  };

  it('reads the transcript on the remote host, not the local HOME', async () => {
    // A local file with the same id must not be what answers.
    const localDir = join(testHome, '.claude', 'projects', '-decoy');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, `${CONVERSATION_ID}.jsonl`),
      jsonl([user('q'), assistant('LOCAL DECOY', '2026-10-11T14:00:00Z')])
    );
    mockedReadTail.mockResolvedValue({
      sessionId: CONVERSATION_ID,
      content: jsonl([user('ping'), assistant('PONG4711', '2026-10-11T15:00:01Z')]),
    });

    const { status, data } = await get();

    expect(status).toBe(200);
    expect(data).toEqual({ text: 'PONG4711', timestamp: '2026-10-11T15:00:01Z' });
    expect(mockedReadTail).toHaveBeenCalledTimes(1);
    const [calledRemote, ids, maxBytes] = mockedReadTail.mock.calls[0];
    expect(calledRemote).toMatchObject({ hostId: 'hufflepuff', host: '192.0.2.10' });
    expect(ids).toEqual([CONVERSATION_ID, harness.ctx._sessionId]);
    expect(maxBytes).toBeGreaterThan(0);
  });

  it("asks for the session's remote pane and keeps a known conversation", async () => {
    mockedReadTail.mockResolvedValue({ sessionId: CONVERSATION_ID, content: jsonl([user('q')]) });

    await get();

    expect(mockedReadTail.mock.calls[0][3]).toEqual({
      socket: 'codeman-remote',
      sessionName: `codeman-ssh-${harness.ctx._sessionId.slice(0, 8)}`,
    });
    expect(harness.ctx._session.claudeSessionId).toBe(CONVERSATION_ID);
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });

  it('adopts the conversation the remote claude writes now (after a /clear) and persists it', async () => {
    const cleared = '07e259af-d4d2-4ac3-8a7e-95972e3547df';
    mockedReadTail.mockResolvedValue({
      sessionId: cleared,
      content: jsonl([user('after clear'), assistant('NEW ONE', '2026-10-11T15:00:05Z')]),
    });

    const { data } = await get();

    expect(data.text).toBe('NEW ONE');
    expect(harness.ctx._session.claudeSessionId).toBe(cleared);
    expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(harness.ctx._session);
  });

  it('a tail cut mid-line skips the broken first row instead of failing', async () => {
    mockedReadTail.mockResolvedValue({
      sessionId: CONVERSATION_ID,
      content: 'xt":"cut off"}]}}\n' + jsonl([user('again'), assistant('second answer', '2026-10-11T15:00:02Z')]),
    });

    const { data } = await get('turn');

    expect(data.text).toBe('second answer');
    expect(data.messages.map((m: { text: string }) => m.text)).toEqual(['second answer']);
  });

  it('no transcript on the remote host yet → empty answer, no reason', async () => {
    mockedReadTail.mockResolvedValue(null);

    const { status, data } = await get();

    expect(status).toBe(200);
    expect(data).toEqual({ text: '', timestamp: '' });
  });

  it('an unreachable host says so instead of "nothing answered yet"', async () => {
    mockedReadTail.mockRejectedValue(new RemoteFileAccessError('remote host Hufflepuff unreachable: timed out'));

    const { status, data } = await get('full');

    expect(status).toBe(200);
    expect(data).toEqual({
      text: '',
      timestamp: '',
      messages: [],
      unavailable: 'remote host Hufflepuff unreachable: timed out',
    });
  });

  it('a local claude session never touches ssh', async () => {
    harness.ctx._session.remote = undefined;

    const { data } = await get();

    expect(data).toEqual({ text: '', timestamp: '' });
    expect(mockedReadTail).not.toHaveBeenCalled();
  });
});
