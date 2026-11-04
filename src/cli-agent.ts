/**
 * @fileoverview `codeman agent …` — session-to-session verbs for the agent running
 * inside a Codeman session, in every CLI mode.
 *
 * A thin HTTP client over the server's endpoints (`quick-start` for a named
 * case, `POST sessions` + `sessions/:id/interactive|shell` for a worker in an
 * existing directory, `input`, `wait`, `wait-output`, `last-response`, `terminal`,
 * `DELETE sessions/:id`, the agent inbox: `inbox`, `inbox/ack`,
 * `agent-inbox/summary`, and the experimental, opt-in
 * `inspect`/`stage`/`submit` of `web/routes/agent-session-routes.ts`, which answer 403
 * until `agentCoordinationEnabled` is on; that refusal is printed verbatim). It uses no
 * transport of its own: everything goes through `CODEMAN_API_URL`, so auth, ownership
 * and the per-session waiter cap apply unchanged. The behaviour is
 * the packaged agent skill's (`skills/codeman`), ported from shell prose into code
 * with tests, so a `codex`/`opencode`/`pi` agent — which never gets the claude-only
 * preamble — has the same verbs from one line in its AGENTS.md.
 *
 * Invariants (each asserted in `test/cli-agent.test.ts` or
 * `test/cli-agent-project-spawn.test.ts`):
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
 * 5. `spawn` without a case starts the worker in an existing directory (cwd, or
 *    `--working-dir`) via `POST sessions` + `interactive|shell`, without the
 *    `X-Codeman-Agent-Origin` header, so no agent-case marker is written. It refuses
 *    (exit 4, before any request) an empty `--working-dir` and a bare spawn from a
 *    HOME cwd: it always sends an explicit `workingDir`, so the server's skip of
 *    workspace hooks for a request that names none cannot protect `~/.claude`.
 *
 * Commands live here as functions returning an exit code, not calling
 * `process.exit`, so the whole surface is unit-testable against a fake server.
 *
 * @module cli-agent
 */
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { statSync, writeFileSync } from 'node:fs';
import { join as joinPath, posix as posixPath, resolve as resolvePath } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { STAGE_MAX_BYTES } from './agent-staging.js';
import { INSPECT_MAX_BYTES } from './agent-inspection.js';
import type { Command } from 'commander';
import {
  basicAuthHeader,
  credentialsFrom,
  readCodemanEnvFile,
  type CodemanCredentials,
} from './codeman-credentials.js';
import { getCli } from './config/cli-registry/registry.js';
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
  auth?: CodemanCredentials;
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
 * Resolve the context from the environment, or throw `AgentGuardError`.
 *
 * Credentials in the order every client of the API uses (`credentialsFrom`, shared
 * with `codeman attach` and the TUI): each field from the environment (a session
 * inherits the server's), then the data dir's `.env`. No password means the server
 * is open (single-user) — or it is not, and the 401 says so.
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
  const credentials = credentialsFrom(env, envFile());
  return { apiUrl, selfId, auth: credentials.password ? credentials : undefined };
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
 * Why `send` refuses this text, or `undefined` when it is printable. A line break is
 * refused for the reason below; everything else below 0x20 (and DEL) reaches the pane
 * as a keypress. None of that is a prompt.
 */
export function inputRefusal(text: string): string | undefined {
  if (text.length === 0) return 'refusing: empty input (use `interrupt` for ESC, `send <id> ""` is never a prompt)';
  // The server pastes a multi-line prompt as one block, but the check that re-presses
  // a stranded Enter cannot reliably recognise that block in the composer, so a wait
  // could burn its timeout on a prompt that never went out. A tab reaches the pane as
  // a keypress (claude: mode toggle).
  if (/[\n\r\t]/.test(text)) {
    return 'refusing: input must be a single line (a multi-line paste cannot be confirmed as submitted) — join them yourself, or write a file into the workspace and send its path';
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

/**
 * Inbox message text for a terminal. Another session wrote it, so an escape sequence
 * in it would otherwise reach the reader's terminal (retitle it, or move the cursor
 * over the `from` line above it). ANSI sequences go as in `read --tail`, and every
 * control character left (C0 other than newline and tab, DEL, C1) is shown as `\xHH`,
 * so a bare `\r` or backspace cannot overwrite the header either. A CRLF line end
 * stays a line end. `--json` prints the text as stored.
 */
export function terminalSafeText(text: string): string {
  return (
    stripAnsi(text.replace(/\r\n/g, '\n'))
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  );
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
  /** The raw response bytes, for binary bodies (`agent pull`); `text` is their UTF-8 decoding. */
  body?: Buffer;
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
  /** Aborts the request (an MCP client cancelling a long wait); the promise rejects. */
  signal?: AbortSignal;
}

export type ApiRequest = (ctx: AgentContext, options: RequestOptions) => Promise<ApiResponse>;

/** Every request carries these; they are ignored on endpoints that do not read them. */
export function baseHeaders(ctx: AgentContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Tags sessions this caller spawns as its children (lineage in the web UI).
  // Cosmetic, never fails a call. NOT X-Codeman-Agent-Origin: that one marks a case
  // directory as deletable agent scratch, so it rides only the spawn request that
  // may create one (see agentSpawn), never anything else. Absent for a caller outside
  // any session (`codeman mcp` launched by a desktop MCP client, or the root `codeman session restore`),
  // which has no self.
  if (ctx.selfId) headers['X-Codeman-Parent-Session'] = ctx.selfId;
  const authorization = ctx.auth ? basicAuthHeader(ctx.auth) : undefined;
  if (authorization) headers.Authorization = authorization;
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
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        // A connection dropped mid-body emits 'error' and never 'end'; without this the
        // promise never settles (and a long-lived `codeman mcp` never answers the call).
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf-8');
          let json: ApiEnvelope | undefined;
          try {
            json = JSON.parse(text) as ApiEnvelope;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text, body });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${options.timeoutMs ?? 30_000} ms`)));
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
};

/**
 * One line describing a thrown request error. Node 22 rejects a refused connection to a host
 * that resolves to both ::1 and 127.0.0.1 with an AggregateError whose `message` is empty, so
 * fall back to its `code` (ECONNREFUSED) before a generic line rather than printing nothing.
 */
export function describeRequestError(error: unknown): string {
  const message = getErrorMessage(error);
  if (message) return message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code ? String(code) : 'request failed without a message';
}

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

/**
 * Print `data` as JSON (the `--json` path): the envelope's `data`, never a reshaped copy,
 * except a directory spawn, which prints `{ sessionId, workingDir, created: true }` plus
 * `ready` when a readiness wait ran, `readinessError` when that call failed, and
 * `startupError` when its start fails, because `POST /api/sessions` answers with the
 * whole session row.
 */
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
  /** Present only for a session that runs on another host / in a container. */
  remote?: unknown;
  docker?: unknown;
  pid?: number | null;
  parentSessionId?: string | null;
  /** Wall-clock ms the last turn ended; null while one runs. Absent on older servers. */
  turnEndedAt?: number | null;
  turnEndSource?: string | null;
  ralphTodoStats?: { total: number; pending: number; inProgress: number; completed: number };
  /** What the server knows of the running model (`src/session-display-model.ts`); absent when nothing is known. */
  displayModel?: { model?: string; source?: string };
  /** The model the session was started with (`--model`); absent without one. */
  model?: string;
}

/**
 * The MODEL column: what the CLI reports (claude's statusline, or a remote claude's
 * transcript at each turn end; both follow `/model`), else what it was started with
 * marked `*` — a start value says nothing about a later `/model` — else `-`.
 */
export function modelCell(s: Pick<SessionRow, 'displayModel' | 'model'>): string {
  const reported = s.displayModel?.model?.trim();
  const startOnly = !reported || s.displayModel?.source === 'launch';
  const name = (reported || s.model?.trim())?.replace(/\s*\(1M context\)$/i, ' 1M');
  if (!name) return '-';
  const mark = startOnly ? '*' : '';
  // A custom endpoint's model id runs to 64 chars and would push every column right.
  const room = MODEL_CELL_MAX - mark.length;
  return (name.length > room ? `${name.slice(0, room - 1)}…` : name) + mark;
}

/** Widest MODEL cell; `--json` carries the full name. */
const MODEL_CELL_MAX = 24;

/** Where a session runs: `local`, its remote host id, or `docker`. */
function hostCell(s: SessionRow): string {
  const hostId = (s.remote as { hostId?: unknown } | undefined)?.hostId;
  if (typeof hostId === 'string' && hostId) return hostId;
  return s.remote ? 'remote' : s.docker ? 'docker' : 'local';
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

/** One session's row in `GET /api/agent-inbox/summary`. */
export interface InboxSummaryRow {
  pending: number;
  unseen: number;
  oldestUnseenAt: number | null;
  parked: boolean;
  /** Downstream server only: since when the receiver is parked (epoch ms). Absent upstream. */
  parkedSince?: number | null;
}

/**
 * The inbox summary, or null when it cannot be had (a server without the route, a
 * transient error): the columns then read `?` and the stalled-pair footer stays silent —
 * never a failure, `ls` is the one verb that must always answer.
 */
async function fetchInboxSummary(deps: AgentDeps): Promise<Map<string, InboxSummaryRow> | null> {
  try {
    const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/agent-inbox/summary' });
    if (!res.json?.success) return null;
    const sessions = (res.json.data as { sessions?: Record<string, InboxSummaryRow> } | undefined)?.sessions;
    return new Map(Object.entries(sessions ?? {}));
  } catch {
    return null;
  }
}

/** The empty row: a session the summary leaves out has no mail and is not parked. */
const EMPTY_INBOX: InboxSummaryRow = { pending: 0, unseen: 0, oldestUnseenAt: null, parked: false, parkedSince: null };

/** The INBOX cell of `ls`: `3 (1 new)`, `3`, `0`. Parking has its own WAIT column. */
export function inboxCell(row: InboxSummaryRow | undefined): string {
  const r = row ?? EMPTY_INBOX;
  return r.unseen > 0 ? `${r.pending} (${r.unseen} new)` : String(r.pending);
}

/** The WAIT cell: `since HH:MM` while parked on `inbox --wait`, `parked` without a time, else `-`. */
export function waitCell(row: InboxSummaryRow | undefined): string {
  if (!row?.parked) return '-';
  return row.parkedSince ? `since ${clockTime(new Date(row.parkedSince).toISOString())}` : 'parked';
}

/** `HH:MM` local time of an ISO stamp, for the WAIT column. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Stalled pairs: a session parked on its inbox whose parent or child is idle with an
 * empty inbox. Nobody is working and nobody has mail — one of them owes the other a
 * post. A heuristic over the UI status (which is a hint, so the line says "looks
 * like"), pinned because exactly this shape cost a planner/builder pair 26 minutes
 * with nothing on any screen. Returns one line per parked session, oldest wait first.
 */
export function stalledPairLines(sessions: SessionRow[], summary: Map<string, InboxSummaryRow>): string[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const label = (s: SessionRow) => `${s.id.slice(0, 8)}${s.name ? ` (${s.name})` : ''}`;
  const idleAndEmpty = (s: SessionRow) => s.status === 'idle' && (summary.get(s.id)?.pending ?? 0) === 0;
  const lines: Array<{ since: number; text: string }> = [];
  for (const s of sessions) {
    const entry = summary.get(s.id);
    if (!entry?.parked) continue;
    const peers: SessionRow[] = [];
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    if (parent) peers.push(parent);
    for (const other of sessions) if (other.parentSessionId === s.id) peers.push(other);
    const stalled = peers.filter(idleAndEmpty);
    if (stalled.length === 0) continue;
    const since = entry.parkedSince ?? Number.MAX_SAFE_INTEGER;
    const when = entry.parkedSince ? ` since ${clockTime(new Date(entry.parkedSince).toISOString())}` : '';
    lines.push({
      since,
      text: `${GLYPH.warn} ${label(s)} waits for mail${when}; ${stalled
        .map(label)
        .join(', ')} ${stalled.length === 1 ? 'is' : 'are'} idle with an empty inbox — looks like someone owes a post`,
    });
  }
  return lines.sort((a, b) => a.since - b.since).map((l) => l.text);
}

/** The SUB column: `me`, `me+2`, `2` (others only), `-` nobody; `?` on a server without subscriptions. */
function subCell(subs: Map<string, string[]> | null, id: string, selfId: string): string {
  if (!subs) return '?';
  const list = subs.get(id) ?? [];
  const others = list.filter((sub) => sub !== selfId).length;
  if (list.includes(selfId)) return others > 0 ? `me+${others}` : 'me';
  return others > 0 ? String(others) : '-';
}

/** `agent ls` — every session the caller can see, self marked; `--alive` probes each pane. */
export async function agentLs(deps: AgentDeps, options: { alive?: boolean } = {}): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const sessions = (res.json.data as SessionRow[] | undefined) ?? [];
  const alive = new Map<string, 'alive' | 'dead' | 'unknown'>();
  const [summary, subs] = await Promise.all([
    fetchInboxSummary(deps),
    fetchSubscriptions(deps),
    // One short probe per session, in parallel: `status` says busy for a corpse.
    options.alive ? Promise.all(sessions.map(async (s) => alive.set(s.id, await probeAlive(deps, s.id)))) : null,
  ]);
  const inboxOf = (id: string): InboxSummaryRow | null => (summary ? (summary.get(id) ?? EMPTY_INBOX) : null);
  if (deps.json) {
    emitJson(
      deps,
      sessions.map((s) => ({
        ...s,
        self: isSelfSession(deps.ctx.selfId, s.id),
        ...(options.alive ? { pane: alive.get(s.id) } : {}),
        inbox: inboxOf(s.id),
        subscribers: subs ? (subs.get(s.id) ?? []) : null,
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
      modelCell(s),
      hostCell(s),
      s.status ?? '?',
      ...(options.alive ? [alive.get(s.id) === 'dead' ? 'DEAD' : (alive.get(s.id) ?? '?')] : []),
      inbox ? inboxCell(inbox) : '?',
      inbox ? waitCell(inbox) : '?',
      s.turnEndedAt ? clockTime(new Date(s.turnEndedAt).toISOString()) : '-',
      todoCell(s.ralphTodoStats),
      subCell(subs, s.id, deps.ctx.selfId),
      s.name || s.workingDir || '',
    ];
  });
  const header = [
    ' ',
    'ID',
    'MODE',
    'MODEL',
    'HOST',
    'STATUS',
    ...(options.alive ? ['PANE'] : []),
    'INBOX',
    'WAIT',
    'ENDED',
    'TODO',
    'SUB',
    'NAME',
  ];
  deps.io.out(table([header, ...rows], { gap: 2 }));
  deps.io.out(
    palette.muted(
      `* = this session (${deps.ctx.selfId.slice(0, 8)}). MODEL = what the CLI reports (follows /model); * = only the start value, nothing reported yet; - = unknown. HOST = where the worker runs (\`agent hosts\`). status is a UI hint, never a sync signal. INBOX = unread posts, WAIT = parked on \`inbox --wait\` since, ENDED = last turn over at (- = a turn runs), TODO = open/total on its \`agent todo\` list. SUB = who gets its IDLE/BLOCKED/EXITED reports: me (+n others), n others, - nobody (\`agent subscribe <id>\` / \`unsubscribe <id>\`).`
    )
  );
  if (summary) for (const line of stalledPairLines(sessions, summary)) deps.io.out(palette.warn(line));
  return EXIT.ok;
}

export interface SpawnOptions {
  /** A case (quick-start, created if missing). Absent: a directory — `cwd`, else this shell's. */
  caseName?: string;
  /** Working directory for the worker (resolved against this process's cwd); excludes `caseName`. */
  cwd?: string;
  /** Upstream's name for `cwd` (`--working-dir`); `cwd` wins when both are given. */
  workingDir?: string;
  /** A remote host id (`agent hosts`): `cwd` is then an absolute path ON that host, reached through a remote case. */
  host?: string;
  /** Model for this worker only; absent = the standard model (app default, else the CLI's own). */
  model?: string;
  mode: string;
  name?: string;
  /** Wait for the composer before returning, where the registry gives the mode a ready mark. */
  ready: boolean;
  timeoutMs: number;
  /** `KEY=VALUE` pairs → quick-start `envOverrides` (the server allowlists the prefixes). */
  env?: string[];
  /** opencode only: writes `OPENCODE_PERMISSION` so the worker never stops on a bash/edit dialog. Validated here, not in commander, so a bad value is a `refused` exit with the JSON envelope. */
  permission?: string;
  /** Continue an existing CLI conversation (the CLI's own session id, not Codeman's). */
  resume?: string;
  /** Subscribe this session to the worker's reports right after the spawn (reports are opt-in). */
  subscribe?: boolean;
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

/**
 * Where `--model` goes for this mode, from the registry's `capabilities.model`: claude takes
 * the per-session top-level `model` (`claude --model`, nothing written to disk — never
 * `modelOverride`, which rewrites the directory's settings file and so the model of every
 * session there, the parent's included); a `flag` CLI takes it in its own config object;
 * `none` (shell, deepseek) has no model to set.
 */
export function modelFields(mode: string, model: string): Record<string, unknown> {
  const entry = getCli(mode);
  const source = entry?.capabilities.model;
  if (source?.source === 'claude-settings-file') return { model };
  const configField = entry?.launch.legacyConfigField;
  if (source?.source === 'flag' && configField) {
    const param = source.param ?? 'model';
    return { [configField]: { [entry.launch.legacyConfigAliases?.[param] ?? param]: model } };
  }
  throw new Error(`--model is not available for mode "${mode}" (it has no model to set)`);
}

/** Extra quick-start body from the spawn options; throws on a combination the server would refuse. */
export function buildSpawnExtras(options: SpawnOptions): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (options.model !== undefined) Object.assign(extras, modelFields(options.mode, options.model));
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
 * Agent-scratch label for a case directory a spawn CREATES (the server applies it only
 * when quick-start makes the directory). The Add Case UI offers a recursive delete for
 * such directories, so this header must never ride any other request: mislabelling a
 * real repo there is the one failure in this area that costs actual work.
 */
export const AGENT_ORIGIN_HEADER = { 'X-Codeman-Agent-Origin': 'codeman-agent-cli' } as const;

/**
 * What the mode's TUI draws once its composer can take a prompt, from the CLI registry
 * (`capabilities.composerReadyMark`); undefined means the mode has no readiness wait.
 */
export function composerReadyMark(mode: string): string | undefined {
  return getCli(mode)?.capabilities.composerReadyMark;
}
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

/**
 * Where an un-placed worker starts: this shell's directory, as upstream does.
 *
 * Downstream guard: only when this CLI runs on the server's own host. A remote session's
 * CLI (and a container's) talks to the server through a non-loopback `CODEMAN_API_URL`
 * (`remoteAgentEnvPrefix`, `containerApiUrl`), and its cwd is a path on ANOTHER machine —
 * Hufflepuff's /home/joe/… exists on Albus too, so a local worker there would start on the
 * wrong host without any error. Decided from the URL, so no request is spent on it.
 */
function implicitWorkingDir(deps: AgentDeps): { dir: string } | { error: string } {
  if (!isLoopbackApiUrl(deps.ctx.apiUrl)) {
    return {
      error:
        'refusing: this session does not run on the Codeman host (remote or container), so its directory is not a local path — spawn into its case or pass --cwd',
    };
  }
  return { dir: resolvePath(process.cwd()) };
}

/** `CODEMAN_API_URL` points at this machine (a local session's pane). */
export function isLoopbackApiUrl(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Create + start a worker in an existing directory (`POST /sessions` + the mode's start
 * route, the skill's way for a path that is not a case). As upstream: once created, the
 * session is never retried, deleted or hidden — a refused start and one that failed in
 * transit (ambiguous: the pane may run) both come back with the exact id.
 */
async function spawnInDirectory(
  deps: AgentDeps,
  options: SpawnOptions,
  workingDir: string,
  extras: Record<string, unknown>
): Promise<
  { sessionId: string } | { sessionId: string; startupError: string; ambiguous: boolean } | { error: string }
> {
  const body: Record<string, unknown> = { workingDir, mode: options.mode, parentSessionId: deps.ctx.selfId };
  if (options.name) body.name = options.name;
  mergeSpawnBody(body, SPAWN_BODY_BY_MODE[options.mode] ?? {});
  mergeSpawnBody(body, extras);
  const created = await deps.request(deps.ctx, { method: 'POST', path: '/api/v1/sessions', body });
  const sid = (created.json?.data as { session?: { id?: string } } | undefined)?.session?.id;
  if (!created.json?.success || !sid) return { error: describeFailure(created) };
  // The registry names the start route (`interactive`, or `shell` for a shell mode).
  const startMode = getCli(options.mode)?.capabilities.startMode ?? 'interactive';
  let started: Awaited<ReturnType<AgentDeps['request']>>;
  try {
    started = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/v1/sessions/${encodeURIComponent(sid)}/${startMode}`,
      body: {},
    });
  } catch (error) {
    return { sessionId: sid, startupError: getErrorMessage(error) || 'Startup request failed', ambiguous: true };
  }
  if (!started.json?.success) return { sessionId: sid, startupError: describeFailure(started), ambiguous: false };
  return { sessionId: sid };
}

/** Per-mode config objects merge (deepseek's permission posture + a resume id or model both live in deepSeekConfig); everything else overrides. */
function mergeSpawnBody(body: Record<string, unknown>, extras: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extras)) {
    const existing = body[key];
    body[key] =
      existing && typeof existing === 'object' && value && typeof value === 'object'
        ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
}

/** realpath, or the plain resolved path when it cannot be resolved; never throws. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether `directory` is the user's home directory, comparing realpaths so a symlinked
 * HOME (or a cwd reached through a symlink) still matches. False when HOME is unknown.
 */
export async function isHomeDirectory(directory: string): Promise<boolean> {
  let home: string;
  try {
    home = homedir();
  } catch {
    return false;
  }
  if (!home) return false;
  const [a, b] = await Promise.all([canonicalPath(directory), canonicalPath(home)]);
  return a === b;
}

/**
 * `agent spawn [case]` — a worker with lineage, then the readiness ladder where the mode has
 * one. Where it starts: a case (quick-start, created if missing), else `--cwd`, else the
 * directory of the session that spawns it — a coordinator's workers work where it works.
 */
export async function agentSpawn(deps: AgentDeps, options: SpawnOptions): Promise<number> {
  if (!getCli(options.mode)) return fail(deps, `Unknown mode: ${options.mode}`, EXIT.refused);
  const explicitDir = options.cwd ?? options.workingDir;
  if (options.caseName !== undefined && explicitDir !== undefined) {
    return fail(deps, 'refusing: a case and --cwd both place the worker — pass one of them', EXIT.refused);
  }
  // `--cwd "$WT"` with WT empty (a failed `git worktree add`) must not fall through to the
  // shell's cwd, which `resolve('')` would make it.
  if (explicitDir !== undefined && explicitDir.trim() === '') {
    return fail(
      deps,
      `refusing: ${spawnDirFlag(options)} is empty; pass an existing directory or omit the flag`,
      EXIT.refused
    );
  }
  let extras: Record<string, unknown>;
  try {
    extras = buildSpawnExtras(options);
  } catch (err) {
    return fail(deps, getErrorMessage(err), EXIT.refused);
  }

  let sid: string;
  let data: Record<string, unknown>;
  let where: string;
  if (options.host !== undefined) {
    const remote = await resolveRemoteCase(deps, { ...options, cwd: explicitDir });
    if ('refused' in remote) return fail(deps, remote.refused, EXIT.refused);
    if ('error' in remote) return fail(deps, remote.error);
    const quick = await spawnInCase(deps, { ...options, caseName: remote.caseName }, extras);
    if ('error' in quick) return fail(deps, quick.error);
    sid = quick.sessionId;
    data = { ...quick.data, hostId: options.host, remotePath: remote.remotePath, caseCreated: remote.created };
    where = `${options.host}:${remote.remotePath}, ${remote.created ? 'new ' : ''}case ${remote.caseName}`;
  } else if (options.caseName === undefined) {
    const dir = explicitDir !== undefined ? { dir: resolvePath(explicitDir) } : implicitWorkingDir(deps);
    if ('error' in dir) return fail(deps, dir.error, EXIT.refused);
    const refused = await checkLocalWorkingDir(dir.dir, explicitDir !== undefined);
    if (refused) return fail(deps, refused, EXIT.refused);
    const spawned = await spawnInDirectory(deps, options, dir.dir, extras);
    if ('startupError' in spawned) {
      // Created, but not started (refused, or failed in transit so the pane may or may not
      // run). Report the exact id; never retry a start or hide the tab.
      if (deps.json) {
        emitJson(deps, {
          sessionId: spawned.sessionId,
          workingDir: dir.dir,
          created: true,
          ready: false,
          startupError: spawned.startupError,
        });
      } else deps.io.out(spawned.sessionId);
      deps.io.err(
        `Session ${spawned.sessionId} was created but startup ${spawned.ambiguous ? 'is ambiguous' : 'failed'}: ${spawned.startupError}`
      );
      return EXIT.error;
    }
    if ('error' in spawned) return fail(deps, spawned.error);
    sid = spawned.sessionId;
    data = { sessionId: sid, workingDir: dir.dir, created: true };
    where = `dir ${dir.dir}`;
  } else {
    const quick = await spawnInCase(deps, options, extras);
    if ('error' in quick) return fail(deps, quick.error);
    sid = quick.sessionId;
    data = quick.data;
    where = `case ${(quick.data.caseName as string | undefined) ?? options.caseName}`;
  }
  return finishSpawn(deps, options, sid, data, where);
}

/** The directory flag as the caller spelled it (`--working-dir` is upstream's, `--cwd` ours). */
function spawnDirFlag(options: SpawnOptions): string {
  return options.cwd === undefined && options.workingDir !== undefined ? '--working-dir' : '--cwd';
}

/**
 * Refusal text for a local worker directory, or undefined when it is fine: no control
 * characters, an existing directory, and not HOME unless named explicitly. The server
 * installs workspace hooks (and, with agent skill injection on, the skill) into the
 * directory it is given, so an implicit HOME (the cwd fallback) would write
 * ~/.claude/settings.local.json and ~/.claude/skills. An explicit `--cwd ~` stays.
 */
async function checkLocalWorkingDir(dir: string, explicit: boolean): Promise<string | undefined> {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(dir)) return 'refusing: the working directory contains control characters';
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    return `refusing: ${dir} is not an existing local directory`;
  }
  if (!explicit && (await isHomeDirectory(dir))) {
    return 'refusing: the current directory is your home directory; pass --working-dir ~ (or --cwd ~) to start a worker there on purpose';
  }
  return undefined;
}

/** A remote host as `GET /api/remote-hosts` lists it (only the fields the CLI shows). */
interface RemoteHostRow {
  id: string;
  label?: string;
  host?: string;
  username?: string;
  port?: number;
  wakeMac?: string | string[];
  wakeCommand?: string;
}

/** A case as `GET /api/cases` lists it; `remote` only on a remote case. */
interface CaseRow {
  name: string;
  location?: string;
  remote?: { hostId: string; path: string };
}

/** `/a/b/` → `/a/b`, `/a//b/./c` → `/a/b/c`: the form a remote case is matched and stored in. */
export function normalizeRemotePath(path: string): string {
  const normalized = posixPath.normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * Name for a remote case `spawn --host` creates: `<host>-<last path segment>`, reduced to
 * the characters a case name allows, `-2`, `-3`, … while the name is taken by ANY case
 * (local, linked, remote, docker share one namespace in the UI).
 */
export function remoteCaseName(hostId: string, remotePath: string, taken: ReadonlySet<string>): string {
  const segment = posixPath.basename(remotePath) || 'root';
  const base = `${hostId}-${segment}`
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

async function fetchRemoteHosts(deps: AgentDeps): Promise<RemoteHostRow[] | { error: string }> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/remote-hosts' });
  if (!res.json?.success) return { error: describeFailure(res) };
  return (res.json.data as RemoteHostRow[] | undefined) ?? [];
}

async function fetchCases(deps: AgentDeps): Promise<CaseRow[] | { error: string }> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/cases' });
  if (!res.json?.success) return { error: describeFailure(res) };
  return (res.json.data as CaseRow[] | undefined) ?? [];
}

/**
 * `spawn --host <id> --cwd <path>` → the remote case that runs there: an existing one with
 * the same host and directory, else a new one via `remote-link` (which wakes a sleeping host
 * and checks the directory exists). Remote sessions only start through a case, so this is
 * the whole of "start a worker on another machine".
 */
async function resolveRemoteCase(
  deps: AgentDeps,
  options: SpawnOptions
): Promise<{ caseName: string; remotePath: string; created: boolean } | { refused: string } | { error: string }> {
  const hostId = options.host as string;
  if (options.caseName !== undefined) {
    return { refused: 'refusing: --host places the worker by --cwd — pass the directory, not a case' };
  }
  if (options.cwd === undefined) {
    return {
      refused: `refusing: --host needs --cwd <absolute path on ${hostId}> (\`agent hosts\` lists known directories)`,
    };
  }
  if (!options.cwd.startsWith('/')) {
    return {
      refused: `refusing: --cwd must be an absolute path on ${hostId} (got ${options.cwd}; ~ and relative paths would resolve on THIS machine)`,
    };
  }
  const remotePath = normalizeRemotePath(options.cwd);

  const [hosts, cases] = await Promise.all([fetchRemoteHosts(deps), fetchCases(deps)]);
  if ('error' in hosts) return hosts;
  if ('error' in cases) return cases;
  if (!hosts.some((h) => h.id === hostId)) {
    const known = hosts.map((h) => h.id).join(', ');
    return { refused: `refusing: no remote host "${hostId}" (known: ${known || 'none — add one in the web UI'})` };
  }
  const caseFor = (list: CaseRow[]) =>
    list.find((c) => c.remote?.hostId === hostId && normalizeRemotePath(c.remote.path) === remotePath);
  const existing = caseFor(cases);
  if (existing) return { caseName: existing.name, remotePath, created: false };

  const name = remoteCaseName(hostId, remotePath, new Set(cases.map((c) => c.name)));
  const linked = await deps.request(deps.ctx, {
    method: 'POST',
    path: '/api/v1/cases/remote-link',
    body: { name, hostId, remotePath },
    // ssh probes (tmux, directory) after a possible wake: give it the wake budget.
    timeoutMs: REMOTE_LINK_TIMEOUT_MS,
  });
  if (linked.json?.success) return { caseName: name, remotePath, created: true };
  // A parallel spawn into the same new directory (a batch of workers) linked it first:
  // its case is the one to use, not an error.
  if (linked.json?.errorCode === 'ALREADY_EXISTS') {
    const again = await fetchCases(deps);
    const raced = 'error' in again ? undefined : caseFor(again);
    if (raced) return { caseName: raced.name, remotePath, created: false };
  }
  return { error: `could not create a case for ${hostId}:${remotePath}: ${describeFailure(linked)}` };
}

/** Wake (40 s) + tmux and directory probes (15 s each) + slack. */
const REMOTE_LINK_TIMEOUT_MS = 90_000;

/** `agent hosts` — the remote hosts a worker can be spawned on, and the directories that already have a case. */
export async function agentHosts(deps: AgentDeps): Promise<number> {
  const [hosts, cases] = await Promise.all([fetchRemoteHosts(deps), fetchCases(deps)]);
  if ('error' in hosts) return fail(deps, hosts.error);
  if ('error' in cases) return fail(deps, cases.error);
  const casesOf = (hostId: string) =>
    cases.filter((c) => c.remote?.hostId === hostId).map((c) => ({ name: c.name, path: c.remote?.path ?? '' }));
  const wakes = (h: RemoteHostRow) =>
    Boolean(h.wakeCommand || (Array.isArray(h.wakeMac) ? h.wakeMac.length : h.wakeMac));
  if (deps.json) {
    emitJson(
      deps,
      hosts.map((h) => ({
        id: h.id,
        label: h.label,
        ssh: `${h.username}@${h.host}${h.port ? `:${h.port}` : ''}`,
        wake: wakes(h),
        cases: casesOf(h.id),
      }))
    );
    return EXIT.ok;
  }
  if (hosts.length === 0) {
    deps.io.out(palette.muted('(no remote hosts — add one in the web UI: New case → Remote)'));
    return EXIT.ok;
  }
  for (const h of hosts) {
    const ssh = `${h.username}@${h.host}${h.port ? `:${h.port}` : ''}`;
    deps.io.out(
      `${palette.ok(h.id)}  ${h.label ?? ''}  ${palette.muted(ssh)}  ${wakes(h) ? 'wakes on spawn' : palette.muted('no wake configured')}`
    );
    const rows = casesOf(h.id);
    if (rows.length === 0) deps.io.out(palette.muted('  (no cases yet)'));
    else deps.io.out(table([['  CASE', 'PATH'], ...rows.map((c) => [`  ${c.name}`, c.path])], { gap: 2 }));
  }
  deps.io.out(
    palette.muted(
      'spawn there: codeman agent spawn --host <id> --cwd <absolute path on that host> [-n name] [--model …] — a case with that path is reused, else created; a sleeping host is woken. Or spawn <case> for a case listed here.'
    )
  );
  return EXIT.ok;
}

/** quick-start in a case: the original spawn path. */
async function spawnInCase(
  deps: AgentDeps,
  options: SpawnOptions,
  extras: Record<string, unknown>
): Promise<{ sessionId: string; data: Record<string, unknown> } | { error: string }> {
  const body: Record<string, unknown> = {
    caseName: options.caseName,
    mode: options.mode,
    parentSessionId: deps.ctx.selfId,
  };
  if (options.name) body.sessionName = options.name;
  Object.assign(body, SPAWN_BODY_BY_MODE[options.mode] ?? {});
  mergeSpawnBody(body, extras);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: '/api/v1/quick-start',
    body,
    headers: { ...AGENT_ORIGIN_HEADER },
  });
  const data = res.json?.data as { sessionId?: string; caseName?: string; casePath?: string } | undefined;
  if (!res.json?.success || !data?.sessionId) return { error: describeFailure(res) };
  return { sessionId: data.sessionId, data };
}

/** Readiness wait and the report, shared by both placements. */
async function finishSpawn(
  deps: AgentDeps,
  options: SpawnOptions,
  sid: string,
  data: Record<string, unknown>,
  where: string
): Promise<number> {
  // Before the readiness wait, so a startup dialog already reaches the mailbox.
  const subscription = options.subscribe ? await setSubscription(deps, sid, true) : undefined;
  let ready: boolean | undefined;
  let readinessError: string | undefined;
  let dead = false;
  const mark = composerReadyMark(options.mode);
  if (options.ready && mark) {
    try {
      const wait = await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${encodeURIComponent(sid)}/wait-output`,
        query: { match: mark, from: 'buffer', timeout: options.timeoutMs },
        timeoutMs: options.timeoutMs + 10_000,
      });
      // A failed readiness call (waiter cap, 400, network) is its own error, not "the
      // composer never showed up": report the real reason instead of the trust-dialog hint.
      if (!wait.json?.success) readinessError = describeFailure(wait);
      else {
        const result = (wait.json.data as { wait?: WaitResult } | undefined)?.wait;
        // A worker that died while we waited is exit 3 like every other wait, not a
        // "composer not seen" timeout that sends the caller looking for a dialog.
        dead = waitExitCode(result) === EXIT.dead;
        ready = !dead && Boolean(result?.matched);
      }
    } catch (error) {
      readinessError = describeRequestError(error);
    }
  }

  const subscribeError = subscription && 'error' in subscription ? subscription.error : undefined;
  if (deps.json) {
    emitJson(deps, {
      ...data,
      ready,
      readinessError,
      subscribed: subscription !== undefined && !subscribeError,
      ...(subscribeError ? { subscribeError } : {}),
    });
  } else {
    // Human lines go to stderr so `SID=$(codeman agent spawn …)` captures the id alone.
    const say = (line: string) => deps.io.err(line);
    say(
      palette.ok(`${GLYPH.ok} spawned ${sid} (${options.mode}${options.model ? ` ${options.model}` : ''}, ${where})`)
    );
    if (ready === true) say(palette.muted('  composer up: the worker can take a prompt'));
    say(subscribeLine(sid, subscription));
    if (dead) say(palette.err(`${GLYPH.fail} the worker exited during the readiness wait`));
    if (ready === false && !dead) {
      say(
        palette.warn(
          `${GLYPH.warn} composer not seen within ${options.timeoutMs} ms — read \`agent read ${sid.slice(0, 8)} --tail 2000\` before sending (a startup dialog?)`
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
  if (dead) return EXIT.dead;
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
    // A prompt without --wait is a hand-off: say whether its end will reach this session.
    if (options.wait === undefined && !data?.duplicate && (await isSubscribed(deps, target.id)) === false) {
      deps.io.err(palette.muted(`  ${NOT_SUBSCRIBED_HINT(target.id.slice(0, 8))}`));
    }
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
  // A timeout is a 200 with `timedOut`, an answer rather than a failure: exit 2 says it,
  // so the line stays neutral instead of looking like an error to whoever reads the log.
  if (wait.timedOut) return palette.muted(`timed out after ${wait.timeoutMs ?? '?'} ms (exit 2)`);
  if (wait.matched !== undefined) {
    return wait.matched
      ? palette.ok(`${GLYPH.ok} matched "${wait.match}"${wait.snippet ? `: ${wait.snippet}` : ''}`)
      : palette.muted('not matched (exit 2)');
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

/** Bounded incremental evidence, with an opaque server-owned cursor. */
export async function agentInspect(
  deps: AgentDeps,
  options: { id: string; maxBytes: number; since?: string }
): Promise<number> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > INSPECT_MAX_BYTES)
    return fail(deps, '--max-bytes must be between 1 and 65536', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const response = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/inspect`,
    query: { maxBytes: options.maxBytes, since: options.since },
  });
  if (!response.json?.success) return fail(deps, describeFailure(response));
  if (deps.json) emitJson(deps, response.json.data);
  else {
    const data = response.json.data as {
      source?: string;
      evidence?: string;
      truncated?: boolean;
      cursor?: string;
      blockedReason?: string;
    };
    deps.io.out(
      `[${data.source ?? 'unknown'}]${data.truncated ? ' truncated' : ''}${data.blockedReason ? ` (${data.blockedReason})` : ''}`
    );
    deps.io.out(data.evidence ?? '');
    if (data.cursor) deps.io.out(`cursor: ${data.cursor}`);
  }
  return EXIT.ok;
}

/** Stage exactly the printable UTF8 file contents; never sends Enter. */
export async function agentStage(deps: AgentDeps, options: { id: string; messageFile: string }): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) return fail(deps, `refusing: ${options.id} is me`, EXIT.refused);
  let message: string;
  try {
    const info = await stat(options.messageFile);
    if (!info.isFile() || info.size > STAGE_MAX_BYTES)
      return fail(deps, 'message file must be a regular file within 8192 UTF8 bytes', EXIT.refused);
    const handle = await open(options.messageFile, 'r');
    try {
      const buffer = Buffer.alloc(STAGE_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytesRead > STAGE_MAX_BYTES || !isUtf8(bytes))
        return fail(deps, 'message file must contain at most 8192 bytes of UTF8', EXIT.refused);
      message = bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fail(deps, `cannot read message file: ${getErrorMessage(error)}`, EXIT.refused);
  }
  const refusal = inputRefusal(message);
  if (refusal || message !== message.trimEnd())
    return fail(deps, refusal ?? 'stage refuses trailing whitespace', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const response = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/stage`,
    body: { message },
  });
  if (!response.json?.success) return fail(deps, describeFailure(response));
  if (deps.json) emitJson(deps, response.json.data);
  else {
    const data = response.json.data as { stageId: string; sha256: string; expiresAt: number };
    deps.io.out(
      `staged (no Enter): ${data.stageId}\nsha256: ${data.sha256}\nexpires: ${new Date(data.expiresAt).toISOString()}`
    );
  }
  return EXIT.ok;
}

/** Submit one verified staged composer; failure never automatically replays Enter. */
export async function agentSubmit(
  deps: AgentDeps,
  options: { id: string; stageId: string; confirmSha: string }
): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) return fail(deps, `refusing: ${options.id} is me`, EXIT.refused);
  if (!/^[a-f0-9]{64}$/.test(options.confirmSha) || !/^[a-f0-9-]{36}$/.test(options.stageId))
    return fail(deps, 'submit requires a stage UUID and its exact SHA-256', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const response = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/submit`,
    body: { stageId: options.stageId, confirmSha: options.confirmSha },
  });
  if (!response.json?.success) return fail(deps, describeFailure(response));
  if (deps.json) emitJson(deps, response.json.data);
  else deps.io.out('Enter delivered once; inspect or wait for acceptance (no automatic retry).');
  return EXIT.ok;
}

export interface ReadOptions {
  id: string;
  /** Bytes of terminal to print: the rendered screen, or the raw byte buffer with `raw`. */
  tail?: number;
  /** With `tail`: the raw byte buffer (ANSI stripped) instead of the rendered screen. */
  raw?: boolean;
  /** Whole conversation (`context=full`) instead of the last assistant message. */
  full?: boolean;
}

/** `agent read` — the last answer (the route picks the transcript reader or the pane segmenter) or a terminal tail. */
export async function agentRead(deps: AgentDeps, options: ReadOptions): Promise<number> {
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const sid = encodeURIComponent(target.id);
  if (options.tail !== undefined) {
    // The rendered screen first: the raw buffer is a byte stream whose rows a TUI
    // places with cursor moves, so stripped of escapes it prints as one long
    // line. Fall back to it when the server cannot capture the pane (no mux, a
    // dead pane) or predates the screen route.
    if (!options.raw) {
      const screen = await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${sid}/screen`,
        query: { tail: options.tail },
      });
      const data = screen.json?.success
        ? (screen.json.data as { available?: boolean; text?: string; scope?: string } | undefined)
        : undefined;
      if (data?.available) {
        if (deps.json) emitJson(deps, data);
        else {
          deps.io.out(data.text ?? '');
          if (data.scope === 'frame')
            deps.io.err(palette.muted('(remote session: visible screen only, no scrollback)'));
        }
        return EXIT.ok;
      }
    }
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
    | { text?: string; timestamp?: string; messages?: Array<{ role: string; text: string }>; unavailable?: string }
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
  if (!text && data?.unavailable) {
    deps.io.err(palette.muted(`(transcript unavailable: ${data.unavailable}; try --tail 3000)`));
    return EXIT.ok;
  }
  if (!text) {
    deps.io.err(
      palette.muted('(empty: nothing answered yet, or nothing the server could segment as an answer; try --tail 3000)')
    );
    return EXIT.ok;
  }
  deps.io.out(text);
  return EXIT.ok;
}

export interface PullOptions {
  id: string;
  /** A file in the session's working directory: relative to it, or absolute inside it. */
  path: string;
  /** Local destination file or existing directory; default the file's name in the current directory. */
  dest?: string;
  /** Overwrite an existing destination. */
  force?: boolean;
}

/**
 * `agent pull` — copy a file out of a session's working directory. Made for
 * remote workers, whose output stays on their host: the server reads it over
 * ssh through the same `file-raw` route the file viewer uses (bounded to the
 * working directory, the download size limit, never a wake), so the CLI only
 * writes the bytes. Works for a local session too, as a plain copy.
 */
export async function agentPull(deps: AgentDeps, options: PullOptions): Promise<number> {
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const name = posixPath.basename(options.path);
  if (!name || name === '.' || name === '..') return fail(deps, `not a file path: ${options.path}`);
  const dest = resolvePullDestination(options.dest, name);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/file-raw`,
    query: { path: options.path, download: 'true' },
    headers: { Accept: '*/*' },
    timeoutMs: PULL_TIMEOUT_MS,
  });
  if (res.status !== 200) return fail(deps, describeFailure(res));
  const bytes = res.body ?? Buffer.from(res.text, 'utf-8');
  try {
    // `wx` refuses an existing file atomically: no stat-then-write window.
    writeFileSync(dest, bytes, { flag: options.force ? 'w' : 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return fail(deps, `${dest} exists; pass --force to overwrite`);
    return fail(deps, `could not write ${dest}: ${getErrorMessage(err)}`);
  }
  if (deps.json) emitJson(deps, { session: target.id, path: options.path, dest, bytes: bytes.length });
  else
    deps.io.out(`${GLYPH.ok} pulled ${options.path} from ${target.id.slice(0, 8)} → ${dest} (${bytes.length} bytes)`);
  return EXIT.ok;
}

/** Up to the server's own remote read bounds plus transfer time for a large file. */
const PULL_TIMEOUT_MS = 120_000;

/** `dest` as given, inside it when it is a directory, or the bare name in the current directory. */
function resolvePullDestination(dest: string | undefined, name: string): string {
  if (dest === undefined) return resolvePath(name);
  try {
    if (statSync(dest).isDirectory()) return resolvePath(joinPath(dest, name));
  } catch {
    // Not there yet: it names the file to create.
  }
  return resolvePath(dest);
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
// Agent inbox (upstream's verbs; downstream: nudge opt-out, peek, ack-all, quiet digest)
// ─────────────────────────────────────────────────────────────────────────────

/** A message as `GET …/inbox` hands it out. */
export interface InboxMessageRow {
  id: string;
  from: string | null;
  text: string;
  createdAt: number;
  seen: boolean;
  /** Downstream: a status line (a worker's IDLE report), printed in the digest block. */
  quiet?: true;
}

/**
 * Upstream's rule for `post`: the message must be ONE argument. Several would be an
 * unquoted `$(cat notes.md)` split by the shell, and joining the pieces loses its
 * newlines. Downstream's `post` still joins several words with spaces, because running
 * agents post unquoted one-liners; this stays exported for upstream's tests and callers.
 */
export function postTextFromArgs(words: readonly string[]): { text: string } | { error: string } {
  if (words.length === 1) return { text: words[0] };
  return { error: `refusing: the message must be ONE argument, got ${words.length} — quote it` };
}

/**
 * `agent post` — store a message in another session's inbox. Never types it into the
 * pane: the receiver reads it with `agent inbox`. Downstream: a receiver that would never
 * look (idle, not parked on `inbox --wait`) gets one short nudge line from the server
 * (`web/inbox-nudger.ts`); `nudge: false` stores only. The sender is resolved by the
 * server from the `X-Codeman-Parent-Session` header, never sent in the body.
 */
export async function agentPost(
  deps: AgentDeps,
  options: { id: string; text: string; nudge?: boolean }
): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — a note to self goes in a file, not the inbox`, EXIT.refused);
  }
  if (options.text.trim().length === 0) return fail(deps, 'refusing: empty message', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/inbox`,
    // `nudge` only when opting out: the schema is strict, and a server without the
    // downstream field would refuse it on every ordinary post.
    body: { text: options.text, ...(options.nudge === false ? { nudge: false } : {}) },
  });
  // 409 = the receiver's inbox is full; nothing was stored. Passed through as an error.
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as { message?: InboxMessageRow; pending?: number; unseen?: number } | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  else
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} posted to ${target.id.slice(0, 8)} (${data?.pending ?? '?'} pending, ${data?.unseen ?? '?'} unseen)`
      )
    );
  return EXIT.ok;
}

export interface InboxReadOptions {
  /** Another session's inbox (a peek); omitted = this session's own. */
  id?: string;
  /** Long-poll budget in ms; the read parks while nothing is unseen. */
  waitMs?: number;
  /** Downstream: read even your own inbox without marking anything seen (monitor loops). */
  peek?: boolean;
}

/**
 * `inbox [id] --wait [ms] -t <ms>` → what to read and how long. `--wait 600000` (the
 * downstream form) is a budget; a bare `--wait` takes `-t`. commander hands a value that
 * follows `--wait` to the flag, so `inbox --wait <session-id>` arrives as a non-numeric
 * wait: that is the id, not a budget.
 */
export function inboxWaitArgs(
  id: string | undefined,
  wait: string | boolean | undefined,
  timeout: string | undefined
): { id?: string; waitMs?: number } | { error: string } {
  if (wait === undefined || wait === false) return { id };
  if (wait === true) return { id, waitMs: parsePositiveInt(timeout, DEFAULT_WAIT_MS, '--timeout') };
  if (/^\d+$/.test(wait)) return { id, waitMs: parsePositiveInt(wait, DEFAULT_WAIT_MS, '--wait') };
  if (id !== undefined) return { error: `--wait expects a budget in ms, got "${wait}"` };
  return { id: wait, waitMs: parsePositiveInt(timeout, DEFAULT_WAIT_MS, '--timeout') };
}

/** A remaining inbox budget (or a server wait) shorter than this ends the --wait loop. */
const INBOX_WAIT_MIN_SLICE_MS = 1000;

/** True only when the session list was read and does not contain `id`. */
async function sessionIsGone(deps: AgentDeps, id: string): Promise<boolean> {
  try {
    const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
    if (!res.json?.success) return false;
    return !((res.json.data as SessionRow[] | undefined) ?? []).some((s) => s.id === id);
  } catch {
    return false;
  }
}

/** Relative age for humans: `12s`, `4m`, `3h`. */
function age(createdAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * `agent inbox` — read this session's inbox (or peek at another's). Removes nothing:
 * a message stays until `agent ack`. Only reading your OWN inbox marks messages seen
 * (`--peek` skips that too). Exit 0 with mail, 2 when a `--wait` ran out with nothing
 * unseen or the server cut it short (restart, detach), 3 when the session is gone.
 */
export async function agentInboxRead(deps: AgentDeps, options: InboxReadOptions): Promise<number> {
  const target = await resolveSessionId(deps, options.id ?? deps.ctx.selfId);
  if ('error' in target) return fail(deps, target.error, target.code);
  // The server caps one wait (`clampWaitMs`, 600 s by default) and answers `timedOut`
  // at its cap, not at ours: `--wait 3600000` came back after 10 min (downstream,
  // 2026-11-04). config/agent-wait.ts documents the client-side loop over short waits,
  // so ask again with what is left until our own budget is spent or mail arrives.
  const clock = deps.now ?? Date.now;
  const deadline = options.waitMs !== undefined ? clock() + options.waitMs : undefined;
  let res: ApiResponse;
  for (;;) {
    const askedAt = clock();
    const waitMs = deadline !== undefined ? Math.max(1, deadline - askedAt) : undefined;
    res = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(target.id)}/inbox`,
      query: { wait: waitMs, peek: options.peek ? 1 : undefined },
      timeoutMs: waitMs !== undefined ? waitMs + 10_000 : undefined,
    });
    if (deadline === undefined || !res.json?.success) break;
    const timedOut = (res.json.data as { wait?: { timedOut?: boolean } } | undefined)?.wait?.timedOut;
    // A timeout that came back at once means the server is not holding the wait (it
    // refused or capped it to nothing): never spin on it, report it as exit 2.
    const tookMs = clock() - askedAt;
    if (!timedOut || tookMs < INBOX_WAIT_MIN_SLICE_MS || deadline - clock() < INBOX_WAIT_MIN_SLICE_MS) break;
  }
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | {
        receiver?: boolean;
        messages?: InboxMessageRow[];
        pending?: number;
        unseen?: number;
        wait?: { timedOut?: boolean; ended?: boolean };
      }
    | undefined;
  const messages = data?.messages ?? [];
  // `ended` is also what a server restart or a detach answers. Exit 3 tells a receiver
  // loop to stop, so it needs the session list to confirm the session is gone; while
  // it is still listed (or the list cannot be had, as during a restart) the wait was
  // only cut short, which is exit 2: loop again.
  const gone = data?.wait?.ended ? await sessionIsGone(deps, target.id) : false;
  const code = gone ? EXIT.dead : data?.wait?.timedOut || data?.wait?.ended ? EXIT.timeout : EXIT.ok;
  if (deps.json) {
    emitJson(deps, data ?? {});
    return code;
  }
  const now = (deps.now ?? Date.now)();
  for (const m of messages.filter((item) => !item.quiet)) {
    const sender = m.from ? m.from.slice(0, 8) : 'user';
    const tag = m.seen ? palette.muted('seen') : palette.emph('new');
    deps.io.out(palette.muted(`── ${m.id} from ${sender}, ${age(m.createdAt, now)} ago, `) + tag);
    deps.io.out(terminalSafeText(m.text));
  }
  // Status lines last and compact: one current line per worker, no action owed by itself.
  const digest = messages.filter((item) => item.quiet);
  if (digest.length > 0) {
    deps.io.out(palette.emph(`watch digest (${digest.length}):`));
    for (const m of digest) deps.io.out(terminalSafeText(m.text));
  }
  if (gone) {
    deps.io.err(palette.err(`${GLYPH.fail} the session went away during the wait`));
  } else if (data?.wait?.ended) {
    deps.io.err(palette.muted('(the server ended the wait early, e.g. a restart; exit 2, wait again)'));
  } else if (messages.length === 0) {
    deps.io.err(palette.muted(data?.wait?.timedOut ? '(no mail; wait timed out, exit 2)' : '(no mail)'));
  } else if (data?.receiver) {
    deps.io.err(
      palette.muted(
        `${messages.length} pending, NOT acknowledged — handle them, reply with \`codeman agent post\`, then \`codeman agent ack\` (everything read) or \`codeman agent ack <id>…\` (full ids above).`
      )
    );
  } else {
    deps.io.err(palette.muted(`${messages.length} pending (peek: nothing was marked seen).`));
  }
  return code;
}

/**
 * `agent ack [ids…]` — remove messages from THIS session's inbox, idempotently. With
 * ids: those. Downstream: without ids, everything a receiver read already handed out
 * (seen), so `inbox` + `ack` removes exactly what was read.
 */
export async function agentAck(deps: AgentDeps, options: { ids: string[] }): Promise<number> {
  const ids = options.ids.map((id) => id.trim()).filter(Boolean);
  const self = await resolveSessionId(deps, deps.ctx.selfId);
  if ('error' in self) return fail(deps, self.error, self.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(self.id)}/inbox/ack`,
    body: ids.length > 0 ? { ids } : {},
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as { removed?: number; pending?: number } | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} acked ${data?.removed ?? 0} (${data?.pending ?? '?'} still pending)`));
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

/** The ids to watch (mute, subscribe to): the given ones (resolved like every id), else this session's children. */
async function watchTargets(
  deps: AgentDeps,
  ids: string[],
  verb = 'watch'
): Promise<{ ids: string[] } | { error: string }> {
  if (ids.length > 0) {
    const resolved: string[] = [];
    for (const id of ids) {
      if (isSelfSession(deps.ctx.selfId, id))
        return { error: `refusing: ${id} is me — ${verb} your workers, not yourself` };
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
  if (children.length === 0) return { error: `no workers to ${verb}: this session spawned none — pass their ids` };
  return { ids: children.map((s) => s.id) };
}

/** One `agent watch` line: IDLE/BLOCKED/EXITED, id, mode, since, reason and counts, name. */
function watchLine(s: WatchRow): string {
  const what =
    s.reason === 'exited' || s.turnEndSource === 'exit' ? 'EXITED' : s.reason === 'blocked' ? 'BLOCKED' : 'IDLE';
  const facts =
    s.reason === undefined
      ? ''
      : `  ${s.reason}  todos ${s.openTodos ?? 0}/${s.totalTodos ?? 0}  inbox ${s.inboxPending ?? 0}`;
  return `${what}  ${s.id.slice(0, 8)}  ${s.mode}  since ${clockTime(new Date(s.turnEndedAt).toISOString())} (${s.turnEndSource ?? 'dialog'})${facts}  ${s.name}`;
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
    for (const s of data.ended) deps.io.out(watchLine(s));
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
// Mute — hold a worker's IDLE reports to its coordinator for a while
// ─────────────────────────────────────────────────────────────────────────────

/** Default `agent mute` length: long enough for a build or a test run. */
export const DEFAULT_MUTE_MS = 30 * 60_000;
const MAX_MUTE_MS = 24 * 60 * 60_000;

/** `90s`, `30m`, `2h`, or a bare number of minutes → ms; at most 24 h. */
export function parseMuteDuration(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MUTE_MS;
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(raw.trim());
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[(m?.[2] ?? 'm').toLowerCase() as 's' | 'm' | 'h'];
  const ms = m ? Number(m[1]) * unit : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MUTE_MS) {
    throw new Error(`--for must be 1s … 24h (90s, 30m, 2h; a bare number is minutes), got "${raw}"`);
  }
  return ms;
}

/**
 * `agent mute [ids…] --for 30m` / `agent unmute [ids…]` — hold the IDLE reports a
 * worker's turn ends post into your mailbox (a worker babysitting a long build ends a
 * short turn every minute). BLOCKED and EXITED still come. When the mute ends, the
 * worker's state is reported once if it still stands idle. No ids: all your workers.
 */
export async function agentMute(deps: AgentDeps, options: { ids: string[]; forMs: number }): Promise<number> {
  const targets = await watchTargets(deps, options.ids);
  if ('error' in targets) return fail(deps, targets.error, EXIT.refused);
  const out: { id: string; mutedUntil: number | null }[] = [];
  for (const id of targets.ids) {
    const res = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/v1/sessions/${encodeURIComponent(id)}/report-mute`,
      body: { forMs: options.forMs },
    });
    if (!res.json?.success) return fail(deps, `${id.slice(0, 8)}: ${describeFailure(res)}`);
    const data = res.json.data as { mutedUntil?: number | null } | undefined;
    out.push({ id, mutedUntil: data?.mutedUntil ?? null });
  }
  if (deps.json) emitJson(deps, { sessions: out });
  else {
    const subs = await fetchSubscriptions(deps);
    for (const { id, mutedUntil } of out) {
      deps.io.out(
        palette.ok(
          mutedUntil === null
            ? `${GLYPH.ok} ${id.slice(0, 8)} unmuted — its current state is reported if it stands idle`
            : `${GLYPH.ok} ${id.slice(0, 8)} muted until ${clockTime(new Date(mutedUntil).toISOString())} — IDLE reports held; BLOCKED/EXITED still come`
        )
      );
      // A mute holds reports for every subscriber; to this session it only matters when it subscribes.
      if (subs && !(subs.get(id) ?? []).includes(deps.ctx.selfId)) {
        deps.io.err(
          palette.muted(
            `  you are not subscribed to ${id.slice(0, 8)}, so its reports do not reach you anyway (to get them: \`codeman agent subscribe ${id.slice(0, 8)}\`)`
          )
        );
      }
    }
  }
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscribe — a worker's reports reach your mailbox only when you ask for them
// ─────────────────────────────────────────────────────────────────────────────
//
// Reports are opt-in (Joe, 2026-10-23: they spammed sessions that never asked for
// them). The verbs say so where an agent decides: spawn, send, every report line
// (`no more reports: …`), mute, and the SUB column of `ls`.

/** The hint where a hand-off happens and this session would not hear its end. */
const NOT_SUBSCRIBED_HINT = (id8: string) =>
  `no report reaches you when its turn ends — to get its IDLE/BLOCKED/EXITED in your mailbox: \`codeman agent subscribe ${id8}\` (or wait for it: \`agent watch ${id8}\`)`;

/**
 * Every subscription (worker → subscribers), or null on a server without the route —
 * the SUB column then reads `?` and the hints stay silent, never a failure.
 */
async function fetchSubscriptions(deps: AgentDeps): Promise<Map<string, string[]> | null> {
  // Only ever a hint or a column: a failed lookup must not fail the verb that asked.
  const res = await deps
    .request(deps.ctx, { method: 'GET', path: '/api/v1/agent-report-subscriptions' })
    .catch(() => null);
  if (!res?.json?.success) return null;
  return new Map(Object.entries((res.json.data as Record<string, string[]> | undefined) ?? {}));
}

/** Whether this session gets `id`'s reports; null when the server cannot say. */
async function isSubscribed(deps: AgentDeps, id: string): Promise<boolean | null> {
  const subs = await fetchSubscriptions(deps);
  return subs ? (subs.get(id) ?? []).includes(deps.ctx.selfId) : null;
}

interface SubscriptionAnswer {
  subscribers: string[];
  /** The worker's watch row now; null while a turn runs. */
  row: WatchRow | null;
}

/** Turn this session's subscription to `id` on or off. */
async function setSubscription(
  deps: AgentDeps,
  id: string,
  subscribed: boolean
): Promise<SubscriptionAnswer | { error: string }> {
  // A thrown transport error is an answer too: after a spawn the worker exists, and its id must still print.
  const res = await deps
    .request(deps.ctx, {
      method: 'POST',
      path: `/api/v1/sessions/${encodeURIComponent(id)}/report-subscription`,
      body: { subscriber: deps.ctx.selfId, subscribed },
    })
    .catch((err: unknown) => ({ error: getErrorMessage(err) }));
  if ('error' in res) return res;
  if (!res.json?.success) return { error: describeFailure(res) };
  const data = res.json.data as Partial<SubscriptionAnswer> | undefined;
  return { subscribers: data?.subscribers ?? [], row: data?.row ?? null };
}

/** The spawn report's subscription line: on, failed, or how to turn it on. */
function subscribeLine(sid: string, subscription: SubscriptionAnswer | { error: string } | undefined): string {
  const id8 = sid.slice(0, 8);
  if (subscription === undefined) return palette.muted(`  ${NOT_SUBSCRIBED_HINT(id8)}; or spawn with --subscribe`);
  if ('error' in subscription) {
    return palette.warn(
      `${GLYPH.warn} subscribe failed: ${subscription.error} — retry: \`codeman agent subscribe ${id8}\``
    );
  }
  return palette.muted(
    `  subscribed: its IDLE/BLOCKED/EXITED lines come to your mailbox — stop: \`codeman agent unsubscribe ${id8}\``
  );
}

/**
 * `agent subscribe [ids…]` / `agent unsubscribe [ids…]` — get a worker's reports
 * (IDLE/BLOCKED/EXITED/GONE) in this session's mailbox, or stop getting them. Any
 * session can be subscribed to. No ids: subscribe to the sessions you spawned;
 * unsubscribe from every session you are subscribed to.
 */
export async function agentSubscribe(
  deps: AgentDeps,
  options: { ids: string[]; subscribed: boolean }
): Promise<number> {
  let ids: string[];
  if (options.subscribed || options.ids.length > 0) {
    const targets = await watchTargets(deps, options.ids, options.subscribed ? 'subscribe to' : 'unsubscribe from');
    if ('error' in targets) return fail(deps, targets.error, EXIT.refused);
    ids = targets.ids;
  } else {
    const subs = await fetchSubscriptions(deps);
    if (!subs) return fail(deps, 'this server lists no subscriptions (too old?) — pass the ids');
    ids = [...subs].filter(([, list]) => list.includes(deps.ctx.selfId)).map(([worker]) => worker);
    if (ids.length === 0) {
      if (deps.json) emitJson(deps, { sessions: [] });
      else deps.io.out(palette.muted('(subscribed to nobody — nothing to stop)'));
      return EXIT.ok;
    }
  }
  const out: Array<{ id: string } & SubscriptionAnswer> = [];
  for (const id of ids) {
    const answer = await setSubscription(deps, id, options.subscribed);
    if ('error' in answer) return fail(deps, `${id.slice(0, 8)}: ${answer.error}`);
    out.push({ id, ...answer });
  }
  if (deps.json) {
    emitJson(deps, { sessions: out.map((o) => ({ ...o, subscribed: options.subscribed })) });
    return EXIT.ok;
  }
  for (const { id, row } of out) {
    const id8 = id.slice(0, 8);
    if (!options.subscribed) {
      deps.io.out(
        palette.ok(
          `${GLYPH.ok} unsubscribed from ${id8} — no more reports from it (\`agent watch ${id8}\` still answers on demand)`
        )
      );
      continue;
    }
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} subscribed to ${id8} — its IDLE/BLOCKED/EXITED lines come to your mailbox; stop: \`codeman agent unsubscribe ${id8}\``
      )
    );
    deps.io.out(palette.muted(`  now: ${row ? watchLine(row) : 'a turn runs'}`));
  }
  return EXIT.ok;
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
    console.error(palette.err(`${GLYPH.fail} ${describeRequestError(err)}`));
    process.exitCode = EXIT.error;
  }
}

/** Register `codeman agent …` on the program. */
export function registerAgentCommands(program: Command): Command {
  const agent = program
    .command('agent')
    .description(
      'Talk to other sessions from inside one (any CLI mode): list, spawn (also on another host), hosts, send, wait, watch, subscribe, mute, read, interrupt, rm, the inbox: post, inbox, ack, todo, and the experimental, opt-in inspect, stage, submit'
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
    .command('spawn [case]')
    .description(
      'Start a worker and wait for its composer where the mode draws one. Where: a case (created if missing), else --cwd, else YOUR working directory; on another machine: --host <id> --cwd <path there>'
    )
    .option('-m, --mode <mode>', 'Run mode id, as the Run menu names it', 'claude')
    .option(
      '--model <id>',
      'Model for this worker only (claude: --model, e.g. opus, sonnet, claude-opus-5-5; codex/opencode/…: their model id). Default: the standard model'
    )
    .option('--cwd <dir>', "Working directory for the worker (instead of this shell's cwd); not with a case")
    .option('--working-dir <dir>', 'Same as --cwd (upstream name)')
    .option(
      '--host <id>',
      'Run the worker on that remote host (`agent hosts`); --cwd is then an absolute path THERE. Reuses the case for that directory or creates one; wakes a sleeping host'
    )
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
    .option(
      '--subscribe',
      "Get the worker's IDLE/BLOCKED/EXITED reports in your mailbox (reports are opt-in; later: agent subscribe/unsubscribe)"
    )
    .option('--json', 'Machine-readable output')
    .action(
      (
        caseName: string | undefined,
        options: {
          mode: string;
          model?: string;
          cwd?: string;
          workingDir?: string;
          host?: string;
          name?: string;
          ready: boolean;
          timeout?: string;
          env: string[];
          permission?: string;
          resume?: string;
          subscribe?: boolean;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) => {
          return agentSpawn(deps, {
            caseName,
            cwd: options.cwd,
            workingDir: options.workingDir,
            host: options.host,
            model: options.model,
            mode: options.mode,
            name: options.name,
            ready: options.ready,
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            env: options.env,
            permission: options.permission,
            resume: options.resume,
            subscribe: options.subscribe,
          });
        })
    );

  agent
    .command('hosts')
    .description('Remote hosts a worker can run on (spawn --host), each with the directories that already have a case')
    .option('--json', 'Machine-readable output')
    .action((options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentHosts(deps)));

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
      'Comma list: stop,idle,exit,working,blocked (stop needs hook signals for the session, blocked hooks or a dialog Codeman reads off the screen, as for codex; where there are none the server answers 400, passed through)'
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
    .command('inspect <id>')
    .description(
      'Experimental, opt-in (agentCoordinationEnabled): bounded transcript evidence or a labeled pane snapshot; opaque incremental cursors'
    )
    .option('--max-bytes <n>', 'UTF8 evidence budget (1–65536)', '8192')
    .option('--since <cursor>', 'Resume a cursor from the same owner, pane and transcript')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { maxBytes: string; since?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentInspect(deps, {
          id,
          maxBytes: parsePositiveInt(options.maxBytes, 8192, '--max-bytes'),
          since: options.since,
        })
      )
    );

  agent
    .command('stage <id>')
    .description(
      'Experimental, opt-in (agentCoordinationEnabled): type a printable single-line UTF8 file without Enter; requires a verifiable local Codex composer, and refuses slash or shell commands and a last word starting with @ or $ (use send)'
    )
    .requiredOption('--message-file <path>', 'Regular UTF8 file, at most 8192 bytes, no trailing newline')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { messageFile: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentStage(deps, { id, messageFile: options.messageFile }))
    );

  agent
    .command('submit <id>')
    .description(
      'Experimental, opt-in (agentCoordinationEnabled): send Enter once only when the staged composer, pane and hash still match'
    )
    .requiredOption('--stage-id <receipt>', 'One-shot stage receipt')
    .requiredOption('--confirm-sha <hash>', 'Exact SHA-256 returned by stage')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { stageId: string; confirmSha: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentSubmit(deps, { id, stageId: options.stageId, confirmSha: options.confirmSha })
      )
    );

  agent
    .command('read <id>')
    .description("Print a session's last answer (as the server reads it for that mode) or, with --tail, its terminal")
    .option('--tail <bytes>', 'Last bytes of the screen as rendered, one line per row (works in every mode)')
    .option('--raw', 'With --tail: the raw terminal byte buffer, ANSI stripped, instead of the rendered screen')
    .option('--full', 'The whole conversation instead of the last assistant message')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { tail?: string; raw?: boolean; full?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentRead(deps, {
          id,
          tail: options.tail === undefined ? undefined : parsePositiveInt(options.tail, 3000, '--tail'),
          raw: options.raw,
          full: options.full,
        })
      )
    );

  agent
    .command('pull <id> <path> [dest]')
    .description(
      "Copy a file out of a session's working directory (a remote worker's output stays on its host); path relative to that directory"
    )
    .option('--force', 'Overwrite an existing destination file')
    .option('--json', 'Machine-readable output')
    .action((id: string, path: string, dest: string | undefined, options: { force?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentPull(deps, { id, path, dest, force: options.force }))
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
    // A message is often a file (`"$(cat task.md)"`) and markdown starts with `- ` or
    // `---` often enough; without this commander takes it for an unknown option.
    // `--json`, `--no-nudge` and `-h` are still options: text that is exactly one goes after `--`.
    .allowUnknownOption()
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
    .command('inbox [id]')
    .description(
      "Read this session's inbox (or peek at another's with [id]) WITHOUT acknowledging; `agent ack` removes. --wait blocks while nothing is new: exit 2 on timeout"
    )
    // `--wait <ms>` is the downstream form running agents and the wait-gate hook know;
    // upstream's is a bare `--wait` with `-t <ms>`. Both work.
    .option('-w, --wait [ms]', 'Block until a new (unseen) message arrives; optional budget in ms (else -t)')
    .option('-t, --timeout <ms>', 'Wait budget in ms (with a bare --wait)', String(DEFAULT_WAIT_MS))
    .option('--peek', 'Read without even marking the mail as seen (for monitor loops)')
    .option('--json', 'Machine-readable output')
    .action(
      (
        id: string | undefined,
        options: { wait?: string | boolean; timeout?: string; peek?: boolean; json?: boolean }
      ) =>
        run(Boolean(options.json), async (deps) => {
          const wait = inboxWaitArgs(id, options.wait, options.timeout);
          if ('error' in wait) return fail(deps, wait.error, EXIT.refused);
          return agentInboxRead(deps, { id: wait.id, waitMs: wait.waitMs, peek: Boolean(options.peek) });
        })
    );

  agent
    .command('ack [ids...]')
    .description(
      "Acknowledge (remove) mail in this session's inbox: the given ids, or without ids everything a read handed out — the second half of `inbox`"
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

  agent
    .command('mute [ids...]')
    .description(
      "Hold a worker's IDLE reports to your mailbox for a while (default: all the sessions you spawned); BLOCKED/EXITED still come, and when the mute ends its state is reported once if it stands idle"
    )
    .option('--for <duration>', 'How long: 90s, 30m, 2h (bare number = minutes, max 24h)', '30m')
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { for?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentMute(deps, { ids, forMs: parseMuteDuration(options.for) }))
    );

  agent
    .command('subscribe [ids...]')
    .description(
      "Get a session's IDLE/BLOCKED/EXITED/GONE reports in your mailbox from now on (default: all the sessions you spawned); reports are opt-in, any session can be subscribed to, and the answer says where it stands now"
    )
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentSubscribe(deps, { ids, subscribed: true }))
    );

  agent
    .command('unsubscribe [ids...]')
    .description(
      'Stop getting those reports (default: every session you are subscribed to); `agent watch` still answers on demand'
    )
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentSubscribe(deps, { ids, subscribed: false }))
    );

  agent
    .command('unmute [ids...]')
    .description('Lift a mute now (default: all the sessions you spawned); what it held back is reported once')
    .option('--json', 'Machine-readable output')
    .action((ids: string[], options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentMute(deps, { ids, forMs: 0 }))
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
