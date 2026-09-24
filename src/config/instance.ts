/**
 * @fileoverview Per-instance isolation: data directory + tmux socket.
 *
 * Codeman keeps all runtime state under `~/.codeman` and runs its tmux sessions
 * on a dedicated socket (`tmux -L codeman`). Both are PROCESS-WIDE and SHARED by
 * every Codeman instance on the machine — so a second instance pointed at the
 * same socket will discover and attach to the first instance's live sessions,
 * and two instances sharing `~/.codeman/state.json` will clobber each other.
 *
 * To let a beta build coexist with a production one, this module derives both
 * the data dir and the tmux socket from a single "instance" name:
 *   - default (unset/empty) → `~/.codeman`      + `tmux -L codeman`        (prod layout)
 *   - `CODEMAN_INSTANCE=beta` → `~/.codeman-beta` + `tmux -L codeman-beta`
 *   - `CODEMAN_INSTANCE=foo`  → `~/.codeman-foo`  + `tmux -L codeman-foo`
 *
 * The DEFAULT is the production layout so this is safe to ship to master: an
 * existing install keeps reading `~/.codeman`. To run a beta ALONGSIDE prod,
 * launch it with `CODEMAN_INSTANCE=beta` (and a distinct port, see below) —
 * `scripts/run-beta.sh` does both. The port is unrelated to the instance and is
 * set separately via `--port` / `CODEMAN_PORT` (see `src/cli.ts`).
 *
 * Individual overrides still win: `CODEMAN_DATA_DIR` (absolute data dir) and
 * `CODEMAN_TMUX_SOCKET` (socket name, validated in tmux-manager).
 */

import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Refuse to run under Vitest against the REAL home directory.
 *
 * `test/setup.ts` points `$HOME` at a throwaway dir before any application module
 * loads; everything that persists (`~/.codeman`, `~/codeman-cases`, `~/.claude`)
 * derives from `homedir()`, so that one redirect is the whole isolation. A run that
 * skips the setup file — `npx vitest run` in a checkout, which finds no root config
 * — writes straight into the live tree. That happened on 2026-09-24: fixtures
 * overwrote `remote-hosts.json`/`settings.json`, deleted the user's cases and their
 * `linked-cases.json`, and replaced the agent skill.
 *
 * The real home is taken from the passwd entry (`os.userInfo()`), which `$HOME`
 * cannot move. Vitest sets `VITEST` itself, with or without our setup file, so the
 * check holds however the suite was started. Throwing at import is deliberate:
 * nearly every module imports this one, so the run dies before its first write.
 */
export function assertTestIsolation(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  realHome: string | undefined = readRealHome()
): void {
  if (!env.VITEST || !realHome) return;
  const real = resolve(realHome);
  const inRealHome = (p: string) => resolve(p) === real || resolve(p).startsWith(real + sep);
  if (resolve(home) === real) {
    throw new Error(
      `Refusing to run tests against the real home (${real}): test/setup.ts did not run. ` +
        'Use `npm test` (or `npx vitest run --config config/vitest.ci.config.ts`).'
    );
  }
  if (env.CODEMAN_DATA_DIR && inRealHome(env.CODEMAN_DATA_DIR)) {
    throw new Error(`Refusing to run tests with CODEMAN_DATA_DIR inside the real home (${env.CODEMAN_DATA_DIR}).`);
  }
}

function readRealHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

assertTestIsolation();

/**
 * Instance name. Empty string (the default) = production layout (`~/.codeman`,
 * `-L codeman`), so this is safe on master and existing installs are untouched.
 * Set `CODEMAN_INSTANCE=beta` (e.g. via `scripts/run-beta.sh`) to run an
 * isolated beta alongside prod.
 */
export const CODEMAN_INSTANCE = process.env.CODEMAN_INSTANCE ?? '';

const INSTANCE_SUFFIX = CODEMAN_INSTANCE ? `-${CODEMAN_INSTANCE}` : '';

/** Default tmux socket for this instance. `CODEMAN_TMUX_SOCKET` still overrides. */
export const DEFAULT_TMUX_SOCKET = `codeman${INSTANCE_SUFFIX}`;

/** Characters tmux accepts in a `-L` socket name. */
export const SAFE_TMUX_SOCKET_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * This instance's tmux socket: the `CODEMAN_TMUX_SOCKET` override when it is a
 * safe name, else the instance default. Every process that runs `tmux -L` has
 * to resolve it through here (the server via TmuxManager, the TUI for its
 * degraded-mode listing), or a beta instance ends up driving prod's sessions.
 */
export function resolveTmuxSocketName(): string {
  const raw = process.env.CODEMAN_TMUX_SOCKET;
  if (raw !== undefined && SAFE_TMUX_SOCKET_PATTERN.test(raw)) return raw;
  return DEFAULT_TMUX_SOCKET;
}

let _ensured = false;

/**
 * Absolute path to this instance's data directory (created on first use). All
 * persisted state (`state.json`, `mux-sessions.json`, settings, push keys,
 * lifecycle log, screenshots, certs, …) lives here.
 */
export function getDataDir(): string {
  const dir = process.env.CODEMAN_DATA_DIR || join(homedir(), `.codeman${INSTANCE_SUFFIX}`);
  if (!_ensured) {
    try {
      mkdirSync(dir, { recursive: true });
      _ensured = true;
    } catch {
      /* best-effort; individual writers also mkdir as needed */
    }
  }
  return dir;
}

/** Join one or more segments onto this instance's data directory. */
export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}
