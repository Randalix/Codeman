/**
 * @fileoverview `codeman agent …` — session-to-session verbs for the agent running
 * inside a Codeman session, in every CLI mode.
 *
 * A thin HTTP client over endpoints that already exist (`quick-start`, `input`,
 * `wait`, `wait-output`, `last-response`, `terminal`, `DELETE sessions/:id`). It
 * invents no route and no transport: everything goes through `CODEMAN_API_URL`, so
 * auth, ownership and the per-session waiter cap apply unchanged. The behaviour is
 * the packaged agent skill's (`skills/codeman`), ported from shell prose into code
 * with tests, so a `codex`/`opencode`/`pi` agent — which never gets the claude-only
 * preamble — has the same verbs from one line in its AGENTS.md.
 *
 * Invariants (each asserted in `test/cli-agent.test.ts`):
 * 1. Refuses outside a Codeman session (`CODEMAN_MUX=1` + `CODEMAN_API_URL`); it
 *    never guesses a URL — a server you are not part of is not yours to drive.
 * 2. `send` transmits printable text plus `\r` only. ESC exists solely as
 *    `interrupt`, which never appends `\r`. A stray control byte is a dead session
 *    in the fullscreen TUIs (opencode's `Ctrl+C` is `app_exit`).
 * 3. `rm` fails closed: empty id, a short self id, or a prefix match in EITHER
 *    direction refuses. Ids appear in full and 8-char form, so equality alone
 *    misses a real combination — and the miss deletes the caller.
 * 4. An id shorter than 8 characters refuses (exit 4) before any request, on every
 *    verb. `9` would resolve to whichever session is alone with that first
 *    character, the user's own interactive tab included.
 *
 * Commands live here as functions returning an exit code, not calling
 * `process.exit`, so the whole surface is unit-testable against a fake server.
 *
 * @module cli-agent
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { dataPath } from './config/instance.js';
import { GLYPH, palette, table } from './cli-style.js';
import { getErrorMessage } from './types.js';
import { stripAnsi as stripAnsiSequences } from './utils/regex-patterns.js';
import {
  discoverCliSessionId,
  findDeletedSession,
  readDeletedSessions,
  type DeletedSessionRecord,
} from './session-restore.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context and guard
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Base URL of the Codeman server, from `CODEMAN_API_URL`. */
  apiUrl: string;
  /** This session's id, from `CODEMAN_SESSION_ID`. */
  selfId: string;
  /** Basic-auth credentials, when the server has a password. */
  auth?: { username: string; password: string };
}

/** Thrown when the process is not inside a Codeman-managed session. */
export class AgentGuardError extends Error {}

/** Exit codes shared by every verb; a shell agent can branch on them. */
export const EXIT = {
  ok: 0,
  error: 1,
  timeout: 2,
  dead: 3,
  refused: 4,
} as const;

/**
 * Parse the data dir's `.env` (hand-authored; the same fallback `codeman attach`
 * and the agent skill use). Tolerant: unreadable or absent means `{}`.
 */
export function readCodemanEnvFile(path: string = dataPath('.env')): Record<string, string> {
  try {
    const text = readFileSync(path, 'utf-8');
    const result: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Resolve the context from the environment, or throw `AgentGuardError`.
 *
 * Credentials, cheapest first: `CODEMAN_PASSWORD` in the environment (a session
 * inherits the server's), then the data dir's `.env`. Nothing found means the
 * server is open (single-user, no password) — or it is not, and the 401 says so.
 */
export function resolveAgentContext(
  env: NodeJS.ProcessEnv = process.env,
  envFile: () => Record<string, string> = readCodemanEnvFile
): AgentContext {
  if (env.CODEMAN_MUX !== '1') {
    throw new AgentGuardError('Not inside a Codeman-managed session (CODEMAN_MUX is not 1); refusing to act.');
  }
  const apiUrl = env.CODEMAN_API_URL?.trim();
  if (!apiUrl) {
    throw new AgentGuardError('CODEMAN_API_URL is not set; refusing to guess a server.');
  }
  const selfId = env.CODEMAN_SESSION_ID?.trim();
  if (!selfId) {
    throw new AgentGuardError('CODEMAN_SESSION_ID is not set; cannot tell which session is me.');
  }
  // Each field from the environment first, then the data dir's `.env` — per FIELD, the
  // order `codeman attach` and the TUI use. Taking the file only when the password was
  // missing paired an env password with the default user `admin` instead of the
  // file's user.
  const needFile = !env.CODEMAN_USERNAME || !env.CODEMAN_PASSWORD;
  const file = needFile ? envFile() : {};
  const username = env.CODEMAN_USERNAME || file.CODEMAN_USERNAME || 'admin';
  const password = env.CODEMAN_PASSWORD || file.CODEMAN_PASSWORD;
  return {
    apiUrl,
    selfId,
    auth: password ? { username, password } : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (the invariants)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `id` this session? Prefix in BOTH directions, because ids appear in full and
 * in 8-char form (mux names, UI surfaces, Docker's truncated `$SELF`). A self id
 * shorter than 8 characters cannot prove anything and is treated as "maybe me".
 */
export function isSelfSession(selfId: string, id: string): boolean {
  if (!id || selfId.length < 8) return true;
  return id.startsWith(selfId) || selfId.startsWith(id);
}

/** Why `rm` refuses, or `undefined` when the delete may go ahead. */
export function deleteRefusal(selfId: string, id: string): string | undefined {
  if (!id) return 'refusing: empty session id';
  if (selfId.length < 8) return 'refusing: own session id unset or too short to prove this is not me';
  if (isSelfSession(selfId, id)) return `refusing: ${id} is me`;
  return undefined;
}

/**
 * The prompt `send` was given, which must be ONE argument. Joining several with spaces
 * would turn an unquoted `$(cat notes.txt)`, which the shell splits on every newline,
 * back into a single line, so the multi-line refusal below would never see it.
 */
export function sendPromptFromArgs(words: readonly string[]): { text: string } | { error: string } {
  if (words.length === 1) return { text: words[0] };
  return {
    error: `refusing: the prompt must be ONE argument, got ${words.length} — quote it (\`send <id> "…"\`; a prompt that starts with "-" goes after --: \`send <id> -- "- fix the bug"\`)`,
  };
}

/**
 * Why `send` refuses this text, or `undefined` when it is printable. The composer
 * takes one line; the server strips `\r`/`\n` but everything else below 0x20 (and
 * DEL) reaches the pane as a keypress. None of that is a prompt.
 */
export function inputRefusal(text: string): string | undefined {
  if (text.length === 0) return 'refusing: empty input (use `interrupt` for ESC, `send <id> ""` is never a prompt)';
  // The composer is one line: the server strips newlines, which silently joins the
  // lines into one prompt, and a tab reaches the pane as a keypress (claude: mode toggle).
  if (/[\n\r\t]/.test(text)) {
    return 'refusing: input must be a single line (the composer strips newlines and would join your lines) — join them yourself, or write a file into the workspace and send its path';
  }
  // C0, DEL and C1 (U+0080–U+009F: an 8-bit CSI is still a CSI to a terminal).
  // eslint-disable-next-line no-control-regex
  const control = text.match(/[\x00-\x1f\x7f-\x9f]/);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(2, '0');
    return `refusing: input contains control byte 0x${code}; send transmits printable text only (ESC is \`interrupt\`)`;
  }
  return undefined;
}

/**
 * Body for `POST /sessions/:id/input` on the send path: text plus `\r` unless the
 * caller asked to type without submitting. Never anything else.
 */
export function buildSendBody(
  text: string,
  options: { enter: boolean; clientId: string; seq: number; wait?: string | true; waitTimeout?: number }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: options.enter ? `${text}\r` : text,
    useMux: true,
    clientId: options.clientId,
    seq: options.seq,
  };
  if (options.wait !== undefined) body.wait = options.wait;
  if (options.waitTimeout !== undefined) body.waitTimeout = options.waitTimeout;
  return body;
}

/** Body for the interrupt path: a bare ESC, and nothing appended — ever. */
export function buildInterruptBody(clientId: string, seq: number): Record<string, unknown> {
  return { input: '\u001b', useMux: true, clientId, seq };
}

/** `clientId` for this caller: fixed per sending session, so `seq` stays monotonic. */
export function defaultClientId(selfId: string, suffix = ''): string {
  return `codeman-agent-cli-${selfId.slice(0, 8)}${suffix ? `-${suffix}` : ''}`;
}

/**
 * Strip a terminal buffer for humans: the shared ANSI strip (CSI, OSC such as window
 * titles, keypad modes) plus the charset designators (`ESC ( B`) it leaves in.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsiSequences(text).replace(/\x1b[()][AB0]/g, '');
}

/** Parse a positive-integer option (`--timeout` ms, `--tail` bytes); the server rejects anything else. */
export function parsePositiveInt(raw: string | undefined, fallback: number, flag = '--timeout'): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Exit code for a wait result: matched or a signal → ok, `exit` or `ended` → dead,
 * timeout → timeout. `ended` is checked BEFORE the happy paths: a worker that dies
 * during `--until stop` comes back as `ended:true, signal:null` (the registry only
 * satisfies waiters that listed `exit`, then cancels the rest), and a `--match` on
 * a dead worker as `ended:true, matched:false` — both are "dead", never "done".
 */
export function waitExitCode(wait: WaitResult | undefined): number {
  if (!wait) return EXIT.error;
  if (wait.signal === 'exit' || wait.ended) return EXIT.dead;
  if (wait.timedOut) return EXIT.timeout;
  if (wait.matched === false) return EXIT.timeout;
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  /** Parsed envelope, or `undefined` when the body was not JSON (auth guards answer in plain text). */
  json?: ApiEnvelope<T>;
  text: string;
}

export interface WaitResult {
  /** The signal that fired, or null when the wait ended without one. */
  signal?: string | null;
  timedOut?: boolean;
  /** The session went away (deleted / torn down / the write failed) before the wait resolved. */
  ended?: boolean;
  timeoutMs?: number;
  until?: string[];
  matched?: boolean;
  match?: string;
  snippet?: string;
  immediate?: boolean;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Socket timeout; long-polls pass their own timeout plus headroom. */
  timeoutMs?: number;
}

export type ApiRequest = (ctx: AgentContext, options: RequestOptions) => Promise<ApiResponse>;

/** Every request carries these; they are ignored on endpoints that do not read them. */
export function baseHeaders(ctx: AgentContext): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Tags sessions this caller spawns as its children (lineage in the web UI) and
    // labels case directories a spawn creates as agent scratch. Cosmetic, never
    // fails a call, so there is no case for leaving them off. Omitted when the
    // caller has no session of its own (the root `codeman session restore`).
    'X-Codeman-Agent-Origin': 'codeman-agent-cli',
  };
  if (ctx.selfId) headers['X-Codeman-Parent-Session'] = ctx.selfId;
  if (ctx.auth) {
    headers.Authorization = `Basic ${Buffer.from(`${ctx.auth.username}:${ctx.auth.password}`).toString('base64')}`;
  }
  return headers;
}

/** The real transport. `rejectUnauthorized:false` because the HTTPS install uses a self-signed cert. */
export const httpRequest: ApiRequest = (ctx, options) => {
  const url = new URL(options.path, ctx.apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const bodyText = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string | number> = { ...baseHeaders(ctx), ...(options.headers ?? {}) };
  if (bodyText !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyText);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
        timeout: options.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: ApiEnvelope | undefined;
          try {
            json = JSON.parse(text) as ApiEnvelope;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${options.timeoutMs ?? 30_000} ms`)));
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
};

/** One line describing a failed response, for humans. Plain-text guards (401/403/429) have no envelope. */
export function describeFailure(res: ApiResponse): string {
  if (res.json && !res.json.success) {
    return `${res.json.errorCode ?? 'ERROR'}: ${res.json.error ?? 'request failed'} (HTTP ${res.status})`;
  }
  const text = res.text.trim().split('\n')[0] ?? '';
  if (res.status === 401)
    return `HTTP 401 ${text}: the server wants a password (CODEMAN_PASSWORD, or the data dir's .env)`;
  return `HTTP ${res.status}${text ? ` ${text}` : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AgentDeps {
  ctx: AgentContext;
  request: ApiRequest;
  io: AgentIo;
  json: boolean;
  /** Clock for `seq`; injectable so tests are deterministic. */
  now?: () => number;
}

/** Print `data` as JSON (the `--json` path) — always the envelope's `data`, never a reshaped copy. */
function emitJson(deps: AgentDeps, data: unknown): void {
  deps.io.out(JSON.stringify(data, null, 2));
}

function fail(deps: AgentDeps, message: string, code: number = EXIT.error): number {
  if (deps.json) {
    deps.io.out(JSON.stringify({ success: false, error: message }));
  } else {
    deps.io.err(palette.err(`${GLYPH.fail} ${message}`));
  }
  return code;
}

interface SessionRow {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  workingDir?: string;
  pid?: number | null;
  parentSessionId?: string | null;
  /** Wall-clock ms the last turn ended; null while one runs. Absent on older servers. */
  turnEndedAt?: number | null;
  turnEndSource?: string | null;
  ralphTodoStats?: { total: number; pending: number; inProgress: number; completed: number };
}

/** `open/total` for the TODO column, `-` without a list. */
function todoCell(stats: SessionRow['ralphTodoStats']): string {
  return stats && stats.total > 0 ? `${stats.pending + stats.inProgress}/${stats.total}` : '-';
}

/** A full session id (the only form the routes accept); `ls` prints the 8-char prefix. */
const FULL_ID_LENGTH = 36;

/**
 * Shortest prefix that may name a session: the 8-char form `ls` prints, and the floor
 * the server's own resolver uses (`PARENT_SESSION_ID_MIN_PREFIX`, route-helpers.ts).
 */
export const MIN_ID_PREFIX_LENGTH = 8;

/** Why an id is too short to name a session, or `undefined` when it may. */
export function shortIdRefusal(id: string): string | undefined {
  if (!id) return 'refusing: empty session id';
  if (id.length < MIN_ID_PREFIX_LENGTH) {
    return `refusing: "${id}" is shorter than ${MIN_ID_PREFIX_LENGTH} characters — use the 8-character id \`agent ls\` prints, or the full id`;
  }
  return undefined;
}

/**
 * Turn the id a human typed into the one the routes accept. `ls` prints 8-char
 * prefixes and the routes answer 404 to those (measured live), so anything shorter
 * than a full id resolves through the session list; an ambiguous prefix refuses
 * rather than picking one. Below 8 characters it refuses before the list: "unique"
 * means nothing for `9` — it names whatever session happens to be alone with that
 * first character, and `rm`/`send` would act on it.
 */
export async function resolveSessionId(
  deps: AgentDeps,
  id: string
): Promise<{ id: string } | { error: string; code: number }> {
  const tooShort = shortIdRefusal(id);
  if (tooShort) return { error: tooShort, code: EXIT.refused };
  if (id.length >= FULL_ID_LENGTH) return { id };
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return { error: describeFailure(res), code: EXIT.error };
  const matches = ((res.json.data as SessionRow[] | undefined) ?? []).filter((s) => s.id.startsWith(id));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `no session starts with "${id}" (see \`agent ls\`)`, code: EXIT.error };
  return { error: `"${id}" is ambiguous: ${matches.map((s) => s.id.slice(0, 13)).join(', ')}`, code: EXIT.error };
}

/** One session's mailbox state, from `GET /api/agent-inbox/summary`. */
interface InboxSummaryRow {
  pending: number;
  waiting: boolean;
  waitingSince: string | null;
}

/**
 * The mailbox summary for `ls`, or null on a server that predates the route (the
 * columns then read `?` and the stalled-pair footer stays silent — never a failure,
 * `ls` is the one verb that must always answer).
 */
async function fetchInboxSummary(deps: AgentDeps): Promise<Map<string, InboxSummaryRow> | null> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/agent-inbox/summary' });
  if (!res.json?.success) return null;
  return new Map(Object.entries((res.json.data as Record<string, InboxSummaryRow> | undefined) ?? {}));
}

/** `HH:MM` local time of an ISO stamp, for the WAIT column. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Stalled pairs: a session waiting on its inbox whose parent or child is idle with an
 * empty inbox. Nobody is working and nobody has mail — one of them owes the other a
 * post. A heuristic over the UI status (which is a hint, so the line says "looks
 * like"), pinned because exactly this shape cost a planner/builder pair 26 minutes
 * with nothing on any screen. Returns one line per waiting session, oldest wait first.
 */
export function stalledPairLines(sessions: SessionRow[], summary: Map<string, InboxSummaryRow>): string[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const label = (s: SessionRow) => `${s.id.slice(0, 8)}${s.name ? ` (${s.name})` : ''}`;
  const idleAndEmpty = (s: SessionRow) => s.status === 'idle' && (summary.get(s.id)?.pending ?? 0) === 0;
  const lines: Array<{ since: number; text: string }> = [];
  for (const s of sessions) {
    const entry = summary.get(s.id);
    if (!entry?.waiting || !entry.waitingSince) continue;
    const peers: SessionRow[] = [];
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    if (parent) peers.push(parent);
    for (const other of sessions) if (other.parentSessionId === s.id) peers.push(other);
    const stalled = peers.filter(idleAndEmpty);
    if (stalled.length === 0) continue;
    lines.push({
      since: Date.parse(entry.waitingSince),
      text: `${GLYPH.warn} ${label(s)} waits for mail since ${clockTime(entry.waitingSince)}; ${stalled
        .map(label)
        .join(', ')} ${stalled.length === 1 ? 'is' : 'are'} idle with an empty inbox — looks like someone owes a post`,
    });
  }
  return lines.sort((a, b) => a.since - b.since).map((l) => l.text);
}

/** `agent ls` — every session the caller can see, self marked; `--alive` probes each pane. */
export async function agentLs(deps: AgentDeps, options: { alive?: boolean } = {}): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const sessions = (res.json.data as SessionRow[] | undefined) ?? [];
  const alive = new Map<string, 'alive' | 'dead' | 'unknown'>();
  const [summary] = await Promise.all([
    fetchInboxSummary(deps),
    // One short probe per session, in parallel: `status` says busy for a corpse.
    options.alive ? Promise.all(sessions.map(async (s) => alive.set(s.id, await probeAlive(deps, s.id)))) : null,
  ]);
  const inboxOf = (id: string): InboxSummaryRow | null =>
    summary ? (summary.get(id) ?? { pending: 0, waiting: false, waitingSince: null }) : null;
  if (deps.json) {
    emitJson(
      deps,
      sessions.map((s) => ({
        ...s,
        self: isSelfSession(deps.ctx.selfId, s.id),
        ...(options.alive ? { pane: alive.get(s.id) } : {}),
        inbox: inboxOf(s.id),
      }))
    );
    return EXIT.ok;
  }
  if (sessions.length === 0) {
    deps.io.out(palette.muted('(no sessions)'));
    return EXIT.ok;
  }
  const rows = sessions.map((s) => {
    const inbox = inboxOf(s.id);
    return [
      isSelfSession(deps.ctx.selfId, s.id) ? '*' : ' ',
      s.id.slice(0, 8),
      s.mode ?? '?',
      s.status ?? '?',
      ...(options.alive ? [alive.get(s.id) === 'dead' ? 'DEAD' : (alive.get(s.id) ?? '?')] : []),
      inbox ? String(inbox.pending) : '?',
      inbox ? (inbox.waitingSince ? `since ${clockTime(inbox.waitingSince)}` : '-') : '?',
      s.turnEndedAt ? clockTime(new Date(s.turnEndedAt).toISOString()) : '-',
      todoCell(s.ralphTodoStats),
      s.name || s.workingDir || '',
    ];
  });
  const header = [
    ' ',
    'ID',
    'MODE',
    'STATUS',
    ...(options.alive ? ['PANE'] : []),
    'INBOX',
    'WAIT',
    'ENDED',
    'TODO',
    'NAME',
  ];
  deps.io.out(table([header, ...rows], { gap: 2 }));
  deps.io.out(
    palette.muted(
      `* = this session (${deps.ctx.selfId.slice(0, 8)}). status is a UI hint, never a sync signal. INBOX = unread posts, WAIT = parked on \`inbox --wait\` since, ENDED = last turn over at (- = a turn runs), TODO = open/total on its \`agent todo\` list.`
    )
  );
  if (summary) for (const line of stalledPairLines(sessions, summary)) deps.io.out(palette.warn(line));
  return EXIT.ok;
}

export interface SpawnOptions {
  caseName: string;
  mode: string;
  name?: string;
  /** Wait for the composer before returning (claude/deepseek only; other modes return at once). */
  ready: boolean;
  timeoutMs: number;
  /** `KEY=VALUE` pairs → quick-start `envOverrides` (the server allowlists the prefixes). */
  env?: string[];
  /** opencode only: writes `OPENCODE_PERMISSION` so the worker never stops on a bash/edit dialog. Validated here, not in commander, so a bad value is a `refused` exit with the JSON envelope. */
  permission?: string;
  /** Continue an existing CLI conversation (the CLI's own session id, not Codeman's). */
  resume?: string;
}

/**
 * Where each mode's quick-start body carries a resume id. The server's registry maps
 * these onto the CLI flag (`opencode --session`, `codex resume`, …); the CLI only has
 * to know the field — and it has to match `schemas.ts` EXACTLY: the config schemas are
 * plain `z.object`s that STRIP unknown keys, so a misspelled field is not a 400, it is a
 * worker that silently starts a fresh conversation (gemini is `resumeSession`,
 * antigravity `resumeConversationId`). claude is absent on purpose: quick-start has no resume field for
 * it (the create path does, via `POST /api/sessions`), so `--resume` refuses there.
 */
export const RESUME_FIELD_BY_MODE: Record<string, { config: string; field: string }> = {
  opencode: { config: 'openCodeConfig', field: 'continueSession' },
  codex: { config: 'codexConfig', field: 'resumeSessionId' },
  gemini: { config: 'geminiConfig', field: 'resumeSession' },
  antigravity: { config: 'antigravityConfig', field: 'resumeConversationId' },
  pi: { config: 'piConfig', field: 'resumeSessionId' },
  grok: { config: 'grokConfig', field: 'resumeSessionId' },
  deepseek: { config: 'deepSeekConfig', field: 'resumeSessionId' },
  omp: { config: 'ompConfig', field: 'resumeSessionId' },
};

/** `KEY=VALUE` list → object; a pair without `=` or with an empty key is an error, not a silent drop. */
export function parseEnvPairs(pairs: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** The `OPENCODE_PERMISSION` value for `--permission`. Granular: bash + edit, never `*`. */
export function opencodePermissionEnv(mode: 'allow' | 'ask'): string {
  return JSON.stringify(mode === 'allow' ? { bash: 'allow', edit: 'allow' } : { bash: 'ask', edit: 'ask' });
}

/** Which modes take `--permission`, and the env var it becomes — data, not a mode branch. */
export const PERMISSION_ENV_BY_MODE: Record<string, { name: string; value: (mode: 'allow' | 'ask') => string }> = {
  opencode: { name: 'OPENCODE_PERMISSION', value: opencodePermissionEnv },
};

/** Extra quick-start body from the spawn options; throws on a combination the server would refuse. */
export function buildSpawnExtras(options: SpawnOptions): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const env = parseEnvPairs(options.env);
  if (options.permission !== undefined) {
    if (options.permission !== 'allow' && options.permission !== 'ask') {
      throw new Error(`--permission expects allow or ask, got "${options.permission}"`);
    }
    const slot = PERMISSION_ENV_BY_MODE[options.mode];
    if (!slot) throw new Error('--permission is an opencode option (it sets OPENCODE_PERMISSION)');
    // An explicit --env for the same variable is a richer policy the user wrote by hand;
    // overriding it silently would hand them {bash,edit} and no hint. Refuse instead.
    if (slot.name in env) throw new Error(`--permission conflicts with --env ${slot.name}=…; pass one of them`);
    env[slot.name] = slot.value(options.permission);
  }
  if (Object.keys(env).length > 0) extras.envOverrides = env;
  if (options.resume) {
    const slot = RESUME_FIELD_BY_MODE[options.mode];
    if (!slot) {
      throw new Error(
        `--resume is not available for mode "${options.mode}" via quick-start (claude: run \`claude --resume <id>\` in the case, or POST /api/v1/sessions with resumeSessionId)`
      );
    }
    extras[slot.config] = {
      ...((extras[slot.config] as Record<string, unknown> | undefined) ?? {}),
      [slot.field]: options.resume,
    };
  }
  return extras;
}

/**
 * The token each TUI draws once it can take a prompt; modes without one return
 * immediately. Deliberately NOT the registry's `workDetect.promptGlyph`: claude's `❯`
 * also marks the selected row of its trust dialog, which is exactly the screen a
 * readiness wait must not mistake for a composer. `shift+tab` is the composer's own
 * hint text (the skill's choice, measured).
 */
export const READY_MARK: Record<string, string> = {
  claude: 'shift+tab',
  deepseek: '❯',
};

/**
 * Extra quick-start fields per mode, as data rather than a branch. deepseek: the same
 * permission posture the skill's `spawn_worker` and the Run button send — the harness's
 * own default still ASKS, and a worker that stops on an approval row is a worker no
 * fan-out can finish. Not an escalation: claude workers already spawn with permissions
 * skipped, and multi-user mode clamps it back for an owner without the grant.
 */
export const SPAWN_BODY_BY_MODE: Record<string, Record<string, unknown>> = {
  deepseek: { deepSeekConfig: { permissionMode: 'danger-full-access' } },
};

/** `agent spawn` — quick-start with lineage, then the readiness ladder where the mode has one. */
export async function agentSpawn(deps: AgentDeps, options: SpawnOptions): Promise<number> {
  const body: Record<string, unknown> = {
    caseName: options.caseName,
    mode: options.mode,
    parentSessionId: deps.ctx.selfId,
  };
  if (options.name) body.sessionName = options.name;
  Object.assign(body, SPAWN_BODY_BY_MODE[options.mode] ?? {});
  let extras: Record<string, unknown>;
  try {
    extras = buildSpawnExtras(options);
  } catch (err) {
    return fail(deps, getErrorMessage(err), EXIT.refused);
  }
  // Per-mode config objects merge (deepseek's permission posture + a resume id both
  // live in deepSeekConfig); everything else overrides.
  for (const [key, value] of Object.entries(extras)) {
    const existing = body[key];
    body[key] =
      existing && typeof existing === 'object' && value && typeof value === 'object'
        ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  const res = await deps.request(deps.ctx, { method: 'POST', path: '/api/v1/quick-start', body });
  const data = res.json?.data as { sessionId?: string; caseName?: string; casePath?: string } | undefined;
  if (!res.json?.success || !data?.sessionId) return fail(deps, describeFailure(res));
  const sid = data.sessionId;

  let ready: boolean | undefined;
  let readinessError: string | undefined;
  const mark = READY_MARK[options.mode];
  if (options.ready && mark) {
    const wait = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(sid)}/wait-output`,
      query: { match: mark, from: 'buffer', timeout: options.timeoutMs },
      timeoutMs: options.timeoutMs + 10_000,
    });
    // A failed readiness call (waiter cap, 400, network) is its own error, not "the
    // composer never showed up": report the real reason instead of the trust-dialog hint.
    if (!wait.json?.success) readinessError = describeFailure(wait);
    else ready = Boolean((wait.json.data as { wait?: WaitResult } | undefined)?.wait?.matched);
  }

  if (deps.json) {
    emitJson(deps, { ...data, ready, readinessError });
  } else {
    // Human lines go to stderr so `SID=$(codeman agent spawn …)` captures the id alone.
    const say = (line: string) => deps.io.err(line);
    say(palette.ok(`${GLYPH.ok} spawned ${sid} (${options.mode}, case ${data.caseName ?? options.caseName})`));
    if (ready === true) say(palette.muted('  composer up: the worker can take a prompt'));
    if (ready === false) {
      say(
        palette.warn(
          `${GLYPH.warn} composer not seen within ${options.timeoutMs} ms — read \`agent read ${sid.slice(0, 8)} --tail 2000\` before sending (trust dialog?)`
        )
      );
    }
    if (readinessError) say(palette.err(`${GLYPH.fail} readiness check failed: ${readinessError}`));
    if (ready === undefined && !readinessError && options.ready) {
      say(
        palette.muted(
          `  ${options.mode} has no readiness mark; give it a moment, then use --match markers to synchronize`
        )
      );
    }
    deps.io.out(sid);
  }
  if (readinessError) return EXIT.error;
  return ready === false ? EXIT.timeout : EXIT.ok;
}

export interface SendOptions {
  id: string;
  text: string;
  enter: boolean;
  /** `undefined` = fire-and-forget; `true` = default signal set; string = comma list. */
  wait?: string | true;
  timeoutMs?: number;
  clientId?: string;
  seq?: number;
}

/** `agent send` — printable text plus `\r`, exactly-once, optionally blocking on end of turn. */
export async function agentSend(deps: AgentDeps, options: SendOptions): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — typing into my own composer is not a message`, EXIT.refused);
  }
  const refusal = inputRefusal(options.text);
  if (refusal) return fail(deps, refusal, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const body = buildSendBody(options.text, {
    enter: options.enter,
    clientId: options.clientId ?? defaultClientId(deps.ctx.selfId),
    seq: options.seq ?? (deps.now ?? Date.now)(),
    wait: options.wait,
    waitTimeout: options.wait !== undefined ? options.timeoutMs : undefined,
  });
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/input`,
    body,
    timeoutMs: (options.timeoutMs ?? 60_000) + 10_000,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | { delivered?: boolean; duplicate?: boolean; buffered?: boolean; dropped?: boolean; wait?: WaitResult }
    | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  // Fire-and-forget to a remote session whose host is asleep (wake-on-LAN): the server
  // holds the chunk and types it once the pane is back (`buffered`), or the chunk was
  // over the wake buffer's cap and is gone (`dropped`). The seq is spent either way,
  // so a retry needs a new one (the default, the clock, gives it that).
  if (data?.dropped) {
    if (!deps.json) {
      deps.io.err(
        palette.err(
          `${GLYPH.fail} dropped: ${target.id}'s host is waking and its input buffer is full — nothing will be typed; send again once it is back`
        )
      );
    }
    return EXIT.error;
  }
  // `delivered:false` without `duplicate` is the route's "the bytes went nowhere":
  // the PTY exited or send-keys hit a dead pane. The field exists so a client does not
  // say "wait longer" when the truth is "restart the worker" — so it is a failure here.
  if (data?.delivered === false && !data.duplicate) {
    if (!deps.json) {
      deps.io.err(
        palette.err(`${GLYPH.fail} not delivered: ${target.id} has no live worker (pane exited) — restart it`)
      );
    }
    return EXIT.dead;
  }
  if (!deps.json) {
    const noEnter = options.enter ? '' : ' (no Enter)';
    if (data?.duplicate) {
      deps.io.out(palette.warn(`${GLYPH.warn} duplicate (clientId/seq already applied): nothing typed`));
    } else if (data?.buffered) {
      deps.io.out(
        palette.ok(
          `${GLYPH.ok} buffered for ${target.id}${noEnter}: its host is asleep; Codeman is waking it and types this once the pane is back`
        )
      );
    } else if (data?.delivered === true) {
      deps.io.out(palette.ok(`${GLYPH.ok} delivered to ${target.id}${noEnter}`));
    } else {
      // Fire-and-forget answers before the write, so there is no delivery report here.
      deps.io.out(palette.ok(`${GLYPH.ok} accepted for ${target.id}${noEnter} (no delivery report without --wait)`));
    }
    if (data?.wait) deps.io.out(describeWait(data.wait));
  }
  if (options.wait === undefined) return EXIT.ok;
  return waitExitCode(data?.wait);
}

function describeWait(wait: WaitResult): string {
  if (wait.signal === 'exit') return palette.err(`${GLYPH.fail} the session exited`);
  if (wait.ended) {
    return palette.err(
      `${GLYPH.fail} the wait ended without an answer: the session went away (dead worker, deleted, or nothing was written)`
    );
  }
  if (wait.timedOut) return palette.warn(`${GLYPH.warn} timed out after ${wait.timeoutMs ?? '?'} ms`);
  if (wait.matched !== undefined) {
    return wait.matched
      ? palette.ok(`${GLYPH.ok} matched "${wait.match}"${wait.snippet ? `: ${wait.snippet}` : ''}`)
      : palette.warn(`${GLYPH.warn} not matched`);
  }
  return palette.ok(
    `${GLYPH.ok} signal: ${wait.signal}${wait.immediate ? ' (immediate: current state, not a transition)' : ''}`
  );
}

export interface WaitOptions {
  id: string;
  until?: string;
  match?: string;
  from?: 'buffer' | 'now';
  fresh?: boolean;
  nocase?: boolean;
  timeoutMs: number;
}

/** `agent wait` — a signal (`--until`) or a literal output marker (`--match`). */
export async function agentWait(deps: AgentDeps, options: WaitOptions): Promise<number> {
  if (options.until && options.match)
    return fail(deps, 'use either --until <signals> or --match <marker>, not both', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const sid = encodeURIComponent(target.id);
  const res = options.match
    ? await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${sid}/wait-output`,
        query: {
          match: options.match,
          from: options.from ?? 'buffer',
          nocase: options.nocase ? 1 : undefined,
          timeout: options.timeoutMs,
        },
        timeoutMs: options.timeoutMs + 10_000,
      })
    : await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${sid}/wait`,
        query: { until: options.until, fresh: options.fresh ? 1 : undefined, timeout: options.timeoutMs },
        timeoutMs: options.timeoutMs + 10_000,
      });
  // A 400 here is the server saying "this mode has no such signal" (until=stop on an
  // external CLI). Passed through, never papered over: the marker path is the answer.
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as { wait?: WaitResult; status?: string; limitPaused?: boolean } | undefined;
  if (deps.json) {
    emitJson(deps, data ?? {});
  } else if (data?.wait) {
    deps.io.out(describeWait(data.wait));
    if (data.limitPaused)
      deps.io.out(palette.warn(`${GLYPH.warn} session is paused on a usage limit; a timeout is expected`));
  }
  return waitExitCode(data?.wait);
}

export interface ReadOptions {
  id: string;
  /** Bytes of raw terminal to fetch; ANSI is stripped for humans. */
  tail?: number;
  /** Whole conversation (`context=full`) instead of the last assistant message. */
  full?: boolean;
}

/** `agent read` — the last answer (claude/codex/deepseek transcript) or a terminal tail (every mode). */
export async function agentRead(deps: AgentDeps, options: ReadOptions): Promise<number> {
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const sid = encodeURIComponent(target.id);
  if (options.tail !== undefined) {
    const res = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${sid}/terminal`,
      query: { tail: options.tail },
    });
    if (!res.json?.success) return fail(deps, describeFailure(res));
    const buffer = (res.json.data as { terminalBuffer?: string } | undefined)?.terminalBuffer ?? '';
    if (deps.json) emitJson(deps, res.json.data);
    else deps.io.out(stripAnsi(buffer));
    return EXIT.ok;
  }
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${sid}/last-response`,
    query: { context: options.full ? 'full' : undefined },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | { text?: string; timestamp?: string; messages?: Array<{ role: string; text: string }> }
    | undefined;
  if (deps.json) {
    emitJson(deps, data ?? {});
    return EXIT.ok;
  }
  if (options.full && data?.messages) {
    for (const m of data.messages) deps.io.out(`${palette.emph(m.role)}: ${m.text}`);
    return EXIT.ok;
  }
  const text = data?.text ?? '';
  if (!text) {
    deps.io.err(
      palette.muted(
        '(empty: no transcript yet, or a mode without one — opencode/pi/gemini/shell have none; try --tail 3000)'
      )
    );
    return EXIT.ok;
  }
  deps.io.out(text);
  return EXIT.ok;
}

/** `agent interrupt` — a bare ESC keypress, no Enter, conversation intact. */
export async function agentInterrupt(deps: AgentDeps, options: { id: string }): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) return fail(deps, `refusing: ${options.id} is me`, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const body = buildInterruptBody(defaultClientId(deps.ctx.selfId, 'interrupt'), (deps.now ?? Date.now)());
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/input`,
    body,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} ESC sent to ${target.id} — one Esc does not always land; read the tail before the next prompt`
      )
    );
  return EXIT.ok;
}

/** `agent rm` — delete a session that is provably not this one. */
export async function agentRm(deps: AgentDeps, options: { id: string }): Promise<number> {
  const refusal = deleteRefusal(deps.ctx.selfId, options.id);
  if (refusal) return fail(deps, refusal, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  // The guard again on the RESOLVED id: a prefix that is not me can still resolve
  // to me only if the list is lying, but a delete is the one call worth the paranoia.
  const resolvedRefusal = deleteRefusal(deps.ctx.selfId, target.id);
  if (resolvedRefusal) return fail(deps, resolvedRefusal, EXIT.refused);
  const res = await deps.request(deps.ctx, {
    method: 'DELETE',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} deleted ${target.id} (its case directory stays on disk)`));
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness and restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is the worker behind `id` alive? `status`/`pid` lie for a tmux session (the pid is
 * the attach client, which outlives a worker that died in its pane); the one
 * truthful probe is a short `wait?until=exit`: an immediate `exit` means dead.
 */
export async function probeAlive(deps: AgentDeps, id: string): Promise<'alive' | 'dead' | 'unknown'> {
  let res: ApiResponse;
  try {
    res = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(id)}/wait`,
      query: { until: 'exit', timeout: 1000 },
      timeoutMs: 15_000,
    });
  } catch {
    // A socket timeout or reset is a probe that did not answer, not a dead worker —
    // and inside `ls --alive`'s Promise.all it must not take the other N-1 rows down.
    return 'unknown';
  }
  if (!res.json?.success) return 'unknown';
  const wait = (res.json.data as { wait?: WaitResult } | undefined)?.wait;
  if (!wait) return 'unknown';
  if (wait.signal === 'exit' || wait.ended) return 'dead';
  return 'alive';
}

/** How `restore` reaches a dead pane; injectable so the test never spawns a process. */
export type RestoreRunner = (id: string, resume: string | undefined) => Promise<{ code: number; output: string }>;

/** The host-local restore tool (`~/bin/codeman-restore-session`), or null when absent. */
export function findRestoreTool(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.CODEMAN_RESTORE_TOOL,
    ...(env.PATH ?? '').split(':').map((dir) => (dir ? `${dir}/codeman-restore-session` : '')),
    env.HOME ? `${env.HOME}/bin/codeman-restore-session` : '',
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * The default dead-pane runner: the host's `codeman-restore-session`, or a clear error
 * when it is absent. Codeman's own respawn refuses external CLIs (opencode, codex, …),
 * so the pane can only come back through that tool.
 */
const defaultRestoreRunner: RestoreRunner = async (id, resume) => {
  const tool = findRestoreTool();
  if (!tool) {
    return {
      code: EXIT.error,
      output:
        'no restore tool on this host (expected codeman-restore-session on PATH or ~/bin); respawn by hand: rm + spawn --resume <cli-session-id>',
    };
  }
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(tool, resume ? [id, '--resume', resume] : [id], { timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? EXIT.error : EXIT.ok, output: `${stdout}${stderr}`.trim() });
    });
  });
};

/**
 * The resume field for the CREATE route, per mode. `RESUME_FIELD_BY_MODE` covers the
 * per-mode config objects quick-start uses; claude's conversation id is a TOP-LEVEL
 * `resumeSessionId` on create (create supports claude, quick-start deliberately does
 * not). A mode in neither map has no resume field at all — restore must refuse rather
 * than send a body the schema would silently strip into a FRESH conversation.
 */
const RESUME_TOP_LEVEL_BY_MODE: Record<string, string> = { claude: 'resumeSessionId' };

/** Body fragment that continues `cliSessionId` for `mode` on `POST /api/v1/sessions`, or null. */
export function buildRestoreBody(mode: string, cliSessionId: string): Record<string, unknown> | null {
  const slot = RESUME_FIELD_BY_MODE[mode];
  if (slot) return { [slot.config]: { [slot.field]: cliSessionId } };
  const top = RESUME_TOP_LEVEL_BY_MODE[mode];
  if (top) return { [top]: cliSessionId };
  return null;
}

export interface RestoreOptions {
  /** Session id (prefix ok); omitted together with `last`. */
  id?: string;
  /** Restore the most recently deleted session instead of naming one. */
  last?: boolean;
  /** Explicit CLI conversation id — required for a deleted session whose mode has no discovery. */
  resume?: string;
  /** Injectable dead-pane runner (tests spawn nothing). */
  runner?: RestoreRunner;
  /** Injectable conversation discovery (tests do not run opencode). */
  discover?: (o: { mode: string; workingDir: string; sessionId: string }) => Promise<string | null>;
  /** Injectable deleted-record source (tests use a fixture). */
  deleted?: () => DeletedSessionRecord[];
}

/**
 * `restore` — bring a session back, in either of the two shapes it can be gone:
 *
 * 1. **A live session whose pane died** (worker exited, tab survives): the host's restore
 *    tool respawns the pane from the original launch command and re-attaches the CLI's
 *    conversation. A live worker is never touched — restoring it would kill its turn.
 * 2. **A session that was deleted** (the recommended step after a handoff): rebuild it
 *    from the `deleted` lifecycle record, resuming the CLI conversation. The conversation
 *    id comes from `--resume`, else the id the server recorded when it differs from the
 *    Codeman id, else per-mode discovery (claude transcript, codex originator, opencode
 *    session list) — never a guess.
 */
export async function agentRestore(deps: AgentDeps, options: RestoreOptions): Promise<number> {
  if (!options.id && !options.last) {
    return fail(
      deps,
      'refusing: give a session id (prefix ok), or --last for the most recently deleted session',
      EXIT.refused
    );
  }

  // 1) Still a live session? The list is the truthful check for a FULL id too —
  //    `resolveSessionId` trusts any 36-char id, which is exactly what a deleted one is.
  let liveId: string | undefined;
  if (options.id) {
    const id = options.id;
    const tooShort = shortIdRefusal(id);
    if (tooShort) return fail(deps, tooShort, EXIT.refused);
    const list = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
    if (!list.json?.success) return fail(deps, describeFailure(list));
    const sessions = (list.json.data as SessionRow[] | undefined) ?? [];
    const matches = sessions.filter((s) => s.id === id || (id.length < FULL_ID_LENGTH && s.id.startsWith(id)));
    if (matches.length > 1) {
      return fail(deps, `"${id}" is ambiguous: ${matches.map((s) => s.id.slice(0, 13)).join(', ')}`, EXIT.refused);
    }
    liveId = matches[0]?.id;
  }

  if (liveId) {
    const state = await probeAlive(deps, liveId);
    if (state === 'alive') {
      return fail(
        deps,
        `refusing: ${liveId} is alive — restore would kill the running worker (use interrupt, or rm + spawn --resume)`,
        EXIT.refused
      );
    }
    // Only a PROVEN corpse is respawned: an unanswered probe (waiter cap, 5xx, timeout) may
    // hide a live worker, and the external tool's own live check is not this code's to rely on.
    if (state !== 'dead') {
      return fail(
        deps,
        `refusing: could not prove ${liveId} is dead (probe answered "${state}") — retry, or check \`agent ls --alive\``,
        EXIT.refused
      );
    }
    const result = await (options.runner ?? defaultRestoreRunner)(liveId, options.resume);
    if (deps.json) emitJson(deps, { sessionId: liveId, restored: result.code === EXIT.ok, output: result.output });
    else if (result.code === EXIT.ok)
      deps.io.out(palette.ok(`${GLYPH.ok} restored ${liveId}${result.output ? `\n${result.output}` : ''}`));
    else deps.io.err(palette.err(`${GLYPH.fail} restore failed for ${liveId}: ${result.output}`));
    return result.code;
  }

  // 2) Deleted: rebuild from the lifecycle record the server wrote at delete time.
  const records = (options.deleted ?? readDeletedSessions)();
  const record = findDeletedSession(records, options.id);
  if (!record) {
    return fail(
      deps,
      options.id
        ? `no live session matches "${options.id}" and no deleted-session record does either (see \`agent ls\`)`
        : 'no deleted session to restore (the lifecycle log has no `deleted` entry)',
      EXIT.refused
    );
  }
  if (record.remote) {
    return fail(deps, `refusing: ${record.id} was a remote session — restore it on its own host`, EXIT.refused);
  }
  if (!record.workingDir) {
    return fail(
      deps,
      `the delete record for ${record.id} has no workingDir (written before restore was supported) — rebuild it by hand`,
      EXIT.refused
    );
  }
  const mode = record.mode ?? 'claude';
  const cliSessionId =
    options.resume ??
    (record.cliSessionId && record.cliSessionId !== record.id ? record.cliSessionId : undefined) ??
    (await (options.discover ?? discoverCliSessionId)({ mode, workingDir: record.workingDir, sessionId: record.id }));
  if (!cliSessionId) {
    return fail(
      deps,
      `no CLI conversation id for ${record.id} (${mode}) — pass --resume <cli-session-id>`,
      EXIT.refused
    );
  }
  const resumeBody = buildRestoreBody(mode, cliSessionId);
  if (!resumeBody) {
    return fail(
      deps,
      `mode "${mode}" has no resume field, so a deleted ${mode} session cannot continue its conversation`,
      EXIT.refused
    );
  }
  const body: Record<string, unknown> = { workingDir: record.workingDir, mode, ...resumeBody };
  if (record.name) body.name = `${record.name} (Restore)`.slice(0, 100);
  if (deps.ctx.selfId) body.parentSessionId = deps.ctx.selfId;
  const res = await deps.request(deps.ctx, { method: 'POST', path: '/api/v1/sessions', body });
  const created = res.json?.data as { session?: { id?: string } } | undefined;
  const newId = created?.session?.id;
  if (!res.json?.success || !newId) return fail(deps, describeFailure(res));
  // Create alone registers a session but does NOT launch its pane — the frontend
  // follows with `/interactive`, and so must a restore (a session that never starts is
  // not a restored one).
  const start = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(newId)}/interactive`,
  });
  if (!start.json?.success) {
    return fail(deps, `restored ${newId} but could not start its pane: ${describeFailure(start)}`, EXIT.error);
  }
  if (deps.json) emitJson(deps, { sessionId: newId, restored: true, from: record.id, cliSessionId });
  else
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} restored ${record.id.slice(0, 8)} as ${newId.slice(0, 8)} (${mode}, ${record.workingDir})${record.name ? ` — "${record.name} (Restore)"` : ''}`
      )
    );
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mailbox: post to another session's inbox, read your own
// ─────────────────────────────────────────────────────────────────────────────

export interface InboxMessage {
  id: string;
  from: string;
  text: string;
  createdAt: number;
}

/**
 * `agent post` — leave a message in another session's inbox. The message itself is
 * never typed: the receiver reads it with `agent inbox`. A receiver that would never
 * look (idle, not parked on `inbox --wait`) gets one short nudge line from the server
 * (`web/inbox-nudger.ts`); `nudge: false` stores only. Multi-line text is fine here
 * (it is stored, not sent as keystrokes).
 */
export async function agentPost(
  deps: AgentDeps,
  options: { id: string; text: string; nudge?: boolean }
): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — a note to self goes in a file, not the mailbox`, EXIT.refused);
  }
  if (options.text.trim().length === 0) return fail(deps, 'refusing: empty message', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/inbox`,
    // `nudge` only when opting out: the schema is strict, and an older server would
    // refuse the unknown field on every ordinary post.
    body: { text: options.text, from: deps.ctx.selfId, ...(options.nudge === false ? { nudge: false } : {}) },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as { message?: InboxMessage; pending?: number } | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} posted to ${target.id} (${data?.pending ?? '?'} pending there)`));
  return EXIT.ok;
}

export interface InboxOptions {
  /** Block up to this long while the inbox is empty; absent = return at once. */
  waitMs?: number;
  /** Read without even marking the mail as seen: the monitor's non-consuming peek. */
  peek: boolean;
}

/**
 * `agent inbox` — read this session's mailbox. Reading does NOT acknowledge: the
 * messages stay until `codeman agent ack` (a plain read only marks them seen, so
 * `ack` removes exactly what was read). A read that is never followed by an ack
 * leaves the mail pending — the receiver visibly still owes the work instead of the
 * order silently vanishing. `--peek` skips the seen-marking too (a monitor loop must
 * not consume the mail a later turn should read). Exit 2 when `--wait` ran out.
 */
export async function agentInbox(deps: AgentDeps, options: InboxOptions): Promise<number> {
  const self = encodeURIComponent(deps.ctx.selfId);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${self}/inbox`,
    query: { wait: options.waitMs, peek: options.peek ? 1 : undefined },
    timeoutMs: (options.waitMs ?? 0) + 30_000,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | { messages?: InboxMessage[]; pending?: number; timedOut?: boolean; waitedMs?: number }
    | undefined;
  const messages = data?.messages ?? [];
  if (deps.json) emitJson(deps, data ?? {});
  else if (messages.length === 0) {
    // waitedMs is the APPLIED (clamped) budget; the requested one may have been 1 or 9e9.
    deps.io.err(
      palette.muted(data?.timedOut ? `(nothing arrived within ${data.waitedMs ?? options.waitMs} ms)` : '(inbox empty)')
    );
  } else {
    for (const m of messages) {
      deps.io.out(
        `${palette.emph(`from ${m.from.slice(0, 8)}`)} ${palette.muted(new Date(m.createdAt).toISOString())} ${palette.muted(`#${m.id.slice(0, 8)}`)}`
      );
      deps.io.out(m.text);
      deps.io.out('');
    }
  }
  if (messages.length === 0 && options.waitMs !== undefined) return EXIT.timeout;
  if (messages.length > 0 && !deps.json) {
    // The read is not the job: say so right in the tool output, where the receiver reads it.
    deps.io.err(
      palette.muted(
        options.peek
          ? `(peek: ${messages.length} message(s) left unread — no ack)`
          : `${messages.length} message(s) read, NOT acknowledged — handle them, reply with \`codeman agent post\`, then \`codeman agent ack\``
      )
    );
  }
  return EXIT.ok;
}

export interface AckOptions {
  /** Message ids to acknowledge; empty means "everything this session has read". */
  ids: string[];
}

/**
 * `agent ack [ids…]` — acknowledge mail this session read, removing it from the
 * mailbox. No ids acknowledges everything the read marked as seen; explicit ids
 * acknowledge a subset. This is the second half of `inbox`: reading alone leaves the
 * message pending, so an order that was read but not handled stays visible.
 */
export async function agentAck(deps: AgentDeps, options: AckOptions): Promise<number> {
  const self = encodeURIComponent(deps.ctx.selfId);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${self}/inbox/ack`,
    body: options.ids.length > 0 ? { ids: options.ids } : {},
  });
  if (!res.json?.success) return fail(deps, `could not acknowledge: ${describeFailure(res)}`);
  const data = res.json.data as { removed?: number; pending?: number } | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  else
    deps.io.out(
      palette.ok(`${GLYPH.ok} acknowledged ${data?.removed ?? 0} message(s) (${data?.pending ?? 0} still pending)`)
    );
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watch — which of my workers is waiting for input?
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchOptions {
  /** Sessions to watch; empty means this session's children (lineage). */
  ids: string[];
  /** The `cursor` of the previous answer; absent reports every finished turn. */
  since?: number;
  /** Block up to this long while nothing qualifies. */
  waitMs: number;
}

interface WatchRow {
  id: string;
  name: string;
  mode: string;
  status: string;
  turnEndedAt: number;
  turnEndSource: string | null;
  /** Why it stands, classified by the server; absent on a server before the reasons. */
  reason?: string;
  openTodos?: number;
  totalTodos?: number;
  inboxPending?: number;
  inboxUnseen?: number;
}

interface WatchAnswer {
  cursor: number;
  ended: WatchRow[];
  gone: string[];
  timedOut: boolean;
}

/** The ids to watch: the given ones (resolved like every id), else this session's children. */
async function watchTargets(deps: AgentDeps, ids: string[]): Promise<{ ids: string[] } | { error: string }> {
  if (ids.length > 0) {
    const resolved: string[] = [];
    for (const id of ids) {
      if (isSelfSession(deps.ctx.selfId, id))
        return { error: `refusing: ${id} is me — watch your workers, not yourself` };
      const target = await resolveSessionId(deps, id);
      if ('error' in target) return target;
      resolved.push(target.id);
    }
    return { ids: resolved };
  }
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return { error: describeFailure(res) };
  const children = ((res.json.data as SessionRow[] | undefined) ?? []).filter(
    (s) => s.parentSessionId === deps.ctx.selfId
  );
  if (children.length === 0) return { error: 'no workers to watch: this session spawned none — pass their ids' };
  return { ids: children.map((s) => s.id) };
}

/**
 * `agent watch` — block until one of the watched sessions has finished its turn (or
 * died), then print one line per such session and the cursor for the next call.
 *
 * Level-triggered: the server keeps "turn over since <t>" per session, so a turn that
 * ended while nobody was watching is still reported. Feed `--since <cursor>` back to
 * see only what ended after the previous answer. Exit 0 with hits, 2 on timeout.
 */
export async function agentWatch(deps: AgentDeps, options: WatchOptions): Promise<number> {
  const targets = await watchTargets(deps, options.ids);
  if ('error' in targets) return fail(deps, targets.error, EXIT.refused);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: '/api/v1/agent-watch',
    query: { sessions: targets.ids.join(','), since: options.since, wait: options.waitMs },
    timeoutMs: options.waitMs + 30_000,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as WatchAnswer;
  if (deps.json) {
    emitJson(deps, data);
  } else {
    for (const s of data.ended) {
      const what =
        s.reason === 'exited' || s.turnEndSource === 'exit' ? 'EXITED' : s.reason === 'blocked' ? 'BLOCKED' : 'IDLE';
      const facts =
        s.reason === undefined
          ? ''
          : `  ${s.reason}  todos ${s.openTodos ?? 0}/${s.totalTodos ?? 0}  inbox ${s.inboxPending ?? 0}`;
      deps.io.out(
        `${what}  ${s.id.slice(0, 8)}  ${s.mode}  since ${clockTime(new Date(s.turnEndedAt).toISOString())} (${s.turnEndSource ?? 'dialog'})${facts}  ${s.name}`
      );
    }
    for (const id of data.gone) deps.io.out(`GONE  ${id.slice(0, 8)}`);
    if (data.timedOut) deps.io.err(palette.muted(`(no turn ended within ${options.waitMs} ms)`));
    deps.io.out(`cursor ${data.cursor}`);
    deps.io.err(
      palette.muted(
        `next: codeman agent watch --since ${data.cursor}${options.ids.length ? ` ${options.ids.join(' ')}` : ''}`
      )
    );
  }
  return data.timedOut ? EXIT.timeout : EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Todos (the session's Ralph todo list)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ Nothing these verbs print may start with a todo glyph (☐ ☒ ◐ ✓ ✔) or a
// `- [ ]` checkbox: the output lands in the caller's own pane, where an enabled
// tracker would read `✓ added …` back as a second, parsed todo. Status is a word.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoRow {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: 'P0' | 'P1' | 'P2' | null;
  source?: 'agent';
}

const TODO_STATUS_WORD: Record<TodoStatus, string> = {
  pending: 'pending',
  in_progress: 'doing',
  completed: 'done',
};

/** The session a todo verb works on: `--session` (resolved like every id), else this one. */
async function todoTarget(
  deps: AgentDeps,
  session: string | undefined
): Promise<{ id: string } | { error: string; code: number }> {
  return session === undefined ? { id: deps.ctx.selfId } : resolveSessionId(deps, session);
}

async function fetchTodos(
  deps: AgentDeps,
  sessionId: string
): Promise<{ todos: TodoRow[]; stats?: Record<string, number> } | { error: string }> {
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/ralph-todos`,
  });
  if (!res.json?.success) return { error: describeFailure(res) };
  const data = res.json.data as { todos?: TodoRow[]; stats?: Record<string, number> } | undefined;
  return { todos: data?.todos ?? [], stats: data?.stats };
}

/**
 * Match what was typed against the list: the full id, the id without its `todo-`
 * prefix, or a unique prefix of either. Ambiguity refuses rather than picking one —
 * `done` on the wrong item is a lie the orchestrator then acts on.
 */
export function matchTodoId(todos: readonly TodoRow[], typed: string): { id: string } | { error: string } {
  const key = typed.trim();
  if (!key) return { error: 'refusing: empty todo id' };
  const exact = todos.find((t) => t.id === key || t.id === `todo-${key}`);
  if (exact) return { id: exact.id };
  const hits = todos.filter((t) => t.id.startsWith(key) || t.id.startsWith(`todo-${key}`));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length === 0) return { error: `no todo matches "${key}" (see \`agent todo ls\`)` };
  return { error: `"${key}" is ambiguous: ${hits.map((t) => t.id).join(', ')}` };
}

/** `agent todo ls` — the session's todo list, agent-set and parsed alike. */
export async function agentTodoLs(deps: AgentDeps, options: { session?: string } = {}): Promise<number> {
  const target = await todoTarget(deps, options.session);
  if ('error' in target) return fail(deps, target.error, target.code);
  const list = await fetchTodos(deps, target.id);
  if ('error' in list) return fail(deps, list.error);
  if (deps.json) {
    emitJson(deps, list);
    return EXIT.ok;
  }
  if (list.todos.length === 0) {
    deps.io.out(palette.muted('(no todos)'));
    return EXIT.ok;
  }
  const rows = list.todos.map((t) => [
    t.id,
    TODO_STATUS_WORD[t.status] ?? t.status,
    t.priority ?? '-',
    t.source === 'agent' ? 'agent' : 'output',
    t.content,
  ]);
  deps.io.out(table([['ID', 'STATUS', 'PRIO', 'FROM', 'TODO'], ...rows], { gap: 2 }));
  const done = list.todos.filter((t) => t.status === 'completed').length;
  deps.io.out(
    palette.muted(
      `${done}/${list.todos.length} done. FROM agent = set with \`agent todo\` (never expires); output = read off the terminal (expires after an hour without change).`
    )
  );
  return EXIT.ok;
}

export interface TodoAddOptions {
  session?: string;
  text: string;
  status?: TodoStatus;
  priority?: 'P0' | 'P1' | 'P2';
}

/** `agent todo add` — put an item on the list (re-adding the same text re-marks it). */
export async function agentTodoAdd(deps: AgentDeps, options: TodoAddOptions): Promise<number> {
  if (options.text.trim().length === 0) return fail(deps, 'refusing: empty todo', EXIT.refused);
  const target = await todoTarget(deps, options.session);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/ralph-todos`,
    body: {
      content: options.text,
      ...(options.status ? { status: options.status } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const todo = res.json.data as TodoRow;
  if (deps.json) emitJson(deps, todo);
  else deps.io.out(palette.ok(`added ${todo.id} (${TODO_STATUS_WORD[todo.status] ?? todo.status})`));
  return EXIT.ok;
}

/** `agent todo start|done|reopen` — set one item's status. */
export async function agentTodoSet(
  deps: AgentDeps,
  options: { session?: string; todo: string; status: TodoStatus }
): Promise<number> {
  const target = await todoTarget(deps, options.session);
  if ('error' in target) return fail(deps, target.error, target.code);
  const list = await fetchTodos(deps, target.id);
  if ('error' in list) return fail(deps, list.error);
  const match = matchTodoId(list.todos, options.todo);
  if ('error' in match) return fail(deps, match.error, EXIT.refused);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/ralph-todos/${encodeURIComponent(match.id)}`,
    body: { status: options.status },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const todo = res.json.data as TodoRow;
  if (deps.json) emitJson(deps, todo);
  else deps.io.out(palette.ok(`${todo.id} is now ${TODO_STATUS_WORD[todo.status] ?? todo.status}`));
  return EXIT.ok;
}

/** `agent todo rm` — take one item off the list. */
export async function agentTodoRm(deps: AgentDeps, options: { session?: string; todo: string }): Promise<number> {
  const target = await todoTarget(deps, options.session);
  if ('error' in target) return fail(deps, target.error, target.code);
  const list = await fetchTodos(deps, target.id);
  if ('error' in list) return fail(deps, list.error);
  const match = matchTodoId(list.todos, options.todo);
  if ('error' in match) return fail(deps, match.error, EXIT.refused);
  const res = await deps.request(deps.ctx, {
    method: 'DELETE',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/ralph-todos/${encodeURIComponent(match.id)}`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`removed ${match.id}`));
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commander wiring
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WAIT_MS = 60_000;

/** commander collector for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Whole stdin as text (for `post -` and heredocs). */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

/** Build deps from the live environment; the guard's message is the only thing a non-session caller sees. */
function liveDeps(json: boolean): AgentDeps | undefined {
  try {
    return {
      ctx: resolveAgentContext(),
      request: httpRequest,
      json,
      io: { out: (line) => console.log(line), err: (line) => console.error(line) },
    };
  } catch (err) {
    if (err instanceof AgentGuardError) {
      console.error(palette.err(`${GLYPH.fail} ${err.message}`));
      return undefined;
    }
    throw err;
  }
}

/** Run a verb with the live transport and turn its exit code into the process exit. */
async function run(json: boolean, verb: (deps: AgentDeps) => Promise<number>): Promise<void> {
  const deps = liveDeps(json);
  if (!deps) {
    process.exitCode = EXIT.refused;
    return;
  }
  try {
    process.exitCode = await verb(deps);
  } catch (err) {
    console.error(palette.err(`${GLYPH.fail} ${getErrorMessage(err)}`));
    process.exitCode = EXIT.error;
  }
}

/** Register `codeman agent …` on the program. */
export function registerAgentCommands(program: Command): Command {
  const agent = program
    .command('agent')
    .description(
      'Talk to other sessions from inside one (any CLI mode): list, spawn, send, wait, watch, read, interrupt, rm, post, inbox, todo'
    );

  agent
    .command('ls')
    .alias('list')
    .description('List sessions; * marks this one')
    .option(
      '--alive',
      'Probe every pane (wait until=exit, 1 s each, in parallel): DEAD means the worker exited. Columns INBOX (unread posts) and WAIT (parked on `inbox --wait` since) come from the mailbox; a footer names a waiting session whose parent/child is idle with an empty inbox'
    )
    .option('--json', 'Machine-readable output')
    .action((options: { alive?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentLs(deps, { alive: Boolean(options.alive) }))
    );

  agent
    .command('spawn <case>')
    .description(
      'Start a worker session in a case (created if missing) and wait for its composer where the mode draws one'
    )
    .option('-m, --mode <mode>', 'claude|opencode|codex|gemini|pi|deepseek|shell|…', 'claude')
    .option('-n, --name <name>', 'Session name shown in the UI')
    .option('--no-ready', 'Return as soon as the session exists, without the readiness wait')
    .option('-t, --timeout <ms>', 'Readiness budget in ms', String(DEFAULT_WAIT_MS))
    .option(
      '-e, --env <KEY=VALUE>',
      'Environment for the worker (repeatable; server allowlists OPENCODE_*, CODEX_*, … prefixes)',
      collect,
      []
    )
    .option(
      '--permission <allow|ask>',
      'opencode: bash+edit auto-approve (sets OPENCODE_PERMISSION) — a worker that stops on a dialog is a worker nobody answers'
    )
    .option(
      '--resume <cli-session-id>',
      'Continue that CLI conversation (opencode --session, codex resume, …); claude is not supported here'
    )
    .option('--json', 'Machine-readable output')
    .action(
      (
        caseName: string,
        options: {
          mode: string;
          name?: string;
          ready: boolean;
          timeout?: string;
          env: string[];
          permission?: string;
          resume?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) => {
          return agentSpawn(deps, {
            caseName,
            mode: options.mode,
            name: options.name,
            ready: options.ready,
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            env: options.env,
            permission: options.permission,
            resume: options.resume,
          });
        })
    );

  agent
    .command('restore [id]')
    .description(
      'Bring a session back: a live one whose pane died (respawned with its conversation), or a DELETED one (--last, rebuilt from the lifecycle log and resumed)'
    )
    .option('--last', 'Restore the most recently deleted session')
    .option(
      '--resume <cli-session-id>',
      'Re-attach exactly this CLI conversation instead of the last one in the directory'
    )
    .option('--json', 'Machine-readable output')
    .action((id: string | undefined, options: { last?: boolean; resume?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentRestore(deps, { id, last: Boolean(options.last), resume: options.resume })
      )
    );

  agent
    .command('send <id> <text...>')
    .description(
      'Type a prompt into another session and press Enter (ONE quoted argument, printable text only; a prompt that starts with "-" goes after --: send <id> -- "- fix the bug")'
    )
    .option('-w, --wait', 'Block until end of turn (the default signal set; see --until)')
    .option('-u, --until <signals>', 'Signals to wait for, comma list such as stop,exit (implies --wait)')
    .option('-t, --timeout <ms>', 'Wait budget in ms (with --wait)', String(DEFAULT_WAIT_MS))
    .option('--no-enter', 'Type the text without submitting it')
    .option('--client-id <id>', 'Exactly-once tag (default: one per calling session)')
    .option(
      '--seq <n>',
      'Sequence number for the tag (default: the current epoch ms). Must stay monotonic per client id: a reused or lower value is a silent duplicate, nothing is typed'
    )
    .option('--json', 'Machine-readable output')
    .action(
      (
        id: string,
        words: string[],
        options: {
          wait?: boolean;
          until?: string;
          timeout?: string;
          enter: boolean;
          clientId?: string;
          seq?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) => {
          const prompt = sendPromptFromArgs(words);
          if ('error' in prompt) return Promise.resolve(fail(deps, prompt.error, EXIT.refused));
          return agentSend(deps, {
            id,
            text: prompt.text,
            enter: options.enter,
            wait: options.until ?? (options.wait ? true : undefined),
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            clientId: options.clientId,
            seq: options.seq === undefined ? undefined : parsePositiveInt(options.seq, 1, '--seq'),
          });
        })
    );

  agent
    .command('wait <id>')
    .description(
      'Block until a signal (--until) or an output marker (--match) — timeout exits 2, a dead worker exits 3'
    )
    .option(
      '-u, --until <signals>',
      'Comma list: stop,idle,exit,working,blocked (stop/blocked are claude+deepseek only; the server says so with a 400)'
    )
    .option(
      '-m, --match <marker>',
      'Literal substring to wait for in the output (ANSI-stripped, no regex). The echo of your own prompt is output too, so never put the marker verbatim in the prompt: ask for it in halves ("print WORKDONE followed by _4711") and wait on the joined form (WORKDONE_4711)'
    )
    .option('--from <where>', 'buffer (scan existing output first, the default) or now', 'buffer')
    .option('--nocase', 'Case-insensitive --match')
    .option('--fresh', 'Require an actual transition (--until only)')
    .option('-t, --timeout <ms>', 'Budget in ms', String(DEFAULT_WAIT_MS))
    .option('--json', 'Machine-readable output')
    .action(
      (
        id: string,
        options: {
          until?: string;
          match?: string;
          from: string;
          nocase?: boolean;
          fresh?: boolean;
          timeout?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) =>
          agentWait(deps, {
            id,
            until: options.until,
            match: options.match,
            from: options.from === 'now' ? 'now' : 'buffer',
            nocase: options.nocase,
            fresh: options.fresh,
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
          })
        )
    );

  agent
    .command('read <id>')
    .description("Print a session's last answer (claude/codex/deepseek transcript) or, with --tail, its terminal")
    .option('--tail <bytes>', 'Raw terminal tail in bytes, ANSI stripped (works in every mode)')
    .option('--full', 'The whole conversation instead of the last assistant message')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { tail?: string; full?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentRead(deps, {
          id,
          tail: options.tail === undefined ? undefined : parsePositiveInt(options.tail, 3000, '--tail'),
          full: options.full,
        })
      )
    );

  agent
    .command('interrupt <id>')
    .description('Send a bare ESC to stop the current turn (the conversation survives; deleting would not)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentInterrupt(deps, { id }))
    );

  agent
    .command('rm <id>')
    .description('Delete any session except this one (refuses your own id)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentRm(deps, { id })));

  agent
    .command('post <id> [text...]')
    .description(
      "Leave a message in another session's mailbox; it reads it with `agent inbox`. An idle receiver that would never look gets one short nudge typed into its pane (--no-nudge: never). Text from stdin when omitted or `-`"
    )
    .option('--no-nudge', 'Store only; never type a nudge into the receiver')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, words: string[], options: { json?: boolean; nudge?: boolean }) => {
      const fromStdin = words.length === 0 || (words.length === 1 && words[0] === '-');
      // An agent's shell tool has a TTY on stdin: waiting for EOF there hangs the tool
      // until its own timeout. Only read stdin when something is actually piped in.
      if (fromStdin && process.stdin.isTTY) {
        console.error(
          palette.err(
            `${GLYPH.fail} no message text: pass it as arguments, or pipe it in (\`… | codeman agent post <id> -\`)`
          )
        );
        process.exitCode = EXIT.refused;
        return;
      }
      const text = fromStdin ? await readStdin() : words.join(' ');
      await run(Boolean(options.json), (deps) => agentPost(deps, { id, text, nudge: options.nudge }));
    });

  agent
    .command('inbox')
    .description(
      "Read this session's mailbox WITHOUT acknowledging; --wait blocks while it is empty (exit 2 on timeout)"
    )
    .option('-w, --wait <ms>', 'Block up to <ms> while the inbox is empty')
    .option('--peek', 'Read without even marking the mail as seen (for monitor loops)')
    .option('--json', 'Machine-readable output')
    .action((options: { wait?: string; peek?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentInbox(deps, {
          waitMs: options.wait === undefined ? undefined : parsePositiveInt(options.wait, 1, '--wait'),
          peek: Boolean(options.peek),
        })
      )
    );

  agent
    .command('ack [ids...]')
    .description(
      'Acknowledge mail this session has read (all of it, or just the given ids) — the second half of `inbox`'
    )
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentAck(deps, { ids }))
    );

  agent
    .command('watch [ids...]')
    .description(
      'Block until one of your workers (default: the sessions you spawned) has finished its turn, is stuck on a dialog, or died; prints IDLE/BLOCKED/EXITED/GONE lines with a reason (blocked, api-error, waiting-inbox, inbox-unread, inbox-unacked, open-todos, done) and a cursor — pass it back as --since to see only newer ones. Exit 2 on timeout'
    )
    .option('--since <cursor>', 'The cursor of the previous watch: report only turns that ended after it')
    .option('-t, --timeout <ms>', 'Wait budget in ms', String(DEFAULT_WAIT_MS))
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { since?: string; timeout?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentWatch(deps, {
          ids,
          since: options.since === undefined ? undefined : parsePositiveInt(options.since, 0, '--since'),
          waitMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
        })
      )
    );

  registerTodoCommands(agent);

  return agent;
}

const SESSION_FLAG = ['-s, --session <id>', "Another session's list (default: this session's)"] as const;

/** `codeman agent todo …` — the session's Ralph todo list (the panel in the web UI). */
function registerTodoCommands(agent: Command): void {
  const todo = agent
    .command('todo')
    .description(
      "This session's todo list, shown in the web UI's Ralph panel: ls, add, start, done, reopen, rm. Items you add never expire; --session works on another session's list"
    );

  todo
    .command('ls', { isDefault: true })
    .alias('list')
    .description('List the todos (agent-set and those read off the terminal)')
    .option(...SESSION_FLAG)
    .option('--json', 'Machine-readable output')
    .action((options: { session?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentTodoLs(deps, { session: options.session }))
    );

  todo
    .command('add <text...>')
    .description('Add a todo (pending unless --start); the same text again only re-marks it')
    .option('--start', 'Add it as in progress')
    .option('-p, --priority <P0|P1|P2>', 'Priority (default: read from the text, e.g. "critical")')
    .option(...SESSION_FLAG)
    .option('--json', 'Machine-readable output')
    .action((words: string[], options: { start?: boolean; priority?: string; session?: string; json?: boolean }) => {
      const priority = options.priority?.toUpperCase();
      if (priority !== undefined && priority !== 'P0' && priority !== 'P1' && priority !== 'P2') {
        console.error(palette.err(`${GLYPH.fail} --priority must be P0, P1 or P2`));
        process.exitCode = EXIT.refused;
        return;
      }
      return run(Boolean(options.json), (deps) =>
        agentTodoAdd(deps, {
          session: options.session,
          text: words.join(' '),
          status: options.start ? 'in_progress' : undefined,
          priority,
        })
      );
    });

  const setters: [verb: string, status: TodoStatus, description: string][] = [
    ['start', 'in_progress', 'Mark a todo as in progress'],
    ['done', 'completed', 'Mark a todo as done'],
    ['reopen', 'pending', 'Mark a todo as pending again'],
  ];
  for (const [verb, status, description] of setters) {
    todo
      .command(`${verb} <todo-id>`)
      .description(`${description} (full id, or a unique prefix as \`ls\` prints it)`)
      .option(...SESSION_FLAG)
      .option('--json', 'Machine-readable output')
      .action((id: string, options: { session?: string; json?: boolean }) =>
        run(Boolean(options.json), (deps) => agentTodoSet(deps, { session: options.session, todo: id, status }))
      );
  }

  todo
    .command('rm <todo-id>')
    .description('Remove a todo')
    .option(...SESSION_FLAG)
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { session?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentTodoRm(deps, { session: options.session, todo: id }))
    );
}
