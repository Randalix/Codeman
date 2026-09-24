/**
 * The guard that makes a mis-started suite die before it can touch real data
 * (src/config/instance.ts `assertTestIsolation`, incident 2026-09-24). Inputs are
 * injected — the real passwd home is never read here.
 */
import { describe, it, expect } from 'vitest';
import { homedir, userInfo } from 'node:os';
import { assertTestIsolation } from '../../src/config/instance.js';

const REAL = '/home/joe';

describe('assertTestIsolation', () => {
  it('refuses when a Vitest run sees the real home (setup.ts did not run)', () => {
    expect(() => assertTestIsolation({ VITEST: 'true' }, REAL, REAL)).toThrow(/real home/);
    expect(() => assertTestIsolation({ VITEST: 'true' }, `${REAL}/`, REAL)).toThrow(/npm test/);
  });

  it('refuses CODEMAN_DATA_DIR inside the real home even with a temp HOME', () => {
    expect(() =>
      assertTestIsolation({ VITEST: 'true', CODEMAN_DATA_DIR: `${REAL}/.codeman` }, '/tmp/codeman-vitest-x', REAL)
    ).toThrow(/CODEMAN_DATA_DIR/);
  });

  it('allows the isolated layout', () => {
    expect(() => assertTestIsolation({ VITEST: 'true' }, '/tmp/codeman-vitest-x', REAL)).not.toThrow();
    // A sibling that merely shares the prefix is not inside the home.
    expect(() =>
      assertTestIsolation({ VITEST: 'true', CODEMAN_DATA_DIR: `${REAL}2/.codeman` }, '/tmp/x', REAL)
    ).not.toThrow();
  });

  it('never interferes outside Vitest (production, the remote agent CLI)', () => {
    expect(() => assertTestIsolation({}, REAL, REAL)).not.toThrow();
  });

  it('passes for this very run (setup.ts moved HOME)', () => {
    expect(() => assertTestIsolation()).not.toThrow();
    expect(homedir()).not.toBe(userInfo().homedir);
  });
});
