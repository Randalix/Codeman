/**
 * @fileoverview Host-local pieces of session restore.
 *
 * `codeman agent restore` (inside a session) and `codeman session restore` (from a
 * plain shell on the host) both need two things the HTTP API cannot give them:
 *
 * 1. **The CLI's own conversation id for a DELETED session.** For a fresh pane the
 *    recorded `claudeSessionId` is just Codeman's own id (`src/session.ts`); which CLI
 *    conversation that stands for is per mode — see `DISCOVERY_BY_MODE`. Modes without
 *    a discovery must be handed an explicit `--resume <cli-id>`.
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexThreadBySessionId, scanCodexSessionsHistory, type CodexHistorySession } from './codex-transcript.js';
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
 * Whether Claude has a transcript for conversation `id` under `projectsDir` (any project
 * folder: the folder name is Claude's own slug of the cwd, so it is matched by file, not
 * derived). A session deleted before its first prompt has none, and resuming it fails.
 */
export function claudeTranscriptExists(projectsDir: string, id: string): boolean {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return false;
  }
  return dirs.some((dir) => existsSync(join(projectsDir, dir, `${id}.jsonl`)));
}

/**
 * Whether a codex rollout's originator can be trusted to name the pane that wrote it:
 * written by the pane's OWN codex TUI (`source` `cli`, or absent on codex versions that
 * predate the field) in the session's directory. codex 0.157's shared app-server daemon
 * breaks the originator for its clients (`source` `vscode`): it stamps the env of the
 * pane that started the daemon, so a later pane's thread would carry the starter's id —
 * measured 2026-09-25, a throwaway pane in another case under a live worker's
 * originator. Such a thread is left for an explicit `--resume` rather than guessed.
 */
export function isOwnCodexRollout(row: CodexHistorySession, workingDir: string): boolean {
  if (row.source !== undefined && row.source !== 'cli') return false;
  // Case-blind like the server's own rollout matching: codex records the launch-time case.
  return row.workingDir.toLowerCase() === workingDir.toLowerCase();
}

/** What a discovery knows about the session, plus the IO it may do (injectable for tests). */
export interface DiscoveryContext {
  workingDir: string;
  /** The Codeman session id of the deleted session. */
  sessionId: string;
  run: ConversationRunner;
  /** Codex rollouts, newest first (`scanCodexSessionsHistory`). */
  codexHistory: () => Promise<CodexHistorySession[]>;
  /** Claude's transcript root (`~/.claude/projects`). */
  claudeProjectsDir: string;
}

/**
 * Per-mode discovery of a CLI's own conversation id. DATA, not a `mode === '…'` branch
 * (the repo guard forbids those outside the stock catalog): a mode absent here has no
 * discovery and its restore needs an explicit `--resume`.
 *
 * - claude runs with `--session-id <codeman-id>`, so the Codeman id IS the conversation —
 *   once Claude has written a transcript for it.
 * - codex mints its own thread id, but Codeman launches it with
 *   `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codeman_<id>`, which codex stamps into every
 *   rollout it writes: the newest of the pane's OWN rollouts (`isOwnCodexRollout`)
 *   carrying this session's originator is the one.
 * - opencode is matched by directory (newest), from its own session list.
 */
export const DISCOVERY_BY_MODE: Record<string, (ctx: DiscoveryContext) => Promise<string | null>> = {
  claude: async ({ sessionId, claudeProjectsDir }) =>
    claudeTranscriptExists(claudeProjectsDir, sessionId) ? sessionId : null,
  codex: async ({ sessionId, workingDir, codexHistory }) =>
    codexThreadBySessionId((await codexHistory()).filter((row) => isOwnCodexRollout(row, workingDir))).get(sessionId) ??
    null,
  opencode: async ({ workingDir, run }) => {
    const { code, stdout } = await run('opencode', ['session', 'list', '--format', 'json', '-n', '50'], workingDir);
    if (code !== 0) return null;
    return pickOpenCodeSession(stdout, workingDir);
  },
};

/**
 * Discover the CLI conversation of deleted session `sessionId` (`mode`, `workingDir`), or
 * null when the mode has no discovery (or it found nothing / failed). Never throws: a
 * restore that cannot discover falls back to "pass --resume", not to an unrelated error.
 */
export async function discoverCliSessionId(options: {
  mode: string;
  workingDir: string;
  sessionId: string;
  runner?: ConversationRunner;
  codexHistory?: () => Promise<CodexHistorySession[]>;
  claudeProjectsDir?: string;
}): Promise<string | null> {
  const discover = DISCOVERY_BY_MODE[options.mode];
  if (!discover) return null;
  try {
    return await discover({
      workingDir: options.workingDir,
      sessionId: options.sessionId,
      run: options.runner ?? defaultRunner,
      codexHistory: options.codexHistory ?? scanCodexSessionsHistory,
      claudeProjectsDir: options.claudeProjectsDir ?? join(process.env.HOME || '/tmp', '.claude', 'projects'),
    });
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
