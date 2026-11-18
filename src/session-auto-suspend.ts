/**
 * @fileoverview Auto-suspend: suspend a local claude session once it has sat idle for a
 * set time, so its CLI stops holding memory (`autoSuspendEnabled`, `autoSuspendIdleMinutes`
 * in settings.json, both synced, OFF by default).
 *
 * A timer, not a request, so it only ever goes through {@link SessionSuspendRegistry.suspend}
 * and inherits every refusal there: a working session, background work it started, an open
 * dialog, a running respawn controller, a non-claude CLI. On top of that it skips:
 * - **Remote (SSH) sessions.** The stop is an ssh round to the host, and a timer must not
 *   put traffic on a connection whose host decides by its traffic whether to sleep.
 * - **Sessions idle for less than the set time.** Idle counts from the latest of: the last
 *   real prompt (the keep-alive's own does not count), the last keystroke a person sent,
 *   the end of the last turn, the last resume, and the moment this service started, so a
 *   server restart does not suspend every session at once and a session woken with the
 *   Wake button is not put back to sleep on the next tick.
 *
 * A refused session is tried again after {@link AUTO_SUSPEND_RETRY_MS}, and each refusal
 * reason is logged once per session until it changes, so the log stays quiet.
 */

import {
  suspendRefusal,
  type SessionSuspendRegistry,
  type SuspendableSession,
  type SuspendRefusalReason,
} from './session-suspend.js';

export const AUTO_SUSPEND_DEFAULT_IDLE_MINUTES = 60;
export const AUTO_SUSPEND_MIN_IDLE_MINUTES = 5;
export const AUTO_SUSPEND_MAX_IDLE_MINUTES = 1440;
/** How often the service looks for sessions to suspend. */
export const AUTO_SUSPEND_TICK_MS = 60_000;
/** How long a refused session is left alone before the next attempt. */
export const AUTO_SUSPEND_RETRY_MS = 5 * 60_000;

export interface AutoSuspendSettings {
  enabled: boolean;
  idleMinutes: number;
}

/** The auto-suspend settings out of a parsed settings.json; absent or invalid = defaults (OFF). */
export function autoSuspendSettingsFrom(settings: Record<string, unknown> | null | undefined): AutoSuspendSettings {
  const raw = settings?.autoSuspendIdleMinutes;
  const idleMinutes =
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= AUTO_SUSPEND_MIN_IDLE_MINUTES &&
    raw <= AUTO_SUSPEND_MAX_IDLE_MINUTES
      ? raw
      : AUTO_SUSPEND_DEFAULT_IDLE_MINUTES;
  return { enabled: settings?.autoSuspendEnabled === true, idleMinutes };
}

/** The slice of `Session` the service reads, beside what suspend itself needs. */
export interface AutoSuspendableSession extends SuspendableSession {
  readonly lastRealPromptAt: number;
  readonly lastHumanInputAt: number;
  readonly turnEndedAt: number | null;
}

export interface AutoSuspendDeps {
  sessions(): Iterable<AutoSuspendableSession>;
  registry: Pick<SessionSuspendRegistry, 'suspend' | 'isHolding' | 'lastResumedAt'>;
  /** Read fresh on every tick, so a toggle takes effect on the next one. Rejects on a read error. */
  readSettings(): Promise<AutoSuspendSettings>;
  now(): number;
  log(message: string): void;
}

/** When this session last did anything a person or its own turn would count as activity. */
export function idleSince(session: AutoSuspendableSession, floor: number, resumedAt: number): number {
  return Math.max(session.lastRealPromptAt, session.lastHumanInputAt, session.turnEndedAt ?? 0, resumedAt, floor);
}

export class AutoSuspendService {
  private readonly startedAt: number;
  private readonly retryAt = new Map<string, number>();
  private readonly lastReason = new Map<string, SuspendRefusalReason>();
  private running = false;
  private settingsErrorLogged = false;

  constructor(private readonly deps: AutoSuspendDeps) {
    this.startedAt = deps.now();
  }

  /** Forget a deleted session. */
  remove(sessionId: string): void {
    this.retryAt.delete(sessionId);
    this.lastReason.delete(sessionId);
  }

  /** One pass. Resolves with the ids it suspended. Never runs two passes at once. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      let settings: AutoSuspendSettings;
      try {
        settings = await this.deps.readSettings();
        this.settingsErrorLogged = false;
      } catch (err) {
        if (!this.settingsErrorLogged) this.deps.log(`[AutoSuspend] settings unreadable, skipping: ${String(err)}`);
        this.settingsErrorLogged = true;
        return [];
      }
      if (!settings.enabled) return [];
      const idleMs = settings.idleMinutes * 60_000;
      const suspended: string[] = [];
      for (const session of [...this.deps.sessions()]) {
        if (session.remote || this.deps.registry.isHolding(session)) continue;
        // Whatever the pure check refuses (another CLI, docker, adopted, working) is skipped
        // without a word; only the refusals read off the screen are logged below.
        if (suspendRefusal(session)) continue;
        const now = this.deps.now();
        if (now - idleSince(session, this.startedAt, this.deps.registry.lastResumedAt(session.id)) < idleMs) continue;
        if ((this.retryAt.get(session.id) ?? 0) > now) continue;
        const result = await this.deps.registry.suspend(session);
        if (result.ok) {
          this.remove(session.id);
          suspended.push(session.id);
          this.deps.log(`[AutoSuspend] ${session.id.slice(0, 8)}: suspended after ${settings.idleMinutes} min idle`);
          continue;
        }
        this.retryAt.set(session.id, now + AUTO_SUSPEND_RETRY_MS);
        if (this.lastReason.get(session.id) !== result.reason) {
          this.lastReason.set(session.id, result.reason);
          this.deps.log(`[AutoSuspend] ${session.id.slice(0, 8)}: left running (${result.reason})`);
        }
      }
      return suspended;
    } finally {
      this.running = false;
    }
  }
}
