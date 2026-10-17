/**
 * @fileoverview Boot pass: reattach remote (SSH) sessions a host reboot cut off, without a click.
 *
 * A reboot of THIS host takes only the local ssh wrapper of a remote session;
 * the agent keeps running in the remote host's `-L codeman-remote` tmux. Waiting
 * for a banner click puts that session at the mercy of an in-memory offer (a
 * dismiss, or a server restart before the click, loses it while the remote pane
 * runs on unseen). So right after boot this pass takes the remote entries from
 * the reboot plan, asks each host ONCE which panes it still has, and rebuilds
 * every entry whose remote pane is alive. The rebuilt launch is
 * `ssh … new-session -A`, which attaches to that pane, so nothing new starts.
 *
 * Everything else goes back on offer unchanged: a pane that is gone (the banner
 * can still resume a claude conversation, by the user's choice) and every entry
 * on a host that did not answer.
 *
 * Invariants:
 * - Never wakes a host: no import of the wake registry (wiring guard). A sleeping
 *   host costs one ssh timeout and its entries stay on the banner.
 * - Take-then-build like the banner route, under its own spender key, so a click
 *   while this pass runs cannot receive the same entry.
 * - Builds through `rebuildRebootEntry`, the route's construction path.
 *
 * @dependencies reboot-restore-registry, reboot-restore-rebuild, remote-hosts
 * @consumedby web/server (after boot recovery)
 *
 * @module web/reboot-remote-reattach
 */

import { getErrorMessage } from '../types.js';
import type { RemoteHost, SessionRemote } from '../types.js';
import { rejectAlreadyLive, type RebootRestoreEntry } from '../reboot-restore.js';
import { listRemoteCodemanPanes, type RemoteCodemanPane } from '../remote-hosts.js';
import { remoteTmuxSessionName } from '../tmux-manager.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../config/server-timing.js';
import { sessionCapacityMessage } from './route-helpers.js';
import { rebootRestoreRegistry } from './reboot-restore-registry.js';
import { rebuildRebootEntry, type RebootRebuildCtx } from './reboot-restore-rebuild.js';

/**
 * The registry's spender for this pass. Not a username: owners are user names
 * or `undefined`, and this key only has to differ from all of them.
 */
export const BOOT_REATTACH_SPENDER = '\0boot-remote-reattach';

export interface BootReattachDeps {
  /** Panes on a host's codeman-remote server; `undefined` = no answer. Injected by tests. */
  listPanes?: (remote: SessionRemote) => Promise<Map<string, RemoteCodemanPane> | undefined>;
  /** Host-level fields from remote-hosts.json. */
  readHosts: () => Promise<RemoteHost[]>;
}

export interface BootReattachResult {
  reattached: string[];
  /** Back on the banner: pane gone, host silent, capacity, or a failed build. */
  leftOnOffer: string[];
}

/** ssh identity of a host; entries sharing it are asked about in one round trip. */
function hostKey(remote: SessionRemote): string {
  return `${remote.username}@${remote.host}:${remote.port ?? 22}`;
}

export async function reattachRemoteRebootEntries(
  ctx: RebootRebuildCtx,
  deps: BootReattachDeps
): Promise<BootReattachResult> {
  const listPanes = deps.listPanes ?? listRemoteCodemanPanes;
  const result: BootReattachResult = { reattached: [], leftOnOffer: [] };

  const remoteIds = rebootRestoreRegistry
    .list(() => true)
    .filter((entry) => entry.state.remote)
    .map((entry) => entry.sessionId);
  if (remoteIds.length === 0) return result;
  if (!rebootRestoreRegistry.beginSpending(BOOT_REATTACH_SPENDER)) return result;

  // Taken synchronously after the list above: no await in between, so a click
  // cannot have spent any of them yet.
  const taken = rebootRestoreRegistry.take(() => true, remoteIds, BOOT_REATTACH_SPENDER);
  const unspent = new Set<RebootRestoreEntry>(taken);
  try {
    const byHost = new Map<string, RebootRestoreEntry[]>();
    for (const entry of taken) {
      const key = hostKey(entry.state.remote!);
      byHost.set(key, [...(byHost.get(key) ?? []), entry]);
    }
    const panesByHost = new Map<string, Map<string, RemoteCodemanPane> | undefined>();
    await Promise.all(
      [...byHost].map(async ([key, entries]) => {
        panesByHost.set(key, await listPanes(entries[0].state.remote!).catch(() => undefined));
      })
    );

    const workspaceHooksEnabled = await ctx.getWorkspaceHooksEnabled();
    const remoteHostsById = new Map((await deps.readHosts().catch(() => [])).map((host) => [host.id, host]));

    for (const entry of taken) {
      const remote = entry.state.remote!;
      const pane = panesByHost
        .get(hostKey(remote))
        ?.get(remote.remoteSessionName || remoteTmuxSessionName(entry.sessionId));
      if (!pane || pane.dead) continue;
      // Read fresh per entry, like the route: each rebuild awaits a real pane start.
      const liveConversations = new Set(
        [...ctx.sessions.values()].map((session) => session.claudeSessionId).filter((id): id is string => !!id)
      );
      const [alreadyLive] = rejectAlreadyLive([entry], new Set(ctx.sessions.keys()), liveConversations).skipped;
      if (alreadyLive) {
        // Spent, as in the route: an open conversation does not stop being open.
        unspent.delete(entry);
        continue;
      }
      if (sessionCapacityMessage(ctx.sessions, entry.owner)) continue;
      const session = await rebuildRebootEntry(ctx, entry, { workspaceHooksEnabled, remoteHostsById });
      if (!session) continue;
      unspent.delete(entry);
      result.reattached.push(entry.sessionId);
    }

    if (result.reattached.length > 0) ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
  } finally {
    result.leftOnOffer = [...unspent].map((entry) => entry.sessionId);
    rebootRestoreRegistry.releaseFlight(BOOT_REATTACH_SPENDER, [...unspent]);
    rebootRestoreRegistry.endSpending(BOOT_REATTACH_SPENDER);
  }
  return result;
}

/** `reattachRemoteRebootEntries` for the boot sequence: logs, never throws. */
export async function runBootRemoteReattach(ctx: RebootRebuildCtx, deps: BootReattachDeps): Promise<void> {
  try {
    const { reattached, leftOnOffer } = await reattachRemoteRebootEntries(ctx, deps);
    if (reattached.length + leftOnOffer.length === 0) return;
    console.log(
      `[RebootReattach] reattached ${reattached.length} remote session(s); ${leftOnOffer.length} left on the banner`
    );
  } catch (err) {
    console.error(`[RebootReattach] boot pass failed; the banner still offers the rest: ${getErrorMessage(err)}`);
  }
}
