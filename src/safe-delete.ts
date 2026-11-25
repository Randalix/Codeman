/**
 * @fileoverview Downstream (Randalix fork): `codeman agent rm --safe` — delete a session
 * only when nothing would be lost with it.
 *
 * Checks, each one a line in the answer:
 * - `git`: the working dir (on the session's host: locally, or over ssh for a remote
 *   case) has no uncommitted tracked changes, and HEAD is on some remote branch
 *   (`git rev-list HEAD --not --remotes` is empty). Untracked files are only a hint.
 * - `lock`: no `.agent-lock` (Neon's tools/agent-lock.sh) held by this session in the
 *   working dir or its repo root. Only a lock with `session=<id>` names its holder; a
 *   fresh one without it is a hint (`Sperre ohne Halter-ID`), never a block.
 * - `rm-safe.json` in the data dir: `{ "git_hint_only": ["/abs/path", …] }` turns the
 *   git check into a hint for working dirs at or below those paths (a folder synced
 *   another way, where uncommitted is normal).
 * - `inbox`: no unacknowledged mail (quiet status lines are only a hint).
 * - `composer`: nothing typed and unsent in the input row.
 * - `idle`: no turn running, no background shells/monitors, no open dialog (as suspend
 *   checks them).
 *
 * The pure parts live here (script, parse, evaluation, composer reading); the route
 * (`POST /api/sessions/:id/safe-delete`) gathers the facts and deletes. Nothing here
 * ever removes a worktree or branch, breaks a lock or pushes.
 *
 * @module safe-delete
 */

import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { COMPOSER_FRAME_ROW } from './session-activity.js';
import { guardedComposerChrome, readGuardedComposer } from './agent-staging.js';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';
import { stripAnsi } from './utils/regex-patterns.js';
import { dataPath } from './config/instance.js';
import type { CliEntry } from './config/cli-registry/types.js';
import type { SessionRemote } from './types/session.js';

const execAsync = promisify(exec);

export type SafeDeleteCheckKey = 'git' | 'lock' | 'inbox' | 'composer' | 'idle';

export interface SafeDeleteCheck {
  key: SafeDeleteCheckKey;
  ok: boolean;
  /** Short German line: what passed, or why it blocks. */
  message: string;
  /** Not blocking, worth knowing (untracked files, quiet mail, no remote). */
  hint?: string;
}

/** tools/agent-lock.sh's default `AGENT_LOCK_TTL_MIN`. */
export const AGENT_LOCK_TTL_SECONDS = 360 * 60;

/** Bounds the host check; a large repo's `git status` gets this long. */
export const HOST_CHECK_TIMEOUT_MS = 20_000;

const BEGIN = '__codeman_safe_delete_begin__';
const END = '__codeman_safe_delete_end__';

/**
 * POSIX sh script printing `key=value` lines between two marker lines: git facts for
 * the dir (when it is in a repo) and the first `.agent-lock` found in the dir or the
 * repo root, its age in seconds and its own `key=value` lines prefixed `lock.`.
 */
export function buildHostCheckScript(dir: string): string {
  return [
    `printf '%s\\n' ${BEGIN}`,
    `d=${shellescape(dir)}`,
    `if ! cd "$d" 2>/dev/null; then echo nodir=1; printf '%s\\n' ${END}; exit 0; fi`,
    'top=',
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    '  echo repo=1',
    '  echo "dirty=$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l)"',
    `  echo "untracked=$(git status --porcelain 2>/dev/null | grep -c '^??')"`,
    '  echo "branch=$(git symbolic-ref --short -q HEAD)"',
    '  echo "remotes=$(git remote 2>/dev/null | wc -l)"',
    '  echo "ahead=$(git rev-list --count HEAD --not --remotes 2>/dev/null)"',
    '  top=$(git rev-parse --show-toplevel 2>/dev/null)',
    'fi',
    'for f in "$d/.agent-lock" ${top:+"$top/.agent-lock"}; do',
    '  if [ -f "$f" ]; then',
    '    echo "lockfile=$f"',
    '    echo "lockage=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || date +%s) ))"',
    `    sed 's/^/lock./' "$f"`,
    '    break',
    '  fi',
    'done',
    `printf '%s\\n' ${END}`,
  ].join('\n');
}

export interface HostFacts {
  /** The working dir does not exist (any more). */
  noDir: boolean;
  repo: boolean;
  dirty: number;
  untracked: number;
  branch: string;
  remotes: number;
  /** Commits on HEAD that no remote branch has; null when git could not say (no commit yet). */
  ahead: number | null;
  lock: { file: string; ageSeconds: number; fields: Record<string, string> } | null;
}

/** The script's facts, or null when the output is not the script's (ssh failed, no sh). */
export function parseHostCheck(stdout: string): HostFacts | null {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END, start + 1);
  if (start === -1 || end === -1) return null;
  const kv: Record<string, string> = {};
  const lockFields: Record<string, string> = {};
  for (const line of lines.slice(start + 1, end)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key.startsWith('lock.')) {
      const field = key.slice(5);
      if (field && !(field in lockFields)) lockFields[field] = value.trim();
    } else kv[key] = value.trim();
  }
  const num = (v: string | undefined): number => {
    const n = Number.parseInt((v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  };
  const aheadRaw = (kv.ahead ?? '').trim();
  return {
    noDir: kv.nodir === '1',
    repo: kv.repo === '1',
    dirty: num(kv.dirty),
    untracked: num(kv.untracked),
    branch: kv.branch ?? '',
    remotes: num(kv.remotes),
    ahead: /^\d+$/.test(aheadRaw) ? Number(aheadRaw) : null,
    lock: kv.lockfile ? { file: kv.lockfile, ageSeconds: num(kv.lockage), fields: lockFields } : null,
  };
}

/** Same session: equal, or one is a prefix (≥ 8 chars) of the other. */
function sameSession(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 8 && long.startsWith(short);
}

/** The `git` and `lock` checks from the host's facts; null facts = host not readable. */
export function evaluateHostFacts(
  facts: HostFacts | null,
  sessionId: string,
  options: { gitHintOnly?: boolean } = {}
): SafeDeleteCheck[] {
  if (!facts) {
    const message = 'Host nicht prüfbar (ssh/sh fehlgeschlagen)';
    return [
      { key: 'git', ok: false, message },
      { key: 'lock', ok: false, message },
    ];
  }
  const checks: SafeDeleteCheck[] = [];
  if (facts.noDir) {
    checks.push({ key: 'git', ok: true, message: 'Arbeitsverzeichnis existiert nicht mehr' });
  } else if (!facts.repo) {
    checks.push({ key: 'git', ok: true, message: 'kein Git-Repo' });
  } else {
    const where = facts.branch ? `Branch ${facts.branch}` : 'detached HEAD';
    const hints: string[] = [];
    if (facts.untracked > 0) hints.push(`${facts.untracked} untracked`);
    const problems: string[] = [];
    if (facts.dirty > 0) problems.push(`uncommittete Änderungen (${facts.dirty} Dateien)`);
    if (facts.remotes === 0) problems.push('Repo ohne Remote, nichts gepusht');
    else if (facts.ahead === null) problems.push(`ungepushte Commits (nicht prüfbar, ${where})`);
    else if (facts.ahead > 0) problems.push(`ungepushte Commits (${facts.ahead}, ${where})`);
    if (problems.length > 0 && options.gitHintOnly) {
      // rm-safe.json `git_hint_only`: a folder synced some other way (the wiki over
      // LiveSync), where uncommitted is the normal state.
      checks.push({
        key: 'git',
        ok: true,
        message: 'git nur Hinweis (rm-safe.json)',
        hint: [...problems, ...hints].join(', '),
      });
    } else {
      checks.push({
        key: 'git',
        ok: problems.length === 0,
        message: problems.length === 0 ? 'git sauber+gepusht' : problems.join('; '),
        ...(hints.length ? { hint: hints.join(', ') } : {}),
      });
    }
  }
  const lock = facts.lock;
  if (!lock) {
    checks.push({ key: 'lock', ok: true, message: 'keine Sperre' });
  } else {
    const label = lock.fields.agent || lock.file;
    const holder = lock.fields.session;
    if (holder) {
      const mine = sameSession(holder, sessionId);
      checks.push({
        key: 'lock',
        ok: !mine,
        message: mine ? `hält Sperre „${label}"` : `Sperre gehört ${holder.slice(0, 8)}`,
      });
    } else if (lock.ageSeconds < AGENT_LOCK_TTL_SECONDS) {
      // No holder recorded (agent-lock.sh before `session=`): it cannot be told whose it
      // is, and blocking on it would block every session in that worktree. A hint only.
      const content = Object.entries(lock.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      checks.push({
        key: 'lock',
        ok: true,
        message: 'Sperre ohne Halter-ID',
        hint: `Sperre ohne Halter-ID: ${content}`,
      });
    } else {
      checks.push({ key: 'lock', ok: true, message: 'Sperre abgelaufen', hint: `alte Sperre „${label}"` });
    }
  }
  return checks;
}

/** Absolute path prefixes from `rm-safe.json`'s `git_hint_only`; [] when missing or broken. */
export function loadGitHintOnly(path: string = dataPath('rm-safe.json')): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { git_hint_only?: unknown };
    return Array.isArray(raw.git_hint_only)
      ? raw.git_hint_only.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
      : [];
  } catch {
    return [];
  }
}

/** `dir` is one of the prefixes or below one (a path boundary, not a string prefix). */
export function underAnyPrefix(dir: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => {
    const base = p.length > 1 ? p.replace(/\/+$/, '') : p;
    return dir === base || dir.startsWith(base === '/' ? '/' : `${base}/`);
  });
}

/** Runs a shell command line and resolves its stdout. */
export type HostCheckRunner = (command: string, opts: { timeout: number }) => Promise<string>;

const execRunner: HostCheckRunner = async (command, opts) =>
  (await execAsync(command, { encoding: 'utf-8', maxBuffer: 1024 * 1024, ...opts })).stdout;

/**
 * The full command line: `sh -c <script>` locally, or the same over ssh with the launch's
 * connection options. Under `sh` explicitly, since a remote login shell may be zsh.
 */
export function buildHostCheckCommand(dir: string, remote?: SessionRemote): string {
  const local = `sh -c ${shellescape(buildHostCheckScript(dir))}`;
  if (!remote) return local;
  return [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(local)].join(' ');
}

/** The host's facts, or null when the command failed or printed something else. */
export async function readHostFacts(
  dir: string,
  remote?: SessionRemote,
  run: HostCheckRunner = execRunner
): Promise<HostFacts | null> {
  try {
    return parseHostCheck(await run(buildHostCheckCommand(dir, remote), { timeout: HOST_CHECK_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

/** Rows a draft may span below the composer's glyph row before the bottom frame. */
const MAX_DRAFT_ROWS = 12;

/**
 * What is typed in the composer of a styled capture (`capture-pane -e`): '' for an empty
 * composer, the text for a draft, null when the frame is not one this can read. Dimmed
 * text (placeholders, suggestions) is not input.
 */
export function composerDraftText(screen: string, entry: CliEntry | undefined): string | null {
  const promptGlyph = entry?.capabilities.workDetect?.promptGlyph;
  if (!promptGlyph) return null;
  const chrome = guardedComposerChrome(entry);
  if (chrome) return readGuardedComposer(screen, chrome);
  const raw = screen.split('\n');
  const rows = raw.map((line) => stripAnsi(line));
  const glyphRow = new RegExp(String.raw`^\s*${promptGlyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\s|$)`);
  let index = rows.length - 1;
  while (index >= 0 && !glyphRow.test(rows[index])) index--;
  if (index < 1 || !COMPOSER_FRAME_ROW.test(rows[index - 1])) return null;
  const parts: string[] = [
    undimmed(raw[index])
      .trimStart()
      .slice(promptGlyph.length + 1),
  ];
  let row = index + 1;
  for (; row < rows.length && row <= index + MAX_DRAFT_ROWS; row++) {
    if (COMPOSER_FRAME_ROW.test(rows[row])) break;
    parts.push(undimmed(raw[row]));
  }
  if (row >= rows.length || !COMPOSER_FRAME_ROW.test(rows[row])) return null;
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}

/** A row's text without SGR-dim runs (placeholder and suggestion text). */
function undimmed(raw: string): string {
  let dim = false;
  let visible = '';
  // eslint-disable-next-line no-control-regex
  for (const token of raw.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    if (/^\x1b\[/.test(token)) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
          i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        } else if (codes[i] === 0 || codes[i] === 22) dim = false;
        else if (codes[i] === 2) dim = true;
      }
    } else if (!dim) visible += token;
  }
  return stripAnsi(visible);
}

/** Cut a draft for the one-line refusal. */
export function shortDraft(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The summary the CLI prints after a delete. */
export function okSummary(checks: SafeDeleteCheck[]): string {
  const byKey = new Map(checks.map((c) => [c.key, c]));
  return [
    byKey.get('git')?.message ?? 'git ?',
    `inbox ${byKey.get('inbox')?.ok ? '0' : '?'}`,
    byKey.get('composer')?.ok ? 'composer leer' : 'composer ?',
    byKey.get('idle')?.ok ? 'idle' : 'busy?',
  ].join(', ');
}
