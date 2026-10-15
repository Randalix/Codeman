/**
 * @fileoverview Keeps each claude session's edit history current: reads the new bytes of
 * its transcripts (main + subagents) into its `EditHistoryStore` and confirms the Bash
 * image candidates that came with them.
 *
 * WHEN. Only on an occasion, never on a timer: a local session after an Edit/Write/Bash/
 * Agent tool ended (transcript watcher), a remote one at turn end (no hooks reach back
 * from a remote host, so there is no watcher), and either when the panel asks
 * (`GET …/edits?sync=1`, `POST …/edits/older`). One sync per session runs at a time; an
 * occasion during a run is folded into one more run afterwards.
 *
 * NEVER WAKES. A remote read is one ssh round trip (`remoteReadClaudeEditSources`); a
 * sleeping host is a connect timeout, reported as `unavailable` with the stored entries
 * kept. Nothing here reaches the wake registry — a wiring-guard test pins that.
 *
 * NEW CONVERSATION. A remote read learns the transcript id only from its answer. When it
 * names a conversation other than the stored one (`/clear`, resume), the offsets sent were
 * for the old file, so the read is repeated without them and every file is read from its
 * end like a first read.
 *
 * IMAGES. A Bash candidate counts only when the file's mtime lies in the call's window
 * (start − 2 s … end + 2 s), so `ls *.png` lists nothing. Transcript times and mtime come
 * from the same host, so clock skew to this server does not matter.
 *
 * Tests: `test/edit-history-sync.test.ts`.
 *
 * @module web/edit-history-sync
 */

import type { SessionRemote } from '../types/session.js';
import type { EditSourceRequest, RemoteClaudeEditSources, RemoteProbe } from '../remote-files.js';
import type { ImageCandidate } from '../edit-history-parse.js';
import { EditHistoryStore, READ_BUDGET_BYTES, type ConfirmedImage } from '../edit-history-store.js';
import { getCli } from '../config/cli-registry/registry.js';

/** Slack around a Bash call's window for the image mtime check. */
export const IMAGE_MTIME_SLACK_MS = 2000;
/** Forward passes per sync when a file grew by more than one budget. */
export const MAX_FORWARD_PASSES = 3;

export type EditHistoryState = 'ok' | 'unavailable' | 'unsupported';

export interface EditHistoryStatus {
  state: EditHistoryState;
  reason?: string;
}

/** The slice of a session this needs. */
export interface EditHistorySession {
  id: string;
  mode: string;
  remote: SessionRemote | undefined;
  docker?: unknown;
  claudeSessionId: string | null;
}

export interface EditHistorySyncDeps {
  readLocal(
    ids: readonly string[],
    requests: readonly EditSourceRequest[],
    budget: number
  ): Promise<RemoteClaudeEditSources | null>;
  /** `sessionId` is the Codeman session's: the reader finds the claude it runs (after a `/clear`). */
  readRemote(
    remote: SessionRemote,
    ids: readonly string[],
    requests: readonly EditSourceRequest[],
    budget: number,
    sessionId: string
  ): Promise<RemoteClaudeEditSources | null>;
  /** Probe local paths (`~/` already expanded by the caller's choice); null = missing. */
  probeLocal(paths: readonly string[]): Promise<Array<RemoteProbe | null>>;
  probeRemote(remote: SessionRemote, paths: readonly string[]): Promise<Array<RemoteProbe | null>>;
  loadStore(sessionId: string): Promise<EditHistoryStore>;
  /** Called after a sync that added entries. */
  onUpdated(sessionId: string, added: number): void;
  budget?: number;
}

export interface SyncOptions {
  older?: boolean;
}

/** Why a session has no edit history, or undefined when it can have one. */
export function unsupportedReason(session: EditHistorySession): string | undefined {
  if (session.docker) return 'docker';
  if (getCli(session.mode)?.capabilities.transcript !== 'claude-jsonl') return 'mode';
  return undefined;
}

/**
 * Bash candidates whose probed file is a regular file with an mtime inside the call's window
 * (files claude sent to the user skip the window: they exist and were shown on purpose).
 * A candidate whose file version is already recorded is skipped: `known(path)` is the newest
 * entry time for that path, and an entry at or after `mtime − slack` saw this version — the
 * `ls *.png` right after the render, or a Write followed by a listing. Candidates are taken
 * in call order so a batch dedupes itself the same way.
 */
export function confirmImages(
  candidates: readonly ImageCandidate[],
  probe: (path: string) => RemoteProbe | null | undefined,
  known: (path: string) => number | undefined = () => undefined
): ConfirmedImage[] {
  const out: ConfirmedImage[] = [];
  const seen = new Map<string, number>();
  for (const c of [...candidates].sort((a, b) => a.end - b.end)) {
    for (const path of c.paths) {
      const p = probe(path);
      if (!p || p.kind !== 'file' || !p.mtimeMs) continue;
      const inWindow = p.mtimeMs >= c.start - IMAGE_MTIME_SLACK_MS && p.mtimeMs <= c.end + IMAGE_MTIME_SLACK_MS;
      if (!c.sent && !inWindow) continue;
      const entryPath = path.startsWith('~/') ? p.realPath : path;
      const last = Math.max(seen.get(entryPath) ?? -Infinity, known(entryPath) ?? -Infinity);
      if (last >= p.mtimeMs - IMAGE_MTIME_SLACK_MS) continue;
      seen.set(entryPath, c.end);
      const img: ConfirmedImage = {
        toolUseId: c.toolUseId,
        path: entryPath,
        ts: c.end,
        tool: c.sent ? 'sent' : 'bash',
      };
      if (c.agentId) img.agentId = c.agentId;
      out.push(img);
    }
  }
  return out;
}

interface SessionSlot {
  store?: EditHistoryStore;
  status: EditHistoryStatus;
  running?: Promise<void>;
  again?: { older: boolean };
}

export class EditHistorySync {
  private readonly slots = new Map<string, SessionSlot>();
  private readonly budget: number;

  constructor(private readonly deps: EditHistorySyncDeps) {
    this.budget = deps.budget ?? READ_BUDGET_BYTES;
  }

  /** The session's store, loaded from disk on first use. */
  async getStore(sessionId: string): Promise<EditHistoryStore> {
    const slot = this.slot(sessionId);
    if (!slot.store) slot.store = await this.deps.loadStore(sessionId);
    return slot.store;
  }

  getStatus(sessionId: string): EditHistoryStatus {
    return { ...this.slot(sessionId).status };
  }

  /**
   * Read what is new (or, with `older`, the next older block). Resolves when this
   * occasion's run is done; never rejects. A call during a run queues one more run.
   */
  async sync(session: EditHistorySession, opts: SyncOptions = {}): Promise<EditHistoryStatus> {
    const why = unsupportedReason(session);
    const slot = this.slot(session.id);
    if (why) {
      slot.status = { state: 'unsupported', reason: why };
      return this.getStatus(session.id);
    }
    if (slot.running) {
      slot.again = { older: (slot.again?.older ?? false) || !!opts.older };
      await slot.running;
      // The queued run starts when the current one ends; wait for it too.
      if (slot.running) await slot.running;
      return this.getStatus(session.id);
    }
    slot.running = this.runLoop(session, !!opts.older);
    try {
      await slot.running;
    } finally {
      slot.running = undefined;
    }
    return this.getStatus(session.id);
  }

  /** Write every loaded store's pending changes (server shutdown). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.store?.flush()));
  }

  /** Drop a deleted session: forget it and delete its stored history. */
  async remove(sessionId: string): Promise<void> {
    const store = await this.getStore(sessionId);
    this.slots.delete(sessionId);
    await store.remove();
  }

  private slot(sessionId: string): SessionSlot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = { status: { state: 'ok' } };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  private async runLoop(session: EditHistorySession, older: boolean): Promise<void> {
    const slot = this.slot(session.id);
    let next: boolean | null = older;
    while (next !== null) {
      await this.runOnce(session, next);
      // An unreachable host is not back a moment later: a queued run would only wait out
      // another connect timeout (and keep its callers waiting for it).
      if (slot.status.state === 'unavailable') slot.again = undefined;
      next = slot.again ? slot.again.older : null;
      slot.again = undefined;
    }
  }

  private async runOnce(session: EditHistorySession, older: boolean): Promise<void> {
    const slot = this.slot(session.id);
    const store = await this.getStore(session.id);
    const ids = [session.claudeSessionId || session.id, session.id];
    let added = 0;
    try {
      if (older) {
        added += await this.readOlder(session, store, ids);
      } else {
        for (let pass = 0; pass < MAX_FORWARD_PASSES; pass++) {
          const r = await this.readForward(session, store, ids);
          added += r.added;
          if (!r.more) break;
        }
      }
      slot.status = { state: 'ok' };
    } catch (err) {
      slot.status = { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
    if (added > 0) this.deps.onUpdated(session.id, added);
  }

  private read(session: EditHistorySession, ids: readonly string[], requests: EditSourceRequest[]) {
    return session.remote
      ? this.deps.readRemote(session.remote, ids, requests, this.budget, session.id)
      : this.deps.readLocal(ids, requests, this.budget);
  }

  private forwardRequests(store: EditHistoryStore, known: Iterable<string>): EditSourceRequest[] {
    const out: EditSourceRequest[] = [];
    for (const relPath of known) {
      const c = store.getCursor(relPath);
      if (c) out.push({ relPath, offset: c.offset });
    }
    return out;
  }

  /** One forward read of all sources. `more` = some file has unread bytes after it. */
  private async readForward(
    session: EditHistorySession,
    store: EditHistoryStore,
    ids: readonly string[]
  ): Promise<{ added: number; more: boolean }> {
    const knownId = store.getTranscriptId();
    const requests = knownId ? this.forwardRequests(store, store.knownSources()) : [];
    let res = await this.read(session, ids, requests);
    if (!res) return { added: 0, more: false };
    if (requests.length > 0 && res.transcriptId !== knownId) {
      res = await this.read(session, ids, []);
      if (!res) return { added: 0, more: false };
    }
    for (const [agentId, text] of Object.entries(res.metas)) {
      if (!store.hasAgentMeta(agentId)) store.setAgentMeta(agentId, text);
    }
    let added = 0;
    let more = false;
    const candidates: ImageCandidate[] = [];
    for (const f of res.files) {
      const r = store.apply({
        transcriptId: res.transcriptId,
        source: f.relPath,
        startOffset: f.startOffset,
        chunk: f.chunk,
        size: f.size,
      });
      added += r.added;
      candidates.push(...r.candidates);
      if (f.startOffset + f.chunk.length < f.size) more = true;
    }
    added += await this.addImages(session, store, candidates);
    return { added, more };
  }

  private async readOlder(
    session: EditHistorySession,
    store: EditHistoryStore,
    ids: readonly string[]
  ): Promise<number> {
    if (!store.backfillTruncated) return 0;
    const requests: EditSourceRequest[] = [];
    for (const relPath of store.sourcesWithOlder()) {
      const range = store.olderRange(relPath, this.budget);
      if (range) requests.push({ relPath, offset: range.offset, len: range.len });
    }
    if (requests.length === 0) return 0;
    const res = await this.read(session, ids, requests);
    if (!res || res.transcriptId !== store.getTranscriptId()) return 0;
    const wanted = new Set(requests.map((r) => r.relPath));
    let added = 0;
    const candidates: ImageCandidate[] = [];
    for (const f of res.files) {
      if (!wanted.has(f.relPath)) continue;
      const r = store.applyOlder({
        transcriptId: res.transcriptId,
        source: f.relPath,
        startOffset: f.startOffset,
        chunk: f.chunk,
        size: f.size,
      });
      added += r.added;
      candidates.push(...r.candidates);
    }
    return added + (await this.addImages(session, store, candidates));
  }

  private async addImages(
    session: EditHistorySession,
    store: EditHistoryStore,
    candidates: readonly ImageCandidate[]
  ): Promise<number> {
    const paths = [...new Set(candidates.flatMap((c) => c.paths))];
    if (paths.length === 0) return 0;
    let probes: Array<RemoteProbe | null>;
    try {
      probes = session.remote ? await this.deps.probeRemote(session.remote, paths) : await this.deps.probeLocal(paths);
    } catch {
      // The edits of this read are in; only its images are lost. The read itself succeeded.
      return 0;
    }
    const byPath = new Map(paths.map((p, i) => [p, probes[i]]));
    const newest = new Map<string, number>();
    for (const e of store.list()) newest.set(e.path, Math.max(newest.get(e.path) ?? -Infinity, e.ts));
    return store.addImageEntries(
      confirmImages(
        candidates,
        (p) => byPath.get(p),
        (p) => newest.get(p)
      )
    );
  }
}
