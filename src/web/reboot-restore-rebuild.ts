/**
 * @fileoverview Rebuild one reboot-restore entry into a live session.
 *
 * The construction half of spending the reboot plan, shared by the banner click
 * (`web/routes/reboot-restore-routes`) and the boot pass that reattaches remote
 * sessions without a click. The callers decide WHETHER an entry is rebuilt
 * (already live, capacity, workspace, remote pane alive); this module only builds
 * it, so there is one construction path and not two that drift.
 *
 * No wake access: a remote entry is launched with `ssh … new-session -A`, which
 * attaches to the surviving pane and never wakes a host.
 *
 * @dependencies session, hooks-config, session-lifecycle-log, remote-hosts
 * @consumedby web/routes/reboot-restore-routes, web/server (boot reattach)
 *
 * @module web/reboot-restore-rebuild
 */

import { getErrorMessage } from '../types.js';
import type { RebootRestoreEntry } from '../reboot-restore.js';
import { rehydrateRemoteHostFields } from '../remote-hosts.js';
import { clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { Session } from '../session.js';
import { resolveClaudeModeForUsername } from '../user-store.js';
import { getCli } from '../config/cli-registry/registry.js';
import { agentSkillDir, applyWorkspaceHooks, seedAgentSessionPreamble } from '../hooks-config.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { SseEvent } from './sse-events.js';
import type { RemoteHost, SessionAttachmentHistoryItem } from '../types.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from './ports/index.js';

export type RebootRebuildCtx = SessionPort & EventPort & ConfigPort & InfraPort;

export interface RebootRebuildOptions {
  /** Read once per pass by the caller, not once per entry. */
  workspaceHooksEnabled: boolean;
  /** Host-level fields from remote-hosts.json, refreshed onto the saved `remote`. */
  remoteHostsById: ReadonlyMap<string, RemoteHost>;
  /** Lifecycle `recovered` reason, so the log tells a click from a boot pass or an adoption. */
  reason?: string;
}

/**
 * Builds the session, starts its pane and announces it. Returns the session, or
 * `null` when it would not start; the partial construction is already undone
 * then, and the caller decides whether the entry stays on offer.
 */
export async function rebuildRebootEntry(
  ctx: RebootRebuildCtx,
  entry: RebootRestoreEntry,
  opts: RebootRebuildOptions
): Promise<Session | null> {
  const { workspaceHooksEnabled, remoteHostsById } = opts;
  try {
    const saved = entry.state;
    const claudeModeConfig = await ctx.getClaudeModeConfig();
    const session = new Session({
      // The old id is reused on purpose: a pinned record, subagent parents,
      // window states and the lifecycle log all key off it, and the unpinned
      // record is gone, so there is nothing to collide with.
      id: saved.id,
      workingDir: saved.workingDir,
      mode: saved.mode,
      name: saved.name,
      // Without this the constructor re-infers ownership from the name, so a
      // session the user renamed by hand to something shaped like `w<n>-<case>`
      // comes back as `placeholder` and auto-naming overwrites their name on
      // the next prompt. The route persists below, so the loss would go to
      // disk. `restoreMuxSessions()` passes it for the same reason.
      nameSource: saved.nameSource,
      createdAt: saved.createdAt,
      mux: ctx.mux,
      useMux: true,
      // No `muxSession`: the reboot took the pane with it, so `startInteractive()`
      // takes its create branch and makes a fresh one.
      claudeMode: await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, saved.owner),
      allowedTools: claudeModeConfig.allowedTools,
      resumeSessionId: entry.resumeConversationId,
      // Re-resolved against the owner's CURRENT grant, never replayed from the
      // record: a grant held when the record was written may be gone now.
      envOverrides: await clampEnvOverridesForOwner(
        saved.owner,
        (saved as { __envOverrides?: Record<string, string> }).__envOverrides
      ),
      effort: saved.effort,
      model: saved.model,
      advisorModel: saved.advisorModel,
      attachmentHistory:
        (saved as { __attachmentHistory?: SessionAttachmentHistoryItem[] }).__attachmentHistory ??
        saved.attachmentHistory,
      lastSubmitAt: saved.lastSubmitAt,
      lastRealPromptAt: saved.lastRealPromptAt,
      keepWarmEnabled: saved.keepWarmEnabled,
      claudeSessionChain: saved.claudeSessionChain,
      lastActivityAt: saved.lastActivityAt,
      owner: saved.owner,
      parentSessionId: saved.parentSessionId,
      // Without it the rebuild would launch the agent LOCALLY in a path that
      // only exists on the remote host. With it, the launch is the remote
      // `ssh … new-session -A`, which attaches to the surviving pane.
      remote: rehydrateRemoteHostFields(saved.remote, remoteHostsById),
    });

    await ctx.addSession(session);
    // Before the listeners, because setupSessionListeners() reads the
    // image-watcher flag this phase restores; before the spawn, because the
    // custom-model environment and the nice priority shape the process.
    await ctx.reapplyPersistedSessionState(session, saved, 'before-spawn');
    await ctx.setupSessionListeners(session);
    await session.startInteractive();
    // The session's own history, applied only once the pane exists: on a
    // failed start these totals would belong to a session that never ran.
    // Both halves precede the route's OWN persist, which matters because a
    // constructed session carries none of this and `toState()` is written
    // wholesale, so persisting first would replace the fuller record with
    // the reduced one and drop the pin that keeps it from being pruned. A
    // listener-driven persist can still land inside the debounce window
    // while the pane starts; the write below repairs the record.
    // `rearmAutoResumeSchedule: false`: the saved stamp predates the reboot and
    // the pane is new, so honouring it would have every restored session type
    // `continue` into itself about a minute after one click. Auto-resume stays
    // enabled and re-arms on the next real limit message. This is also what the
    // module header promises ("comes back attached, idle and disarmed").
    await ctx.reapplyPersistedSessionState(session, saved, 'after-spawn', {
      rearmAutoResumeSchedule: false,
    });
    ctx.persistSessionState(session);

    // A session without its workspace hooks goes silently blind: no stop or
    // idle events for respawn, no Approvals Inbox item, no red tab on a
    // blocking dialog. The boot-time sweep finished hours ago, so the click
    // path installs them itself. `hooks: 'always'` is the capability that says
    // this CLI installs Codeman's hooks into the workspace.
    // Local only: the workspace of a remote session is on the other host.
    if (!session.remote && workspaceHooksEnabled && getCli(session.mode)?.capabilities.hooks === 'always') {
      await applyWorkspaceHooks(session.workingDir, true).catch((err: unknown) =>
        console.warn(`[reboot-restore] hook install failed for ${session.workingDir}: ${getErrorMessage(err)}`)
      );
    }

    // Both create paths seed this; without it a restored claude session's agent
    // skill falls back to writing out the whole ~150-line §0 preamble. Local only,
    // like the create paths: a remote agent reads its skill on its own host, and
    // docker sessions never reach here (the plan rejects them).
    if (!session.remote && agentSkillDir(getCli(session.mode)?.capabilities) && (await ctx.getAgentSkillEnabled())) {
      await seedAgentSessionPreamble(session.id).catch((err: unknown) =>
        console.warn(`[agent-skill] preamble seed failed for ${session.id}: ${getErrorMessage(err)}`)
      );
    }

    getLifecycleLog().log({
      event: 'recovered',
      sessionId: session.id,
      name: session.name,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    // Every other open tab and phone needs this; the clicking tab already has
    // the response, and the client's handler is an idempotent upsert.
    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));
    return session;
  } catch (err) {
    // One entry that will not start must not stop the rest of the pass, and
    // must not leave a registered session with no pane behind it: by this
    // point the session is in `ctx.sessions`, holds a tab-layout slot and has
    // listeners.
    //
    // Reaching this is rarer than it looks, measured against a real server:
    // the CLI resolver finds its binary by absolute path rather than through
    // PATH, and tmux falls back to another directory rather than failing when
    // it cannot enter the workspace, so neither of the two obvious "freshly
    // booted machine" failures throws. What is left is the mux layer itself
    // failing, which is why this path is defended rather than expected.
    console.error(`[reboot-restore] failed to rebuild ${entry.sessionId}:`, err);
    // Not cleanupSession(): that is the user-initiated delete, and it would
    // count this session's historical tokens into the lifetime totals, demote
    // a pinned record to `stopped` (which this pass reads as an intentional
    // kill, making the session permanently unrestorable) and delete the
    // workspace's `.codeman-uploads`. This undoes only the construction.
    await ctx
      .discardPartiallyBuiltSession(entry.sessionId)
      .catch((discardErr: unknown) =>
        console.error(`[reboot-restore] discarding a failed rebuild failed: ${getErrorMessage(discardErr)}`)
      );
    return null;
  }
}
