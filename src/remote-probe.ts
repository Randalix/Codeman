/**
 * @fileoverview Plain TCP reachability probe for a remote host. Never wakes it.
 *
 * Split out of `remote-wake.ts` so that code which must never wake a host can probe
 * without importing the wake registry: the wiring guard in test/remote-wake.test.ts
 * allows exactly one importer of `remote-wake` (the input route).
 *
 * @module remote-probe
 */

import net from 'node:net';

/** Mirrors remote-wake's REMOTE_WAKE_PROBE_TIMEOUT_MS / DEFAULT_SSH_PORT. */
const REMOTE_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_PROBE_PORT = 22;

/**
 * Cheap reachability probe: a bare TCP connect to the SSH port. Only meaningful for a
 * host the wake registry deems probeable (`isProbeable` in remote-wake.ts); the
 * registry never asks it about a proxied host.
 *
 * Deliberately NOT an `ssh … true` probe: that opens a full session (auth,
 * remote log, process) every throttle window for a question a SYN already
 * answers. Any byte count it does move is a few hundred bytes per probe, far
 * below the remote idle detector's traffic threshold, so probing cannot keep a
 * host awake.
 */
export function probeRemoteHostReachable(
  remote: { host: string; port?: number },
  timeoutMs = REMOTE_PROBE_TIMEOUT_MS
): Promise<boolean> {
  // Under vitest no real TCP connect may happen (remote-wake's assertNotUnderTest,
  // which this module cannot import without breaking the wiring guard).
  if (process.env.VITEST) {
    throw new Error('remote-probe: the TCP probe is disabled under test — inject a fake');
  }
  const port = remote.port ?? DEFAULT_PROBE_PORT;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: remote.host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
