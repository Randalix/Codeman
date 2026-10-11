/**
 * @fileoverview Keeps a remote claude session's reported model current.
 *
 * A local claude reports its model through the statusline exporter on every render. A
 * remote one has no exporter reaching back, so the server only knew the `--model` it was
 * started with, and an in-session `/model` went unseen (five workers switched to Sonnet
 * still listed as `opus`). At each turn end this reads the end of the worker's transcript
 * on its host, once, and records the model of the newest answer as a `transcript` report.
 *
 * One ssh per turn end, never a timer: the host is awake anyway when a turn just ended,
 * and nothing here runs while a worker sits idle, so a sleeping host stays asleep (the
 * wake invariant: reads never wake). At most one read per session is in flight; a turn
 * end during a read is skipped, the next one catches up. A failed read changes nothing.
 *
 * Tests: `test/remote-model-refresher.test.ts`.
 *
 * @module web/remote-model-refresher
 */

import type { SessionRemote } from '../types/session.js';
import { friendlyClaudeModel, lastAssistantModel } from '../claude-transcript-model.js';

/** Enough tail for the newest assistant record even behind a long tool result. */
export const REMOTE_MODEL_TAIL_BYTES = 256 * 1024;

/** The slice of a session this needs. */
export interface RemoteModelSession {
  id: string;
  mode: string;
  remote: SessionRemote | undefined;
  claudeSessionId: string | null;
  noteReportedModel(source: 'transcript', raw: unknown): boolean;
}

export interface RemoteModelRefresherDeps {
  /** `remoteReadClaudeTranscriptTail`: the tail of the first transcript found, or null. */
  readTail(
    remote: SessionRemote,
    ids: readonly string[],
    maxBytes: number
  ): Promise<{ sessionId: string; content: string } | null>;
}

export class RemoteModelRefresher {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: RemoteModelRefresherDeps) {}

  /**
   * Read the model off a remote claude session's transcript. A no-op for a local
   * session or another CLI. Resolves once done; never rejects.
   */
  async refresh(session: RemoteModelSession): Promise<void> {
    const remote = session.remote;
    if (!remote || session.mode !== 'claude' || this.inFlight.has(session.id)) return;
    this.inFlight.add(session.id);
    try {
      const ids = [session.claudeSessionId || session.id, session.id];
      const tail = await this.deps.readTail(remote, ids, REMOTE_MODEL_TAIL_BYTES);
      const model = tail ? lastAssistantModel(tail.content) : undefined;
      if (model) session.noteReportedModel('transcript', friendlyClaudeModel(model));
    } catch {
      // Host unreachable or asleep: keep what is known; the next turn end tries again.
    } finally {
      this.inFlight.delete(session.id);
    }
  }
}
