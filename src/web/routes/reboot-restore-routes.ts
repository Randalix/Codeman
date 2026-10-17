/**
 * @fileoverview Reboot-restore routes: offer back the sessions a host reboot destroyed.
 *
 * The boot pass leaves a plan in `web/reboot-restore-registry` when the machine
 * plausibly rebooted. The board reads it, shows a banner, and the user decides:
 * - `GET  /api/reboot-restore`: what is on offer, ownership-scoped
 * - `POST /api/reboot-restore/restore`: rebuild some or all of it
 * - `POST /api/reboot-restore/dismiss`: drop the offer
 * - `POST /api/remote-orphans/adopt`: the orphan safety net on demand (web/remote-orphans)
 *
 * A click, not the heuristic, is what creates panes. The heuristic only decides
 * whether the banner appears, so a wrong yes costs a line of text the user
 * dismisses rather than N CLI processes nobody asked for.
 *
 * Rebuilding is take-then-build: entries leave the plan synchronously at the top
 * of the route, before the first `await`, and the whole route is single-flighted,
 * so a double-click or two devices cannot put two panes on one conversation.
 * Three things are re-checked at click time rather than trusted from boot: the
 * owner's privilege grant, the workspace still being on disk, and the
 * conversation not already being live because the user resumed it by hand.
 *
 * A remote session is rebuilt only after its host has answered that the agent's
 * own tmux is still there (or, for claude, that it is gone and can be resumed):
 * the reboot took only the local ssh wrapper, and the rebuilt launch's
 * `new-session -A` attaches to the surviving remote pane. The probe is a plain
 * `has-session` over ssh. This module has no access to the wake registry, so a
 * sleeping host answers `host-unreachable` and its entries stay on offer.
 *
 * A rebuilt session comes back attached, idle and disarmed. Respawn controllers
 * and Ralph loops are deliberately not re-armed, and its terminal scrollback is
 * gone, because the pane is new. The banner says so.
 */

import { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { RebootRestoreRequestSchema } from '../schemas.js';
import {
  parseBody,
  getAuthUser,
  canAccessOwned,
  ownerFor,
  isWorkingDirAllowedForUsername,
  requireAdmin,
  sessionCapacityMessage,
} from '../route-helpers.js';
import { adoptRemoteOrphans, type AdoptOrphansDeps } from '../remote-orphans.js';
import { rebootRestoreRegistry } from '../reboot-restore-registry.js';
import {
  rejectAlreadyLive,
  remoteRestoreDecision,
  type RebootRestoreEntry,
  type RebootRestoreRejection,
} from '../../reboot-restore.js';
import { readRemoteHosts, remoteTmuxSessionAlive } from '../../remote-hosts.js';
import { remoteTmuxSessionName } from '../../tmux-manager.js';
import { getDataDir } from '../../config/instance.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';
import { rebuildRebootEntry, type RebootRebuildCtx } from '../reboot-restore-rebuild.js';
import type { SessionRemote } from '../../types.js';

type RebootRestoreCtx = RebootRebuildCtx;

/** The banner's view of one restorable session. The record itself never leaves the server. */
function toBannerItem(entry: RebootRestoreEntry) {
  return {
    id: entry.sessionId,
    name: entry.name,
    workingDir: entry.workingDir,
    mode: entry.mode,
    owner: entry.owner,
    // The host's label, so the banner can say where a session lives. Absent for local.
    ...(entry.state.remote ? { remote: entry.state.remote.label || entry.state.remote.hostId } : {}),
  };
}

export interface RebootRestoreRouteOptions {
  /** Whether a remote session's own tmux still exists; `undefined` = host did not answer. Injected by tests. */
  remoteSessionAlive?: (remote: SessionRemote, remoteSessionName: string) => Promise<boolean | undefined>;
  /** Orphan adoption IO (host listing, lifecycle log). Injected by tests. */
  orphanDeps?: Partial<AdoptOrphansDeps>;
}

export function registerRebootRestoreRoutes(
  app: FastifyInstance,
  ctx: RebootRestoreCtx,
  options: RebootRestoreRouteOptions = {}
): void {
  const remoteSessionAlive = options.remoteSessionAlive ?? remoteTmuxSessionAlive;
  const accessorFor = (req: Parameters<typeof getAuthUser>[0]) => {
    const user = getAuthUser(req);
    return (owner: string | undefined) => canAccessOwned(user, owner);
  };

  // ========== What is on offer ==========

  app.get('/api/reboot-restore', async (req) => {
    const entries = rebootRestoreRegistry.list(accessorFor(req));
    return {
      sessions: entries.map(toBannerItem),
      // Said plainly here so the banner never implies a full restore: the pane is
      // new, so the conversation continues and the terminal history does not.
      scrollbackRestored: false,
    };
  });

  // ========== Spend it ==========

  app.post('/api/reboot-restore/restore', async (req, reply) => {
    const body = parseBody(RebootRestoreRequestSchema, req.body, 'Invalid reboot restore request');
    const canAccess = accessorFor(req);
    const owner = ownerFor(req);

    // Take BEFORE the first await: a second click must find nothing to spend.
    // The flight is per owner, because `take()` already guarantees two callers
    // never receive the same entry, so one user's restore need not block another's.
    if (!rebootRestoreRegistry.beginSpending(owner)) {
      return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'A reboot restore is already running'));
    }
    const taken = rebootRestoreRegistry.take(canAccess, body.sessionIds, owner);
    // Entries nothing built a pane for, returned to the plan on every exit path
    // including a throw. Without this a failure between here and the loop would
    // spend the offer and rebuild nothing, and the plan cannot be rebuilt.
    const unspent = new Set(taken);

    try {
      if (taken.length === 0) return { restored: [], skipped: [] };

      // The plan was built at boot and the board has moved on since. A conversation
      // the user resumed by hand from the Resume list is already on screen, and a
      // second pane on it would fight the first for the same transcript. This one
      // is never re-offered: unlike a missing workspace, it cannot stop being true.
      // Read fresh each time rather than snapshotted once: the loop below awaits a
      // real `startInteractive()` per entry, so by the tenth entry a snapshot taken
      // here is tens of seconds old, and a conversation the user resumed by hand in
      // that window would be invisible to it.
      const liveSessionIds = () => new Set(ctx.sessions.keys());
      const liveConversationIds = () =>
        new Set(
          [...ctx.sessions.values()].map((session) => session.claudeSessionId).filter((id): id is string => !!id)
        );
      const { restore, skipped } = rejectAlreadyLive(taken, liveSessionIds(), liveConversationIds());
      for (const entry of taken) {
        if (skipped.some((s) => s.sessionId === entry.sessionId)) unspent.delete(entry);
      }

      const restored: ReturnType<typeof toBannerItem>[] = [];
      const failures: RebootRestoreRejection[] = [...skipped];
      const workspaceHooksEnabled = await ctx.getWorkspaceHooksEnabled();
      // Host-level fields live in remote-hosts.json, not in the record, and a host's
      // wake command or agent URL may have changed since the session was launched.
      // Same refresh the boot adopt path applies.
      const remoteHostsById = restore.some((entry) => entry.state.remote)
        ? new Map((await readRemoteHosts(getDataDir()).catch(() => [])).map((host) => [host.id, host]))
        : new Map();
      // A host that did not answer once is not asked again in this click: a sleeping
      // host would otherwise cost one ssh timeout per session on it.
      const unreachableHosts = new Set<string>();

      for (const entry of restore) {
        // The already-live check, re-run against the board as it is NOW. The pass
        // above decided the batch; this catches a conversation that went live while
        // an earlier entry in this same batch was starting. Spent rather than
        // returned to the plan, for the same reason as the batch pass: unlike a
        // missing workspace or a withdrawn grant, an open conversation is not a
        // condition that stops being true.
        const [lateLive] = rejectAlreadyLive([entry], liveSessionIds(), liveConversationIds()).skipped;
        if (lateLive) {
          failures.push(lateLive);
          unspent.delete(entry);
          continue;
        }
        // Capacity is re-checked per iteration, because this loop is itself
        // creating the sessions it counts. The offer can be a day old, so the
        // board may be fuller now than the plan assumed.
        const capMsg = sessionCapacityMessage(ctx.sessions, entry.owner);
        if (capMsg) {
          failures.push({ sessionId: entry.sessionId, reason: 'capacity-reached' });
          continue;
        }
        const savedRemote = entry.state.remote;
        if (savedRemote) {
          // The workspace and its confinement are the remote host's business: the
          // path is not on this disk, and the case grant was checked at launch.
          // What matters here is whether the agent's own tmux survived.
          const hostKey = `${savedRemote.username}@${savedRemote.host}:${savedRemote.port ?? 22}`;
          const alive = unreachableHosts.has(hostKey)
            ? undefined
            : await remoteSessionAlive(
                savedRemote,
                savedRemote.remoteSessionName || remoteTmuxSessionName(entry.sessionId)
              ).catch(() => undefined);
          if (alive === undefined) unreachableHosts.add(hostKey);
          const decision = remoteRestoreDecision(entry, alive);
          if (!decision.build) {
            failures.push(decision.rejection);
            if (!decision.keepOnOffer) unspent.delete(entry);
            continue;
          }
        } else if (!existsSync(entry.workingDir)) {
          // A repo can be deleted between the boot that planned this and the click.
          failures.push({ sessionId: entry.sessionId, reason: 'workspace-missing' });
          continue;
        }
        // Multi-user workspace separation: the create route confines a non-admin's
        // workingDir to their own case space, and a grant can be withdrawn between
        // the session's creation and this restore, so the confinement is re-run
        // rather than inherited from the record. Keyed on the OWNER, not on the
        // caller: an admin spending another user's entry must be held to that
        // user's confinement, and `isWorkingDirAllowed` would wave an admin
        // through. The same reason the two grant re-checks below read
        // `saved.owner`.
        if (!savedRemote && !(await isWorkingDirAllowedForUsername(entry.owner, entry.workingDir))) {
          // Left on offer: a withdrawn grant can be restored, unlike an already-open
          // conversation, so this is not the permanent kind of refusal.
          failures.push({ sessionId: entry.sessionId, reason: 'workspace-forbidden' });
          continue;
        }
        const session = await rebuildRebootEntry(ctx, entry, { workspaceHooksEnabled, remoteHostsById });
        if (!session) {
          failures.push({ sessionId: entry.sessionId, reason: 'rebuild-failed' });
          // Left on offer: the user can put the binary back and click again.
          continue;
        }
        restored.push(toBannerItem(entry));
        unspent.delete(entry);
      }

      if (restored.length > 0) {
        // A reboot leaves recovery with nothing alive to find, so its own block never
        // started the stats collector. This clears and re-arms its interval, so it is
        // safe to call whether or not the collector is already running.
        ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      return { restored, skipped: failures };
    } finally {
      // Anything that never became a pane goes back on offer, including after a
      // throw, so a transient failure costs a retry rather than the whole plan.
      // Ends the flight: entries still parked for it come back if they are in
      // `unspent`, and a Dismiss that unparked them meanwhile wins.
      rebootRestoreRegistry.releaseFlight(owner, [...unspent]);
      rebootRestoreRegistry.endSpending(owner);
    }
  });

  // ========== Safety net: remote sessions the board lost ==========

  // Admin-only: an adopted session has no owner (the lifecycle log does not
  // record one), so in multi-user mode only an admin may bring it back.
  app.post('/api/remote-orphans/adopt', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return adoptRemoteOrphans(ctx, {
      readHosts: () => readRemoteHosts(getDataDir()),
      ...options.orphanDeps,
    });
  });

  // ========== Drop it ==========

  app.post('/api/reboot-restore/dismiss', async (req) => {
    const dismissed = rebootRestoreRegistry.clear(accessorFor(req));
    return { dismissed };
  });
}
