/**
 * @fileoverview A suspended session stays suspended across a server restart
 * (session-suspend.ts). Boot recovery calls `startInteractive()` on every surviving
 * tmux session, and its dead-pane branch relaunches the CLI. For a suspended
 * session that must not happen: the pane is dead on purpose, and only a resume
 * (input or `POST /resume`) relaunches it. Driven through `startInteractive()`,
 * with the persisted `suspendedAt` restored through the constructor like
 * `restoreMuxSessions()` does.
 *
 * Port: none (fake multiplexer)
 */
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, RespawnPaneOptions, TerminalMultiplexer } from '../src/mux-interface.js';

function deadPaneMux() {
  const respawns: RespawnPaneOptions[] = [];
  const mux = {
    isAvailable: () => true,
    muxSessionExists: () => true,
    isPaneDead: () => true,
    setAttached: () => {},
    respawnPane: async (options: RespawnPaneOptions) => {
      respawns.push(options);
      return 4242;
    },
  };
  return { mux: mux as unknown as TerminalMultiplexer, respawns };
}

const muxSession = { muxName: 'codeman-aaaa', sessionId: 'aaaa' } as unknown as MuxSession;

function session(mux: TerminalMultiplexer, extra: Record<string, unknown> = {}) {
  return new Session({ workingDir: '/tmp', mode: 'claude', useMux: true, mux, muxSession, ...extra });
}

describe('boot recovery and a suspended session', () => {
  it('does not relaunch the dead pane of a suspended session', async () => {
    const { mux, respawns } = deadPaneMux();
    const s = session(mux, { suspendedAt: 1_700_000_000_000 });
    expect(s.suspended).toBe(true);
    await s.startInteractive();
    try {
      expect(respawns).toHaveLength(0);
      expect(s.suspended).toBe(true);
      expect(s.toState()).toMatchObject({ suspended: true, suspendedAt: 1_700_000_000_000 });
    } finally {
      await s.stop();
    }
  });

  it('still relaunches the dead pane of a session that is not suspended', async () => {
    const { mux, respawns } = deadPaneMux();
    const s = session(mux);
    await s.startInteractive();
    try {
      expect(respawns).toHaveLength(1);
      expect(s.toState().suspended).toBeUndefined();
    } finally {
      await s.stop();
    }
  });
});
