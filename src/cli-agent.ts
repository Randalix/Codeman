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
  let username = env.CODEMAN_USERNAME;
  let password = env.CODEMAN_PASSWORD;
  if (!password) {
    const file = envFile();
    username = username || file.CODEMAN_USERNAME;
    password = file.CODEMAN_PASSWORD;
  }
  return {
    apiUrl,
    selfId,
    auth: password ? { username: username || 'admin', password } : undefined,
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

/** Strip ANSI CSI/charset sequences from a terminal buffer (GNU and BSD alike). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');
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
    // fails a call, so there is no case for leaving them off.
    'X-Codeman-Parent-Session': ctx.selfId,
    'X-Codeman-Agent-Origin': 'codeman-agent-cli',
  };
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
}

/** A full session id (the only form the routes accept); `ls` prints the 8-char prefix. */
const FULL_ID_LENGTH = 36;

/**
 * Turn the id a human typed into the one the routes accept. `ls` prints 8-char
 * prefixes and the routes answer 404 to those (measured live), so anything shorter
 * than a full id resolves through the session list; an ambiguous prefix refuses
 * rather than picking one.
 */
export async function resolveSessionId(deps: AgentDeps, id: string): Promise<{ id: string } | { error: string }> {
  if (!id) return { error: 'refusing: empty session id' };
  if (id.length >= FULL_ID_LENGTH) return { id };
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return { error: describeFailure(res) };
  const matches = ((res.json.data as SessionRow[] | undefined) ?? []).filter((s) => s.id.startsWith(id));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `no session starts with "${id}" (see \`agent ls\`)` };
  return { error: `"${id}" is ambiguous: ${matches.map((s) => s.id.slice(0, 13)).join(', ')}` };
}

/** `agent ls` — every session the caller can see, self marked; `--alive` probes each pane. */
export async function agentLs(deps: AgentDeps, options: { alive?: boolean } = {}): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const sessions = (res.json.data as SessionRow[] | undefined) ?? [];
  const alive = new Map<string, 'alive' | 'dead' | 'unknown'>();
  if (options.alive) {
    // One short probe per session, in parallel: `status` says busy for a corpse.
    await Promise.all(sessions.map(async (s) => alive.set(s.id, await probeAlive(deps, s.id))));
  }
  if (deps.json) {
    emitJson(
      deps,
      sessions.map((s) => ({
        ...s,
        self: isSelfSession(deps.ctx.selfId, s.id),
        ...(options.alive ? { pane: alive.get(s.id) } : {}),
      }))
    );
    return EXIT.ok;
  }
  if (sessions.length === 0) {
    deps.io.out(palette.muted('(no sessions)'));
    return EXIT.ok;
  }
  const rows = sessions.map((s) => [
    isSelfSession(deps.ctx.selfId, s.id) ? '*' : ' ',
    s.id.slice(0, 8),
    s.mode ?? '?',
    s.status ?? '?',
    ...(options.alive ? [alive.get(s.id) === 'dead' ? 'DEAD' : (alive.get(s.id) ?? '?')] : []),
    s.name || s.workingDir || '',
  ]);
  const header = [' ', 'ID', 'MODE', 'STATUS', ...(options.alive ? ['PANE'] : []), 'NAME'];
  deps.io.out(table([header, ...rows], { gap: 2 }));
  deps.io.out(
    palette.muted(`* = this session (${deps.ctx.selfId.slice(0, 8)}). status is a UI hint, never a sync signal.`)
  );
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
  if ('error' in target) return fail(deps, target.error);
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
  const data = res.json.data as { delivered?: boolean; duplicate?: boolean; wait?: WaitResult } | undefined;
  if (deps.json) emitJson(deps, data ?? {});
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
  if ('error' in target) return fail(deps, target.error);
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
  if ('error' in target) return fail(deps, target.error);
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
  if ('error' in target) return fail(deps, target.error);
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
  if ('error' in target) return fail(deps, target.error);
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
 * `agent restore` — bring a session whose pane died back, with its conversation.
 * Codeman's own respawn refuses external CLIs (opencode, codex, …), so this delegates
 * to the host's restore tool, which respawns the pane from the original launch
 * command and re-attaches the CLI's last conversation (`opencode -c`, `claude
 * --resume`, …). A live worker is never touched: restoring it would kill its turn.
 */
export async function agentRestore(
  deps: AgentDeps,
  options: { id: string; resume?: string; runner?: RestoreRunner }
): Promise<number> {
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error);
  const state = await probeAlive(deps, target.id);
  if (state === 'alive') {
    return fail(
      deps,
      `refusing: ${target.id} is alive — restore would kill the running worker (use interrupt, or rm + spawn --resume)`,
      EXIT.refused
    );
  }
  // Only a PROVEN corpse is respawned: an unanswered probe (waiter cap, 5xx, timeout) may
  // hide a live worker, and the external tool's own live check is not this code's to rely on.
  if (state !== 'dead') {
    return fail(
      deps,
      `refusing: could not prove ${target.id} is dead (probe answered "${state}") — retry, or check \`agent ls --alive\``,
      EXIT.refused
    );
  }
  const runner: RestoreRunner =
    options.runner ??
    (async (id, resume) => {
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
    });
  const result = await runner(target.id, options.resume);
  if (deps.json) emitJson(deps, { sessionId: target.id, restored: result.code === EXIT.ok, output: result.output });
  else if (result.code === EXIT.ok)
    deps.io.out(palette.ok(`${GLYPH.ok} restored ${target.id}${result.output ? `\n${result.output}` : ''}`));
  else deps.io.err(palette.err(`${GLYPH.fail} restore failed for ${target.id}: ${result.output}`));
  return result.code;
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
 * `agent post` — leave a message in another session's inbox. Nothing is typed into
 * its pane: the receiver reads it with `agent inbox` when it wants to. Multi-line
 * text is fine here (it is stored, not sent as keystrokes).
 */
export async function agentPost(deps: AgentDeps, options: { id: string; text: string }): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — a note to self goes in a file, not the mailbox`, EXIT.refused);
  }
  if (options.text.trim().length === 0) return fail(deps, 'refusing: empty message', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/inbox`,
    body: { text: options.text, from: deps.ctx.selfId },
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
  /** Read without acknowledging: the messages stay for the next read. */
  peek: boolean;
}

/**
 * `agent inbox` — read this session's mailbox. Messages are acknowledged (removed)
 * after they were printed, unless `--peek`; a crash between read and ack leaves
 * them in place. Exit 2 when a `--wait` ran out with nothing arriving.
 */
export async function agentInbox(deps: AgentDeps, options: InboxOptions): Promise<number> {
  const self = encodeURIComponent(deps.ctx.selfId);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${self}/inbox`,
    query: { wait: options.waitMs },
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
  if (messages.length > 0 && !options.peek) {
    const ack = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/v1/sessions/${self}/inbox/ack`,
      body: { ids: messages.map((m) => m.id) },
    });
    if (!ack.json?.success)
      return fail(deps, `read ${messages.length} message(s) but could not acknowledge them: ${describeFailure(ack)}`);
  }
  if (messages.length === 0 && options.waitMs !== undefined) return EXIT.timeout;
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
      'Talk to other sessions from inside one (any CLI mode): list, spawn, send, wait, read, interrupt, rm, post, inbox'
    );

  agent
    .command('ls')
    .alias('list')
    .description('List sessions; * marks this one')
    .option('--alive', 'Probe every pane (wait until=exit, 1 s each, in parallel): DEAD means the worker exited')
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
    .command('restore <id>')
    .description(
      "Bring back a session whose pane died (respawns it with its conversation via the host's codeman-restore-session); refuses a live one"
    )
    .option(
      '--resume <cli-session-id>',
      'Re-attach exactly this CLI conversation instead of the last one in the directory'
    )
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { resume?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentRestore(deps, { id, resume: options.resume }))
    );

  agent
    .command('send <id> <text...>')
    .description('Type a prompt into another session and press Enter (printable text only)')
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
        run(Boolean(options.json), (deps) =>
          agentSend(deps, {
            id,
            text: words.join(' '),
            enter: options.enter,
            wait: options.until ?? (options.wait ? true : undefined),
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            clientId: options.clientId,
            seq: options.seq === undefined ? undefined : parsePositiveInt(options.seq, 1, '--seq'),
          })
        )
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
    .option('-m, --match <marker>', 'Literal substring to wait for in the output (ANSI-stripped, no regex)')
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
    .description('Delete a session you created (refuses your own id)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentRm(deps, { id })));

  agent
    .command('post <id> [text...]')
    .description(
      "Leave a message in another session's mailbox (nothing is typed; it reads it with `agent inbox`). Text from stdin when omitted or `-`"
    )
    .option('--json', 'Machine-readable output')
    .action(async (id: string, words: string[], options: { json?: boolean }) => {
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
      await run(Boolean(options.json), (deps) => agentPost(deps, { id, text }));
    });

  agent
    .command('inbox')
    .description(
      "Read this session's mailbox and acknowledge what was read; --wait blocks while it is empty (exit 2 on timeout)"
    )
    .option('-w, --wait <ms>', 'Block up to <ms> while the inbox is empty')
    .option('--peek', 'Read without acknowledging')
    .option('--json', 'Machine-readable output')
    .action((options: { wait?: string; peek?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentInbox(deps, {
          waitMs: options.wait === undefined ? undefined : parsePositiveInt(options.wait, 1, '--wait'),
          peek: Boolean(options.peek),
        })
      )
    );

  return agent;
}
