/**
 * @fileoverview `codeman agent` inside SSH-remote sessions.
 *
 * A local session's pane inherits `CODEMAN_MUX`/`CODEMAN_API_URL`/`CODEMAN_SESSION_ID`
 * and finds `codeman` on PATH, so its agent can `codeman agent inbox`. A remote
 * session's agent runs on another host and had neither: no env (the launch is a bare
 * `ssh … tmux new-session`) and no binary — cut off from the mailbox entirely.
 *
 * Opt-in per host with `agentApiUrl` in remote-hosts.json: the URL under which THAT
 * host reaches this server. The loopback `CODEMAN_API_URL` the server hands local
 * panes is wrong on another machine, and guessing a LAN address is exactly what the
 * agent CLI refuses to do — so without the field nothing changes.
 *
 * Two halves:
 * 1. `remoteAgentEnvPrefix` — the `export …;` the remote launch runs before the
 *    agent. Env survives the `$SHELL -i -l -c` wrapper; a PATH prefix would not (the
 *    login profile rebuilds PATH), which is why the binary goes to `~/.local/bin`.
 * 2. `installRemoteAgentCli` — pipes the bundled standalone CLI
 *    (`dist/remote/codeman-agent.cjs`, built by scripts/build.mjs) over ssh into
 *    `~/.local/bin/codeman`. Best-effort, once per host and bundle hash per process.
 *    A `codeman` there WITHOUT our marker (a real install) is never overwritten.
 *
 * @module remote-agent-cli
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { RemoteHost, RemoteSshOptions } from './types.js';

/**
 * Accepted `agentApiUrl`: http(s), host (name, IPv4 or bracketed IPv6), optional
 * port and plain path. Deliberately narrow — the value is exported into a shell
 * command that crosses a local `bash -c "…"` layer, where `$` and backticks would
 * run LOCALLY. Shared by the schema and the launch builder (defense in depth).
 */
export const AGENT_API_URL_PATTERN = /^https?:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

/** Line 2 of the bundle; the remote install only replaces a file that carries it. */
export const REMOTE_AGENT_CLI_MARKER = 'codeman-remote-agent-cli';

/** Install target on the remote host. `~/.local/bin` is on the login PATH (XDG). */
export const REMOTE_AGENT_CLI_PATH = '$HOME/.local/bin/codeman';

/** Session ids are server-minted; validated anyway because they land in shell code. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * The `export …; ` prefix for the remote pane command, or `''` when the host has
 * no (valid) `agentApiUrl` — then the launch is byte-identical to before.
 */
export function remoteAgentEnvPrefix(remote: { agentApiUrl?: string }, sessionId: string): string {
  const url = remote.agentApiUrl?.trim();
  if (!url || !AGENT_API_URL_PATTERN.test(url) || !SESSION_ID_PATTERN.test(sessionId)) return '';
  return `export CODEMAN_MUX=1 CODEMAN_SESSION_ID=${shellescape(sessionId)} CODEMAN_API_URL=${shellescape(url)}; `;
}

/**
 * The remote side of the install: read the bundle from stdin into a temp file and
 * move it into place atomically — unless a foreign `codeman` is there (no marker),
 * in which case stdin is drained and nothing changes. Prints `installed` or
 * `foreign`, which the caller logs.
 */
export function buildRemoteAgentCliInstallScript(): string {
  const f = REMOTE_AGENT_CLI_PATH;
  return [
    `f="${f}"`,
    `if [ -e "$f" ] && ! grep -q ${REMOTE_AGENT_CLI_MARKER} "$f" 2>/dev/null; then cat >/dev/null; echo foreign; exit 0; fi`,
    `mkdir -p "$(dirname "$f")" && cat > "$f.tmp.$$" && chmod 755 "$f.tmp.$$" && mv -f "$f.tmp.$$" "$f" && echo installed`,
  ].join('; ');
}

/** Full local command: ssh (same connection args as the launch) + the install script. */
export function buildRemoteAgentCliInstallCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): string {
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(host);
  return [ssh, ...connectionArgs, remoteSshTarget(host), shellescape(buildRemoteAgentCliInstallScript())].join(' ');
}

/** `dist/remote/codeman-agent.cjs` next to the running `dist/*.js`. */
export function defaultRemoteAgentCliBundlePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'remote', 'codeman-agent.cjs');
}

export interface InstallRemoteAgentCliDeps {
  /** Bundle bytes, or null when the build has none. */
  readBundle: () => Buffer | null;
  /** Run `command` through a shell with `stdin`; resolves stdout, rejects on failure. */
  run: (command: string, stdin: Buffer) => Promise<string>;
  log: (message: string) => void;
}

/** Host + bundle hash of every successful install in this process. */
const installed = new Set<string>();

/** Test hook. */
export function resetRemoteAgentCliInstallMemo(): void {
  installed.clear();
}

function runWithStdin(command: string, stdin: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `exit ${code}`));
    });
    child.stdin.on('error', () => {
      /* EPIPE when ssh fails early — the close handler reports it */
    });
    child.stdin.end(stdin);
  });
}

const defaultDeps: InstallRemoteAgentCliDeps = {
  readBundle: () => {
    const path = defaultRemoteAgentCliBundlePath();
    return existsSync(path) ? readFileSync(path) : null;
  },
  run: runWithStdin,
  log: (message) => console.log(message),
};

/**
 * Copy the standalone agent CLI to the remote host, if the host opted in
 * (`agentApiUrl`). Never throws: a failed copy costs only the CLI, never the
 * session launch. No-op under VITEST unless deps are injected.
 */
export async function installRemoteAgentCli(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions & { agentApiUrl?: string },
  deps?: Partial<InstallRemoteAgentCliDeps>
): Promise<'installed' | 'foreign' | 'skipped' | 'failed'> {
  if (!deps && process.env.VITEST) return 'skipped';
  const d = { ...defaultDeps, ...deps };
  if (!host.agentApiUrl) return 'skipped';
  try {
    const bundle = d.readBundle();
    if (!bundle) {
      d.log('[remote-agent-cli] no bundle in this build (dist/remote/codeman-agent.cjs); skipping install');
      return 'skipped';
    }
    const key = `${host.username}@${host.host}:${host.port ?? 22}#${createHash('sha256').update(bundle).digest('hex')}`;
    if (installed.has(key)) return 'skipped';
    const out = (await d.run(buildRemoteAgentCliInstallCommand(host), bundle)).trim();
    if (out.endsWith('foreign')) {
      d.log(`[remote-agent-cli] ${host.username}@${host.host}: ~/.local/bin/codeman is not ours; left untouched`);
      installed.add(key);
      return 'foreign';
    }
    if (!out.endsWith('installed')) throw new Error(`unexpected output: ${out.slice(-200)}`);
    installed.add(key);
    d.log(`[remote-agent-cli] installed codeman agent CLI on ${host.username}@${host.host}`);
    return 'installed';
  } catch (err) {
    d.log(
      `[remote-agent-cli] install on ${host.username}@${host.host} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'failed';
  }
}
