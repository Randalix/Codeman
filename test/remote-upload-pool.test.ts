/**
 * @fileoverview Ark0N's review points 1 and 2 on #837:
 * 1. Remote prompt uploads run in a pool of their own, so a long upload never holds a slot
 *    the shared remote file pool (previews, probes, history reads) waits on.
 * 2. Staging folders left by a server that died mid-upload are swept at the next start.
 */
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveRemoteSshCount,
  getRemoteSshLimit,
  getRemoteUploadPool,
  runWithRemoteSshLimit,
  runWithRemoteUploadLimit,
  SshSlotPool,
} from '../src/remote-ssh-limiter.js';
import { sweepRemoteUploadStaging } from '../src/web/routes/session-routes.js';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('remote upload pool', () => {
  it('uploads holding every upload slot leave the shared pool free', async () => {
    const pool = getRemoteUploadPool();
    const held = Array.from({ length: pool.limit }, () => gate());
    const uploads = held.map((g) => runWithRemoteUploadLimit(() => g.opened));
    expect(pool.activeCount).toBe(pool.limit);

    // A preview read runs at once, and the shared pool counts nothing for the uploads.
    expect(await runWithRemoteSshLimit(async () => getActiveRemoteSshCount())).toBe(1);

    // One more upload waits in its own queue, not in the shared one.
    let thirdRan = false;
    const third = runWithRemoteUploadLimit(async () => {
      thirdRan = true;
    });
    await Promise.resolve();
    expect(thirdRan).toBe(false);
    expect(pool.queuedCount).toBe(1);

    held.forEach((g) => g.open());
    await Promise.all([...uploads, third]);
    expect(thirdRan).toBe(true);
    expect(pool.activeCount).toBe(0);
  });

  it('a full shared pool does not block an upload', async () => {
    const held = Array.from({ length: getRemoteSshLimit() }, () => gate());
    const reads = held.map((g) => runWithRemoteSshLimit(() => g.opened));
    expect(await runWithRemoteUploadLimit(async () => 'copied')).toBe('copied');
    held.forEach((g) => g.open());
    await Promise.all(reads);
  });

  it('defaults to two upload slots', () => {
    expect(process.env.CODEMAN_MAX_REMOTE_UPLOAD_SSH).toBeUndefined();
    expect(getRemoteUploadPool().limit).toBe(2);
  });

  it('SshSlotPool hands a released slot to the next waiter, FIFO', async () => {
    const pool = new SshSlotPool(1);
    const order: string[] = [];
    const first = gate();
    const a = pool.run(async () => {
      order.push('a');
      await first.opened;
    });
    const b = pool.run(async () => void order.push('b'));
    const c = pool.run(async () => void order.push('c'));
    expect(pool.queuedCount).toBe(2);
    first.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(pool.activeCount).toBe(0);
  });
});

describe('sweepRemoteUploadStaging', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'codeman-staging-test-'));
    dirs.push(d);
    return d;
  };

  it('removes leftover remote-* folders, keeps newer ones and anything else, never follows a link', async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, 'precious'), 'x');
    const past = (Date.now() - 3_600_000) / 1000;

    mkdirSync(join(root, 'remote-left'));
    writeFileSync(join(root, 'remote-left', 'paste-1.mp4'), 'half a video');
    utimesSync(join(root, 'remote-left'), past, past);
    mkdirSync(join(root, 'other'));
    utimesSync(join(root, 'other'), past, past);
    symlinkSync(outside, join(root, 'remote-link'));

    const startedAt = Date.now();
    mkdirSync(join(root, 'remote-live')); // an upload that began while the sweep ran
    utimesSync(join(root, 'remote-live'), (startedAt + 1000) / 1000, (startedAt + 1000) / 1000);

    // The link predates startedAt; lstat reads the link itself, so only the link goes.
    const removed = await sweepRemoteUploadStaging(root, startedAt + 500);
    expect(existsSync(join(root, 'remote-left'))).toBe(false);
    expect(existsSync(join(root, 'remote-live'))).toBe(true);
    expect(existsSync(join(root, 'other'))).toBe(true);
    expect(existsSync(join(root, 'remote-link'))).toBe(false);
    expect(existsSync(join(outside, 'precious'))).toBe(true);
    expect(removed).toBe(2);
  });

  it('a missing staging root is nothing to do', async () => {
    expect(await sweepRemoteUploadStaging(join(temp(), 'never-created'))).toBe(0);
  });
});
