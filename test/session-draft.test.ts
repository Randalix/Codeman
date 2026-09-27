/**
 * @fileoverview Session.hasDraft(): unsubmitted text in the composer, which the inbox
 * nudger must never type over (its line plus Enter would submit a human's draft).
 */

import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

describe('Session.hasDraft', () => {
  it('is set by printable input without Enter and cleared by a submit', () => {
    const s = new Session({ workingDir: '/tmp' });
    expect(s.hasDraft()).toBe(false);
    s.write('half a prom');
    expect(s.hasDraft()).toBe(true);
    s.write('pt\r');
    expect(s.hasDraft()).toBe(false);
  });

  it('ignores escape sequences and bare control bytes', () => {
    const s = new Session({ workingDir: '/tmp' });
    s.write('\u001b[A'); // arrow up
    s.write('\u001b'); // interrupt
    s.write('\u0003');
    expect(s.hasDraft()).toBe(false);
  });

  it('a hook-reported submit clears it too', () => {
    const s = new Session({ workingDir: '/tmp' });
    s.write('draft');
    s.markPromptSubmitted();
    expect(s.hasDraft()).toBe(false);
  });
});
