/**
 * @fileoverview A remote claude keeps its conversation across a relaunch and a restart.
 *
 * A remote transcript lives on the host, so the local resume pin (which checks this
 * machine's transcripts) cannot choose for a remote pane. What it resumes instead is
 * what the pane was seen on: the chain, which a pane observation now extends, so it
 * also survives a server restart (state.json carries the chain, not the in-memory id).
 */
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { SessionRemote } from '../src/types/session.js';

const remote = { host: '192.168.50.137', user: 'j', hostId: 'hufflepuff' } as unknown as SessionRemote;
type WithRespawn = { _buildRespawnPaneOptions(): { resumeSessionId?: string } };
const relaunchId = (s: Session) => (s as unknown as WithRespawn)._buildRespawnPaneOptions().resumeSessionId;

describe('remote claude resume', () => {
  it('a pane observation extends the chain without claiming first hand, and the chain persists', () => {
    const session = new Session({ workingDir: '/w', mode: 'claude', remote });
    session.adoptClaudeSessionId('conv-pane', { observedInPane: true });
    expect(session.claudeSessionId).toBe('conv-pane');
    expect(session.claudeSessionChain).toEqual(['conv-pane']);
    expect(session.claudeSessionIdIsFirstHand).toBe(false);
    expect(session.toState().claudeSessionChain).toEqual(['conv-pane']);

    // A server restart rebuilds the session from state: the conversation is still known.
    const restored = new Session({
      id: session.id,
      workingDir: '/w',
      mode: 'claude',
      remote,
      claudeSessionChain: session.toState().claudeSessionChain,
    });
    expect(restored.claudeSessionId).toBe('conv-pane');
    expect(relaunchId(restored)).toBe('conv-pane');
  });

  it('a relaunch resumes the chain tail, not the launch seed', () => {
    const session = new Session({ workingDir: '/w', mode: 'claude', remote, resumeSessionId: 'seed' });
    expect(relaunchId(session)).toBe('seed');
    session.adoptClaudeSessionId('after-clear', { observedInPane: true });
    expect(relaunchId(session)).toBe('after-clear');
  });

  it('a guess never steers a relaunch', () => {
    const session = new Session({ workingDir: '/w', mode: 'claude', remote, resumeSessionId: 'seed' });
    session.adoptClaudeSessionId('guessed');
    expect(relaunchId(session)).toBe('seed');
  });

  it("a suspend's recorded conversation wins over the chain", () => {
    const session = new Session({
      workingDir: '/w',
      mode: 'claude',
      remote,
      claudeSessionChain: ['older'],
      suspendedAt: 1,
      suspendedResumeId: 'at-suspend',
    });
    expect(relaunchId(session)).toBe('at-suspend');
  });

  it('a local session keeps its seed here (its pin checks the transcripts on disk)', () => {
    const session = new Session({ workingDir: '/w', mode: 'claude', resumeSessionId: 'seed' });
    session.adoptClaudeSessionId('hooked', { firstHand: true });
    expect(relaunchId(session)).toBe('seed');
  });
});
