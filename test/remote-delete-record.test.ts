/**
 * @fileoverview The `deleted` lifecycle record of a REMOTE session names its host, so
 * `codeman agent restore` can find the remote case (host + path) to rebuild it in.
 *
 * Drives the real `WebServer._doCleanupSession` on a stub `this` up to the lifecycle
 * write, then stops it there (the rest of the teardown is not what this pins).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { getLifecycleLog } from '../src/session-lifecycle-log.js';

const STOP = new Error('stop after the lifecycle write');

function cleanupWith(session: Record<string, unknown>) {
  const server = Object.create(WebServer.prototype) as Record<string, unknown>;
  server.sessions = new Map([['s1', session]]);
  server.keepWarmService = { remove: () => {} };
  server.gitFetchScheduler = { remove: () => {} };
  server.store = { getSession: () => undefined };
  const log = vi.spyOn(getLifecycleLog(), 'log').mockImplementation(() => {
    throw STOP;
  });
  const run = (
    server._doCleanupSession as (id: string, kill: boolean, reason: string, layout: boolean) => Promise<void>
  )
    .call(server, 's1', true, 'user_delete', false)
    .catch((e: unknown) => e);
  return { log, run };
}

describe('deleted lifecycle record', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a remote session records its host next to the remote path', async () => {
    const { log, run } = cleanupWith({
      name: 'kartenplan',
      mode: 'claude',
      workingDir: '/mnt/build/neon_getaway-kartenplan',
      claudeSessionId: 'd5cfef48-103c-4f55-82a8-ba3f539903ad',
      remote: { hostId: 'hufflepuff', remotePath: '/mnt/build/neon_getaway-kartenplan' },
    });
    expect(await run).toBe(STOP);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'deleted',
        extra: {
          workingDir: '/mnt/build/neon_getaway-kartenplan',
          cliSessionId: 'd5cfef48-103c-4f55-82a8-ba3f539903ad',
          remote: true,
          hostId: 'hufflepuff',
        },
      })
    );
  });

  it('a local session carries no host', async () => {
    const { log, run } = cleanupWith({ name: 'w1', mode: 'claude', workingDir: '/cases/A', claudeSessionId: 'x' });
    expect(await run).toBe(STOP);
    expect(log.mock.calls[0][0].extra).toEqual({ workingDir: '/cases/A', cliSessionId: 'x', remote: false });
  });
});
