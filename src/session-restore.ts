/**
 * @fileoverview Host-local pieces of session restore.
 *
 * `codeman agent restore` (inside a session) and `codeman session restore` (from a
 * plain shell on the host) both need two things the HTTP API cannot give them:
 *
 * 1. **The CLI's own conversation id for a DELETED session.** Codeman does not track
 *    opencode's `ses_…` id — a fresh opencode pane is launched without `--session`, so
 *    `claudeSessionId` is just Codeman's own id (`src/session.ts`). opencode itself
 *    knows the conversation, and its supported `session list --format json` exposes it
 *    per directory. That is the discovery below; modes without one must be handed an
 *    explicit `--resume <cli-id>`.
 * 2. **What the deleted session looked like.** The server writes `deleted` entries to
 *    `~/.codeman/session-lifecycle.jsonl` with `workingDir`/`cliSessionId`/`remote` in
 *    `extra` (see `WebServer._doCleanupSession`); the CLI reads that file back.
 *
 * Pure host-local IO — no HTTP, no dependency on `cli-agent`, so both callers can share
 * it without a cycle.
 *
 * @module session-restore
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dataPath } from './config/instance.js';

/** Runs a CLI (`opencode session list`) and returns its exit code + stdout; injectable for tests. */
export type ConversationRunner = (
  command: string,
  args: string[],
  cwd: string
) => Promise<{ code: number; stdout: string }>;

const defaultRunner: ConversationRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: stdout ?? '' });
    });
  });

/**
 * The newest opencode conversation whose `directory` is exactly `workingDir`, from
 * `opencode session list --format json` output. Pure, so the JSON shape is pinned by a
 * test rather than only exercised live.
 */
export function pickOpenCodeSession(stdout: string, workingDir: string): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  let best: { id: string; updated: number } | null = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { id?: unknown; directory?: unknown; updated?: unknown };
    if (typeof r.id !== 'string' || r.directory !== workingDir) continue;
    const updated = typeof r.updated === 'number' ? r.updated : 0;
    if (!best || updated > best.updated) best = { id: r.id, updated };
  }
  return best?.id ?? null;
}

/**
 * Per-mode discovery of a CLI's own conversation id from a working directory. DATA, not
 * a `mode === '…'` branch (the repo guard forbids those outside the stock catalog): a
 * mode absent here has no discovery and its restore needs an explicit `--resume`.
 */
export const DISCOVERY_BY_MODE: Record<
  string,
  (workingDir: string, run: ConversationRunner) => Promise<string | null>
> = {
  opencode: async (workingDir, run) => {
    const { code, stdout } = await run('opencode', ['session', 'list', '--format', 'json', '-n', '50'], workingDir);
    if (code !== 0) return null;
    return pickOpenCodeSession(stdout, workingDir);
  },
};

/**
 * Discover the CLI conversation for `mode` in `workingDir`, or null when the mode has no
 * discovery (or it failed). Never throws: a restore that cannot discover falls back to
 * "pass --resume", not to an unrelated error.
 */
export async function discoverCliSessionId(options: {
  mode: string;
  workingDir: string;
  runner?: ConversationRunner;
}): Promise<string | null> {
  const discover = DISCOVERY_BY_MODE[options.mode];
  if (!discover) return null;
  try {
    return await discover(options.workingDir, options.runner ?? defaultRunner);
  } catch {
    return null;
  }
}

/** One `deleted` record from the lifecycle log, newest first in `readDeletedSessions()`. */
export interface DeletedSessionRecord {
  id: string;
  name?: string;
  mode?: string;
  /** Where the session ran — the one field the create route needs to rebuild it. */
  workingDir?: string;
  /** The real CLI conversation id, when the server knew it (claude/codex; opencode = its own id). */
  cliSessionId?: string;
  /** A remote (SSH) session — restore belongs on its host, not here. */
  remote?: boolean;
  ts: number;
}

/**
 * Every `deleted` entry of the host's lifecycle log, newest first. The server writes it;
 * the CLI runs on the same host, so it reads the file directly. A missing/unreadable log
 * is an empty list, never a throw.
 */
export function readDeletedSessions(filePath: string = dataPath('session-lifecycle.jsonl')): DeletedSessionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: DeletedSessionRecord[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { event?: unknown; sessionId?: unknown; name?: unknown; mode?: unknown; ts?: unknown; extra?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.event !== 'deleted') continue;
    const extra = (entry.extra && typeof entry.extra === 'object' ? entry.extra : {}) as Record<string, unknown>;
    out.push({
      id: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      name: typeof entry.name === 'string' ? entry.name : undefined,
      mode: typeof entry.mode === 'string' ? entry.mode : undefined,
      workingDir: typeof extra.workingDir === 'string' ? extra.workingDir : undefined,
      cliSessionId: typeof extra.cliSessionId === 'string' ? extra.cliSessionId : undefined,
      remote: extra.remote === true,
      ts: typeof entry.ts === 'number' ? entry.ts : 0,
    });
  }
  return out;
}

/**
 * The record to restore: exact id first, then a prefix (newest match wins), or the
 * newest deleted session when no id is given (`--last`).
 */
export function findDeletedSession(
  records: DeletedSessionRecord[],
  idOrPrefix?: string
): DeletedSessionRecord | undefined {
  if (!idOrPrefix) return records[0];
  return records.find((r) => r.id === idOrPrefix) ?? records.find((r) => r.id.startsWith(idOrPrefix));
}
