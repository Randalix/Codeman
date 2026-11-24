/**
 * @fileoverview Global concurrency limiter for the short-lived `ssh` children that
 * remote-case file access spawns (`src/remote-files.ts`: the realpath+stat probe and
 * the buffered text read). A remote session's full-history load reads its scrollback
 * from the remote tmux through the same pool (`src/remote-pane-history.ts`), with a
 * bounded wait (`maxWaitMs`) because it has the local capture to fall back on.
 *
 * Two paths can fan those out without a human behind each one:
 *
 * - `GET /api/sessions/:id/attachments` resolves every history entry (up to
 *   `ATTACHMENT_HISTORY_LIMIT`, 100), and the attachments drawer re-runs it on every
 *   `attachment:detected` event while it is open, which is exactly when an agent is
 *   writing files. The route now batches the probes, but a burst of drawers is still
 *   a burst.
 * - A `codeman://attach?path=` magic link in terminal output registers the path
 *   fire-and-forget, once per distinct link per PTY chunk. In a remote session that
 *   output is written by a process on the remote host, so a prompt-injected agent can
 *   print hundreds of links and have the server fork one `ssh` per link, each holding
 *   a 20s probe timeout.
 *
 * Without a cap that is the fork-bomb shape `document-conversion-limiter.ts` exists to
 * prevent, and it also trips OpenSSH's default `MaxStartups 10:30:100`, which starts
 * dropping connections at ten unauthenticated handshakes. This is that limiter for
 * ssh: a small fixed pool, FIFO queueing, and a slot handed straight to the next
 * waiter on release so the active count can never exceed the cap under interleaved
 * async resumption.
 *
 * Streams (`remoteCreateReadStream`) are deliberately NOT counted: one is opened per
 * browser request and held for the life of a media playback, so four open videos
 * would otherwise block every preview and the history list. They are already gated
 * behind a counted probe (the guard re-probe runs first), so their spawn RATE is
 * bounded here even though their concurrency is bounded by the browser.
 *
 * Prompt uploads into a remote session (`remoteWriteUpload`) run in a pool of their own
 * ({@link runWithRemoteUploadLimit}): one copies up to `MAX_PASTE_VIDEO_BYTES` (1 GiB) and
 * may take an hour on a slow link, which in the shared pool would hold a slot that every
 * preview, probe and history read waits on (Ark0N in #837). The two caps together (4 + 2
 * by default) still stay under OpenSSH's ten-handshake default.
 *
 * NOT re-entrant: never acquire from inside a task already holding a slot of the same pool.
 */

/** Thrown when `maxWaitMs` passed before a slot freed up. */
export class RemoteSshSlotTimeoutError extends Error {
  constructor(maxWaitMs: number) {
    super(`No remote ssh slot within ${maxWaitMs} ms`);
    this.name = 'RemoteSshSlotTimeoutError';
  }
}

/** A fixed pool of slots with FIFO queueing; a released slot goes straight to the next waiter. */
export class SshSlotPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  private acquire(maxWaitMs?: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    if (maxWaitMs === undefined) return new Promise<void>((resolve) => this.waiters.push(resolve));
    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      // A timed-out waiter leaves the queue and is never handed a slot, so it
      // owns nothing to give back: `active` is untouched on this path.
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return; // already handed a slot by release()
        this.waiters.splice(index, 1);
        reject(new RemoteSshSlotTimeoutError(maxWaitMs));
      }, maxWaitMs);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter; `active` stays at the cap.
      next();
    } else {
      this.active--;
    }
  }

  /**
   * Run `task` once a slot is free, releasing it afterward. With `maxWaitMs`, give up
   * instead (rejecting with {@link RemoteSshSlotTimeoutError}, `task` never runs).
   */
  async run<T>(task: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
    await this.acquire(opts.maxWaitMs);
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

function capFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

/**
 * Max remote probes/reads allowed to run concurrently across the whole process.
 * Override with CODEMAN_MAX_REMOTE_FILE_SSH (clamped to >= 1). Four keeps a burst
 * well under OpenSSH's ten-handshake default.
 */
const sharedPool = new SshSlotPool(capFromEnv('CODEMAN_MAX_REMOTE_FILE_SSH', 4));

/**
 * Max concurrent prompt uploads into remote sessions. Override with
 * CODEMAN_MAX_REMOTE_UPLOAD_SSH (clamped to >= 1). The upload route's own rate buckets
 * bound how fast they start.
 */
const uploadPool = new SshSlotPool(capFromEnv('CODEMAN_MAX_REMOTE_UPLOAD_SSH', 2));

/** Test/diagnostic hook: remote calls currently holding a slot. */
export function getActiveRemoteSshCount(): number {
  return sharedPool.activeCount;
}

/** Test/diagnostic hook: remote calls queued behind the cap. */
export function getQueuedRemoteSshCount(): number {
  return sharedPool.queuedCount;
}

/** The configured cap, so a test can assert against the real number. */
export function getRemoteSshLimit(): number {
  return sharedPool.limit;
}

/** Test/diagnostic hook: the upload pool, separate from the shared one. */
export function getRemoteUploadPool(): SshSlotPool {
  return uploadPool;
}

/**
 * Run `task` once an ssh slot is free, releasing the slot afterward. With
 * `maxWaitMs`, give up instead (rejecting with {@link RemoteSshSlotTimeoutError},
 * `task` never runs) when no slot frees up in time: for a caller that has a
 * cheaper answer than waiting behind the queue.
 */
export function runWithRemoteSshLimit<T>(task: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  return sharedPool.run(task, opts);
}

/**
 * Run a remote prompt upload in the upload pool, never in the shared one. Callers pass
 * `maxWaitMs`: an upload's own timeout only starts once it holds a slot, so without a
 * bound a screenshot would wait, request open, behind two long video copies.
 */
export function runWithRemoteUploadLimit<T>(task: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  return uploadPool.run(task, opts);
}
