/**
 * @fileoverview Safety net: adopt remote (SSH) sessions this Codeman launched but no longer shows.
 *
 * A remote agent outlives everything on this side: its `codeman-ssh-<id8>` tmux
 * on the host's `-L codeman-remote` server keeps running after the board lost the
 * session (a reboot offer that was dismissed or expired, a record pruned while the
 * host slept, a server restart before a click). Such an orphan runs unseen
 * forever. This pass finds them and puts them back on the board; the rebuilt
 * launch is `ssh … new-session -A`, which attaches, so nothing new starts.
 *
 * Provenance is mandatory. Isolated test instances (`CODEMAN_INSTANCE`) share the
 * host's `codeman-remote` socket, so a pane is adopted only when THIS instance's
 * lifecycle log knows a session id with that prefix (created/started/recovered)
 * and no `deleted` followed: a delete is the user closing it. `stale_cleaned`
 * does not count against it, because a pruned record is exactly how an orphan
 * comes about. Two ids sharing the prefix make it ambiguous, and it is left alone.
 *
 * What the log cannot give back is the conversation id and the owner: an adopted
 * claude session learns its conversation from the remote model refresher, and an
 * adopted session has no owner (admin-only in multi-user mode).
 *
 * Triggers: the end of the boot pass, a wake that brought a host back
 * (`RemoteWakeDeps.onHostReady`), and `POST /api/remote-orphans/adopt`. No
 * polling: every listing is an ssh the host's idle detector would see.
 *
 * Never wakes a host: no import of the wake registry (wiring guard).
 *
 * @dependencies remote-hosts, session-lifecycle-log, reboot-restore-rebuild, reboot-restore-registry
 * @consumedby web/reboot-remote-reattach (boot), web/routes/session-routes (wake hook, route)
 *
 * @module web/remote-orphans
 */

import { getErrorMessage } from '../types.js';
import type { LifecycleEntry, RemoteHost, SessionState } from '../types.js';
import type { RebootRestoreEntry } from '../reboot-restore.js';
import { listRemoteCodemanPanes, toSessionRemote, type RemoteCodemanPane } from '../remote-hosts.js';
import { remoteTmuxSessionName } from '../tmux-manager.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../config/server-timing.js';
import { sessionCapacityMessage } from './route-helpers.js';
import { rebootRestoreRegistry } from './reboot-restore-registry.js';
import { rebuildRebootEntry, type RebootRebuildCtx } from './reboot-restore-rebuild.js';

const REMOTE_NAME_PREFIX = 'codeman-ssh-';

export interface OrphanChoice {
  sessionId: string;
  name?: string;
  mode: 'claude' | 'shell';
  pane: RemoteCodemanPane;
}

/**
 * Which panes on one host may be adopted. Pure.
 *
 * @param panes The host's `codeman-remote` panes.
 * @param knownIds Session ids the board or the reboot plan already holds.
 * @param lifecycle This instance's lifecycle log, oldest first.
 */
export function selectAdoptableOrphans(
  panes: ReadonlyMap<string, RemoteCodemanPane>,
  knownIds: (sessionId: string) => boolean,
  lifecycle: readonly LifecycleEntry[]
): OrphanChoice[] {
  // Per prefix: every full id the log knows, and per id its last life event.
  const idsByPrefix = new Map<string, Set<string>>();
  const last = new Map<string, { alive: boolean; name?: string }>();
  for (const entry of lifecycle) {
    if (!entry.sessionId || entry.sessionId === '*') continue;
    const life =
      entry.event === 'created' || entry.event === 'started' || entry.event === 'recovered'
        ? true
        : entry.event === 'deleted'
          ? false
          : undefined;
    const prev = last.get(entry.sessionId);
    if (life === undefined && !prev) continue;
    const prefix = entry.sessionId.slice(0, 8);
    idsByPrefix.set(prefix, (idsByPrefix.get(prefix) ?? new Set()).add(entry.sessionId));
    last.set(entry.sessionId, {
      alive: life ?? prev!.alive,
      name: entry.name ?? prev?.name,
    });
  }

  const out: OrphanChoice[] = [];
  for (const pane of panes.values()) {
    if (pane.dead || !pane.sessionName.startsWith(REMOTE_NAME_PREFIX)) continue;
    const ids = idsByPrefix.get(pane.sessionName.slice(REMOTE_NAME_PREFIX.length));
    if (!ids || ids.size !== 1) continue;
    const [sessionId] = ids;
    // The name must be the one THIS id launches under, or it is a stranger's.
    if (remoteTmuxSessionName(sessionId) !== pane.sessionName) continue;
    const life = last.get(sessionId);
    if (!life?.alive || knownIds(sessionId)) continue;
    out.push({ sessionId, name: life.name, mode: pane.command === 'claude' ? 'claude' : 'shell', pane });
  }
  return out;
}

/** The record an orphan is rebuilt from: what the host and the log still know. */
export function orphanEntry(host: RemoteHost, choice: OrphanChoice, now = Date.now()): RebootRestoreEntry {
  const remote = toSessionRemote(host, {
    name: '',
    type: 'remote',
    hostId: host.id,
    remotePath: choice.pane.path,
  });
  return {
    sessionId: choice.sessionId,
    name: choice.name,
    workingDir: choice.pane.path,
    mode: choice.mode,
    // Unknown: the pane attaches, so no conversation is chosen here.
    resumeConversationId: '',
    state: {
      id: choice.sessionId,
      pid: null,
      status: 'idle',
      workingDir: choice.pane.path,
      currentTaskId: null,
      createdAt: now,
      mode: choice.mode,
      name: choice.name,
      remote,
    } as SessionState,
  };
}

export interface AdoptOrphansDeps {
  readHosts: () => Promise<RemoteHost[]>;
  /** Injected by tests; defaults to one ssh `list-panes` per host. */
  listPanes?: (host: RemoteHost) => Promise<Map<string, RemoteCodemanPane> | undefined>;
  /** Injected by tests; defaults to this instance's whole lifecycle log. */
  readLifecycle?: () => Promise<LifecycleEntry[]>;
}

export interface AdoptOrphansResult {
  adopted: string[];
  /** Hosts that did not answer. */
  silentHosts: string[];
}

let inFlight: Promise<AdoptOrphansResult> | null = null;

/**
 * Adopt the orphans on the given hosts (all configured hosts when omitted).
 * Single-flighted: a second call while one runs gets the running pass's result.
 */
export function adoptRemoteOrphans(
  ctx: RebootRebuildCtx,
  deps: AdoptOrphansDeps,
  hostIds?: readonly string[]
): Promise<AdoptOrphansResult> {
  if (inFlight) return inFlight;
  inFlight = runAdoption(ctx, deps, hostIds).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runAdoption(
  ctx: RebootRebuildCtx,
  deps: AdoptOrphansDeps,
  hostIds?: readonly string[]
): Promise<AdoptOrphansResult> {
  const result: AdoptOrphansResult = { adopted: [], silentHosts: [] };
  const allHosts = await deps.readHosts();
  const hosts = hostIds ? allHosts.filter((host) => hostIds.includes(host.id)) : allHosts;
  if (hosts.length === 0) return result;

  const listPanes = deps.listPanes ?? listRemoteCodemanPanes;
  const listings = await Promise.all(hosts.map((host) => listPanes(host).catch(() => undefined)));
  if (listings.every((panes) => !panes || panes.size === 0)) {
    result.silentHosts = hosts.filter((_, i) => !listings[i]).map((host) => host.label);
    return result;
  }
  const lifecycle = deps.readLifecycle
    ? await deps.readLifecycle()
    : (await getLifecycleLog().query({ limit: Number.MAX_SAFE_INTEGER })).reverse();

  const workspaceHooksEnabled = await ctx.getWorkspaceHooksEnabled();
  const remoteHostsById = new Map(allHosts.map((host) => [host.id, host]));
  const known = (id: string) => ctx.sessions.has(id) || rebootRestoreRegistry.holds(id);

  for (const [i, host] of hosts.entries()) {
    const panes = listings[i];
    if (!panes) {
      result.silentHosts.push(host.label);
      continue;
    }
    for (const choice of selectAdoptableOrphans(panes, known, lifecycle)) {
      // Re-checked per entry: each rebuild awaits a real pane start, and a click
      // or the boot pass may have brought this session back meanwhile.
      if (known(choice.sessionId)) continue;
      if (sessionCapacityMessage(ctx.sessions, undefined)) return result;
      const session = await rebuildRebootEntry(ctx, orphanEntry(host, choice), {
        workspaceHooksEnabled,
        remoteHostsById,
        reason: 'orphan_adopted',
      });
      if (session) result.adopted.push(choice.sessionId);
    }
  }
  if (result.adopted.length > 0) ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
  return result;
}

/** `adoptRemoteOrphans` for fire-and-forget triggers: logs, never throws. */
export async function runRemoteOrphanAdoption(
  ctx: RebootRebuildCtx,
  deps: AdoptOrphansDeps,
  hostIds?: readonly string[]
): Promise<void> {
  try {
    const { adopted, silentHosts } = await adoptRemoteOrphans(ctx, deps, hostIds);
    if (adopted.length > 0) {
      console.log(`[RemoteOrphans] adopted ${adopted.length} remote session(s): ${adopted.join(', ')}`);
    }
    if (silentHosts.length > 0) console.log(`[RemoteOrphans] no answer from ${silentHosts.join(', ')}`);
  } catch (err) {
    console.error(`[RemoteOrphans] adoption failed: ${getErrorMessage(err)}`);
  }
}
