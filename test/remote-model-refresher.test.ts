import { describe, expect, it, vi } from 'vitest';
import type { RemoteModelRefresherDeps } from '../src/web/remote-model-refresher.js';
import {
  REMOTE_MODEL_TAIL_BYTES,
  RemoteModelRefresher,
  type RemoteModelSession,
} from '../src/web/remote-model-refresher.js';
import type { SessionRemote } from '../src/types/session.js';

const remote = { host: 'hufflepuff', user: 'j' } as SessionRemote;
const tailOf = (model: string) => ({
  sessionId: 'conv-1',
  content: `${JSON.stringify({ type: 'assistant', message: { model } })}\n`,
});

function fakeSession(over: Partial<RemoteModelSession> = {}): RemoteModelSession {
  return {
    id: 'sess-1',
    mode: 'claude',
    remote,
    claudeSessionId: 'conv-1',
    noteReportedModel: vi.fn(() => true),
    adoptClaudeSessionId: vi.fn(),
    ...over,
  };
}

const persist = vi.fn();
const deps = (readTail: unknown) => ({ readTail, persist }) as unknown as RemoteModelRefresherDeps;

describe('RemoteModelRefresher', () => {
  it('adopts the conversation the pane writes now (after a /clear) and persists the session', async () => {
    persist.mockClear();
    const readTail = vi.fn(async () => ({ ...tailOf('claude-opus-5-5'), sessionId: 'conv-2' }));
    const session = fakeSession();
    await new RemoteModelRefresher(deps(readTail)).refresh(session);

    expect(session.adoptClaudeSessionId).toHaveBeenCalledWith('conv-2');
    expect(persist).toHaveBeenCalledWith('sess-1');
    expect(session.noteReportedModel).toHaveBeenCalledWith('transcript', 'Opus 5.5');
  });

  it('keeps the conversation when the read found one it asked for', async () => {
    persist.mockClear();
    const session = fakeSession();
    await new RemoteModelRefresher(deps(vi.fn(async () => tailOf('claude-sonnet-5')))).refresh(session);

    expect(session.adoptClaudeSessionId).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("records a remote claude's newest model as a transcript report", async () => {
    const readTail = vi.fn(async () => tailOf('claude-sonnet-5'));
    const session = fakeSession();
    await new RemoteModelRefresher(deps(readTail)).refresh(session);

    expect(readTail).toHaveBeenCalledWith(remote, ['conv-1', 'sess-1'], REMOTE_MODEL_TAIL_BYTES, 'sess-1');
    expect(session.noteReportedModel).toHaveBeenCalledWith('transcript', 'Sonnet 5');
  });

  it('falls back to the session id before claude has named its conversation', async () => {
    const readTail = vi.fn(async () => null);
    const session = fakeSession({ claudeSessionId: null });
    await new RemoteModelRefresher(deps(readTail)).refresh(session);

    expect(readTail).toHaveBeenCalledWith(remote, ['sess-1', 'sess-1'], REMOTE_MODEL_TAIL_BYTES, 'sess-1');
    expect(session.noteReportedModel).not.toHaveBeenCalled();
  });

  it('never reads for a local session or another CLI', async () => {
    const readTail = vi.fn(async () => tailOf('claude-sonnet-5'));
    const refresher = new RemoteModelRefresher(deps(readTail));
    await refresher.refresh(fakeSession({ remote: undefined }));
    await refresher.refresh(fakeSession({ mode: 'opencode' }));
    expect(readTail).not.toHaveBeenCalled();
  });

  it('keeps one read per session in flight and swallows a failed one', async () => {
    let release!: () => void;
    const readTail = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          release = () => reject(new Error('host unreachable'));
        })
    );
    const session = fakeSession();
    const refresher = new RemoteModelRefresher(deps(readTail));

    const first = refresher.refresh(session);
    await refresher.refresh(session);
    expect(readTail).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBeUndefined();
    expect(session.noteReportedModel).not.toHaveBeenCalled();

    // Done (even failed), the next turn end reads again.
    readTail.mockImplementationOnce(async () => tailOf('claude-opus-5-5') as never);
    await refresher.refresh(session);
    expect(session.noteReportedModel).toHaveBeenCalledWith('transcript', 'Opus 5.5');
  });
});
