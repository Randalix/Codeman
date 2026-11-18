/**
 * @fileoverview Session suspend: stop an idle session's CLI to free its memory, keep
 * the session (and its dead pane) on the board, and bring the same conversation back
 * on the next input.
 *
 * - **Suspend** stops the pane's process group (`TerminalMultiplexer.stopPaneProcesses`)
 *   and marks the session `suspended`. The tmux session stays, its pane dead under
 *   `remain-on-exit`, and the record is persisted, so the suspend survives a server
 *   restart (the dead-pane branch of `Session._setupOrAttachMuxSession` leaves a
 *   suspended pane alone).
 * - **Resume** relaunches the CLI in the same pane with `Session.restartCli()`, which
 *   pins the conversation to resume (`claude --resume <id>`), waits until the
 *   composer is back, and only then writes the input that arrived meanwhile, in order.
 * - **Input** to a suspended or resuming session (browser keystrokes and
 *   `POST /input`, i.e. also `codeman agent send`) goes to {@link handleInput}: held
 *   here instead of written into a dead pane, where it would vanish, and it triggers
 *   the resume. The pattern is the wake-on-LAN buffer's (`remote-wake.ts`).
 *
 * Covers claude sessions, local and SSH-remote (owned). A remote suspend stops the
 * agent in the durable remote tmux and removes that session (see
 * `stopRemoteTmuxSession`); its resume wakes the host first when it has a wake target
 * (a resume is always a user's request: input or `resume`), then `restartCli()`
 * re-runs `ssh … new-session -A`, which launches claude again with the conversation
 * pinned. Other CLIs need the resume-id capture of Ark0N/Codeman#630, docker and
 * non-owned remote panes are refused with a reason.
 */

/** Cap on input held for one session while it resumes; the oldest chunk goes first. */
export const SUSPEND_INPUT_BUFFER_BYTES = 4096;
/** How long a resume waits for the composer before delivering held input anyway. */
export const SUSPEND_READY_TIMEOUT_MS = 45_000;
/** Pane poll interval while waiting for the composer. */
export const SUSPEND_READY_POLL_MS = 250;

/** The slice of `Session` the registry uses. */
export interface SuspendableSession {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly isWorking: boolean;
  readonly remote?: { owned?: boolean; commands?: { claude?: string } } | null;
  readonly docker?: unknown;
  readonly adopt?: unknown;
  readonly muxName: string | null;
  readonly suspended: boolean;
  /** Background work label cached at the last idle transition (`Session.watching`). */
  readonly watching?: string | null;
  /** Background work read fresh off a pane capture (`Session.backgroundWorkOnScreen`). */
  backgroundWorkOnScreen?(paneText: string): string | null;
  setSuspended(at: number | null): void;
  restartCli(): Promise<boolean>;
  writeViaMux(data: string, options?: { fromUser?: boolean }): Promise<boolean>;
  write(data: string, options?: { fromUser?: boolean }): boolean;
  /** Arm the Enter retry for a prompt that went out raw (`Session.verifySubmitted`). */
  verifySubmitted?(text: string): void;
}

/**
 * How a held chunk is written once the CLI is back, the same way it would have been
 * written to a live session: `raw` straight into the pane (browser keystrokes,
 * `POST /input` with control bytes), `mux` through `writeViaMux` (a plain prompt:
 * pasted, Enter pressed separately). `writeViaMux` trims whitespace, so a lone space
 * keystroke sent that way vanishes.
 */
export type HeldInputMode = 'raw' | 'mux';

interface HeldChunk {
  data: string;
  mode: HeldInputMode;
}

export interface SessionSuspendDeps {
  /** Stop the pane's processes, keep the tmux session. Resolves true once the pane is dead. */
  stopPane(sessionId: string): Promise<boolean>;
  /** Visible pane text, or null when it cannot be read. */
  capturePane(muxName: string): string | null;
  /** Persist the session record and broadcast `session:updated`. */
  persist(session: SuspendableSession): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /**
   * Remote sessions: make sure the host is up before the relaunch, waking it when it
   * has a wake target. False = it stayed unreachable (the session stays suspended).
   */
  wakeHostForResume?(session: SuspendableSession): Promise<boolean>;
  /**
   * True while a respawn controller drives this session. Its cycle types prompts,
   * `/clear` and `/init` into the idle session, so a suspend would stall it.
   */
  respawnRunning?(sessionId: string): boolean;
  /** The CLI runs again (remote: lift the auto-reconnect lock taken by the stop). */
  onResumed?(session: SuspendableSession): void;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export type SuspendRefusalReason =
  | 'already-suspended'
  | 'busy'
  | 'background-work'
  | 'respawn-active'
  | 'unsupported-mode'
  | 'remote-not-owned'
  | 'remote-override'
  | 'docker'
  | 'adopted'
  | 'no-mux'
  | 'stop-failed';

export type SuspendResult = { ok: true } | { ok: false; reason: SuspendRefusalReason; message: string };

/** Why this session cannot be suspended, or null when it can. Pure. */
export function suspendRefusal(session: SuspendableSession): { reason: SuspendRefusalReason; message: string } | null {
  if (session.suspended) return { reason: 'already-suspended', message: 'The session is already suspended.' };
  if (session.remote && session.remote.owned === false) {
    return {
      reason: 'remote-not-owned',
      message: 'This pane is attached to a remote tmux session Codeman did not start; it cannot be suspended.',
    };
  }
  if (session.remote?.commands?.claude) {
    return {
      reason: 'remote-override',
      message: 'The host runs claude through its own command override, so a resume could not pin the conversation.',
    };
  }
  if (session.docker) {
    return { reason: 'docker', message: 'Docker sessions cannot be suspended yet.' };
  }
  if (session.adopt) return { reason: 'adopted', message: 'Adopted panes cannot be suspended.' };
  if (session.mode !== 'claude') {
    return {
      reason: 'unsupported-mode',
      message: `Only claude sessions can be suspended for now (this one runs ${session.mode}).`,
    };
  }
  if (!session.muxName) return { reason: 'no-mux', message: 'The session has no tmux pane.' };
  if (session.isWorking || session.status === 'busy') {
    return { reason: 'busy', message: 'The session is working; suspend it once it is idle.' };
  }
  return null;
}

/**
 * True when the visible pane shows claude's composer: a `❯` line among the last
 * rows. The scrolled-back conversation above it does not count, so a resumed
 * transcript that quotes `❯` earlier is not mistaken for readiness.
 */
export function paneShowsComposer(text: string | null): boolean {
  if (!text) return false;
  const rows = text
    .split('\n')
    .map((r) => r.trimEnd())
    .filter((r) => r.length > 0);
  return rows.slice(-8).some((r) => /^\s*[❯❯]/.test(r));
}

/**
 * The text of the last line in `keys` that ended with Enter, as the composer shows
 * it: escape sequences and other control bytes dropped, backspace applied. Empty
 * when no Enter was typed or the line was empty.
 */
export function lastSubmittedLine(keys: string): string {
  const end = keys.lastIndexOf('\r');
  if (end < 0) return '';
  const before = keys.slice(0, end);
  const start = before.lastIndexOf('\r') + 1;
  const line = before
    .slice(start)
    // CSI/SS3 sequences (arrows, bracketed-paste markers), then any lone ESC + char.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1bO./g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b./g, '');
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '\x7f' || ch === '\b') out.pop();
    else if (ch >= ' ' || ch === '\t') out.push(ch);
  }
  return out.join('').trim();
}

interface SuspendState {
  pending: HeldChunk[];
  pendingBytes: number;
  resuming: Promise<boolean> | null;
}

export class SessionSuspendRegistry {
  private readonly states = new Map<string, SuspendState>();

  constructor(private readonly deps: SessionSuspendDeps) {}

  private backgroundWork(session: SuspendableSession): string | null {
    const text = session.muxName ? this.deps.capturePane(session.muxName) : null;
    if (text !== null && session.backgroundWorkOnScreen) return session.backgroundWorkOnScreen(text);
    return session.watching ?? null;
  }

  /** Should input to this session be handed to {@link handleInput} instead of written? */
  isHolding(session: SuspendableSession): boolean {
    return session.suspended || this.states.get(session.id)?.resuming != null;
  }

  async suspend(session: SuspendableSession): Promise<SuspendResult> {
    const refusal = suspendRefusal(session);
    if (refusal) return { ok: false, ...refusal };
    if (this.states.get(session.id)?.resuming) {
      return { ok: false, reason: 'busy', message: 'The session is resuming right now.' };
    }
    // The respawn controller types into an idle session on its own. It is left alone
    // rather than woken (a resume wakes a remote host), so it is stopped first.
    if (this.deps.respawnRunning?.(session.id)) {
      return {
        ok: false,
        reason: 'respawn-active',
        message: 'Respawn is running for this session; stop it before suspending.',
      };
    }
    // An idle session can still run monitors, background shells or workflows it started
    // (Ark0N in #836): stopping the CLI ends them. Read off the screen now; the cached
    // label only stands in when the pane cannot be captured.
    const work = this.backgroundWork(session);
    if (work) {
      return {
        ok: false,
        reason: 'background-work',
        message: `The session still runs background work (${work}); suspending would end it. Suspend it once that has finished.`,
      };
    }
    // Marked before the stop, so the exit the pane watcher reads in the meantime meets a
    // suspended session (the clean-exit sweep and the respawn paths skip it).
    session.setSuspended(this.deps.now());
    let stopped = false;
    try {
      stopped = await this.deps.stopPane(session.id);
    } catch (err) {
      this.deps.log(`[Suspend] ${session.id.slice(0, 8)}: stop threw: ${String(err)}`);
    }
    if (!stopped) {
      session.setSuspended(null);
      this.deps.persist(session);
      return { ok: false, reason: 'stop-failed', message: 'The CLI process could not be stopped.' };
    }
    this.deps.persist(session);
    this.deps.log(`[Suspend] ${session.id.slice(0, 8)}: suspended`);
    return { ok: true };
  }

  /**
   * Bring a suspended session back. Single-flight: concurrent callers share one
   * relaunch. Resolves true when the CLI runs again (held input delivered), false
   * when the relaunch failed (the session stays suspended, held input kept).
   */
  resume(session: SuspendableSession): Promise<boolean> {
    const state = this.state(session.id);
    if (state.resuming) return state.resuming;
    if (!session.suspended) return Promise.resolve(true);
    const run = this.doResume(session, state).finally(() => {
      state.resuming = null;
      if (state.pending.length === 0) this.states.delete(session.id);
    });
    state.resuming = run;
    return run;
  }

  /**
   * Input for a session that {@link isHolding}: held in order and delivered after the
   * resume, which this starts if it is not running yet. `dropped` = the chunk did not
   * fit the buffer and is gone.
   */
  handleInput(session: SuspendableSession, data: string, mode: HeldInputMode = 'raw'): 'buffered' | 'dropped' {
    const state = this.state(session.id);
    let outcome: 'buffered' | 'dropped' = 'buffered';
    if (data.length > SUSPEND_INPUT_BUFFER_BYTES) {
      outcome = 'dropped';
    } else {
      state.pending.push({ data, mode });
      state.pendingBytes += data.length;
      while (state.pendingBytes > SUSPEND_INPUT_BUFFER_BYTES && state.pending.length > 1) {
        const old = state.pending.shift()!;
        state.pendingBytes -= old.data.length;
        this.deps.log(
          `[Suspend] ${session.id.slice(0, 8)}: input buffer full, dropped ${old.data.length} oldest bytes`
        );
      }
    }
    if (!state.resuming && session.suspended) {
      void this.resume(session).catch((err) => {
        this.deps.log(`[Suspend] ${session.id.slice(0, 8)}: resume failed: ${String(err)}`);
      });
    }
    return outcome;
  }

  /** Drop all state for a session that was closed. */
  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private state(id: string): SuspendState {
    let s = this.states.get(id);
    if (!s) {
      s = { pending: [], pendingBytes: 0, resuming: null };
      this.states.set(id, s);
    }
    return s;
  }

  private async doResume(session: SuspendableSession, state: SuspendState): Promise<boolean> {
    const id8 = session.id.slice(0, 8);
    this.deps.log(`[Suspend] ${id8}: resuming`);
    if (session.remote && this.deps.wakeHostForResume) {
      let awake = false;
      try {
        awake = await this.deps.wakeHostForResume(session);
      } catch (err) {
        this.deps.log(`[Suspend] ${id8}: host wake threw: ${String(err)}`);
      }
      if (!awake) {
        this.deps.log(`[Suspend] ${id8}: host not reachable, session stays suspended`);
        return false;
      }
    }
    let restarted = false;
    try {
      restarted = await session.restartCli();
    } catch (err) {
      this.deps.log(`[Suspend] ${id8}: restartCli threw: ${String(err)}`);
    }
    if (!restarted) {
      this.deps.log(`[Suspend] ${id8}: relaunch failed, session stays suspended`);
      return false;
    }
    session.setSuspended(null);
    this.deps.persist(session);
    this.deps.onResumed?.(session);

    // Held input goes in only once claude shows its composer: typed into a CLI that
    // is still loading its transcript, keystrokes are lost or land in a dialog.
    const timeout = this.deps.readyTimeoutMs ?? SUSPEND_READY_TIMEOUT_MS;
    const poll = this.deps.readyPollMs ?? SUSPEND_READY_POLL_MS;
    const deadline = this.deps.now() + timeout;
    let last: string | null = null;
    let ready = false;
    while (this.deps.now() < deadline) {
      const text = session.muxName ? this.deps.capturePane(session.muxName) : null;
      // Two equal reads in a row: the redraw is done, not mid-frame.
      if (paneShowsComposer(text) && text === last) {
        ready = true;
        break;
      }
      last = text;
      await this.deps.sleep(poll);
    }
    if (!ready) this.deps.log(`[Suspend] ${id8}: composer not seen within ${timeout} ms, delivering anyway`);

    let raw = '';
    while (state.pending.length > 0) {
      const chunk = state.pending.shift()!;
      state.pendingBytes -= chunk.data.length;
      let ok = false;
      if (chunk.mode === 'mux') {
        ok = await session.writeViaMux(chunk.data, { fromUser: true }).catch(() => false);
        // That prompt armed its own retry and is the newest submit; earlier keystrokes
        // must not re-arm the verifier over it.
        if (ok) raw = '';
      } else {
        try {
          ok = session.write(chunk.data, { fromUser: true });
        } catch {
          ok = false;
        }
        if (ok) raw += chunk.data;
      }
      if (!ok) this.deps.log(`[Suspend] ${id8}: held input could not be written (${chunk.data.length} bytes)`);
    }
    // `mux` chunks arm the Enter retry inside writeViaMux. Raw keystrokes go through
    // write(), which does not, and Claude Code can still be ignoring Enter right after
    // the start (#836). Arm it for the last line that was typed and submitted.
    const submitted = lastSubmittedLine(raw);
    if (submitted) session.verifySubmitted?.(submitted);
    this.deps.log(`[Suspend] ${id8}: resumed`);
    return true;
  }
}

const REGISTRY_KEY = Symbol.for('codeman.sessionSuspend');

/**
 * Hang the registry on the routes' shared ctx, so every route registered on it (the
 * WebSocket input route, the server's cleanup) reaches the same instance.
 */
export function attachSuspendRegistry(ctx: object, registry: SessionSuspendRegistry): void {
  (ctx as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
}

/** The registry `attachSuspendRegistry` hung on ctx, or undefined (tests, older wiring). */
export function suspendRegistryOf(ctx: object): SessionSuspendRegistry | undefined {
  const r = (ctx as Record<symbol, unknown>)[REGISTRY_KEY];
  return r instanceof SessionSuspendRegistry ? r : undefined;
}
