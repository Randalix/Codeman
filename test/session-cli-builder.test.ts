/**
 * @fileoverview Tests for CLI environment builders.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMuxAttachEnv, buildShellEnv, resolveSessionLocale } from '../src/session-cli-builder.js';

/**
 * The locale every pane runs under.
 *
 * The bug: `LANG`/`LC_ALL` were hardcoded to `en_US.UTF-8`, which does not exist
 * on a host that only generated another UTF-8 locale — a German Debian with just
 * `de_DE.UTF-8`, measured on Albus where /etc/locale.gen leaves en_US commented
 * out. Every pane then printed `setlocale: LC_ALL: cannot change locale
 * (en_US.UTF-8)` and ran in the C locale, i.e. exactly the non-UTF-8 state the
 * docker path pins `C.UTF-8` to avoid (tmux renders box drawing as `qqqq…`).
 */
describe('resolveSessionLocale', () => {
  it('keeps a UTF-8 locale the host already advertises', () => {
    expect(resolveSessionLocale({ LANG: 'de_DE.UTF-8' })).toBe('de_DE.UTF-8');
    expect(resolveSessionLocale({ LANG: 'en_GB.utf8' })).toBe('en_GB.utf8');
  });

  it('prefers LC_ALL, then LC_CTYPE, then LANG — the same order as detectGlyphTier', () => {
    expect(resolveSessionLocale({ LC_ALL: 'a.UTF-8', LC_CTYPE: 'b.UTF-8', LANG: 'c.UTF-8' })).toBe('a.UTF-8');
    expect(resolveSessionLocale({ LC_CTYPE: 'b.UTF-8', LANG: 'c.UTF-8' })).toBe('b.UTF-8');
    expect(resolveSessionLocale({ LANG: 'c.UTF-8' })).toBe('c.UTF-8');
  });

  it('falls back to C.UTF-8, which needs no locale-gen, when nothing UTF-8 is inherited', () => {
    expect(resolveSessionLocale({})).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'C' })).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'POSIX' })).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'de_DE.ISO-8859-1' })).toBe('C.UTF-8');
  });

  it('refuses a name that could break out of the pane shell command', () => {
    // tmux-manager interpolates this into `export LANG=<value>`.
    expect(resolveSessionLocale({ LANG: 'de_DE.UTF-8; rm -rf /' })).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'de_DE.UTF-8$(id)' })).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'de DE.UTF-8' })).toBe('C.UTF-8');
    expect(resolveSessionLocale({ LANG: 'de_DE.UTF-8`id`' })).toBe('C.UTF-8');
  });

  it('accepts the modifier form, which is legal locale syntax', () => {
    expect(resolveSessionLocale({ LANG: 'sr_RS.UTF-8@latin' })).toBe('sr_RS.UTF-8@latin');
  });

  it('is what the session env builders put in LANG and LC_ALL', () => {
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    try {
      process.env.LC_ALL = 'de_DE.UTF-8';
      expect(buildShellEnv('sess-1').LANG).toBe('de_DE.UTF-8');
      expect(buildShellEnv('sess-1').LC_ALL).toBe('de_DE.UTF-8');
      expect(buildMuxAttachEnv().LANG).toBe('de_DE.UTF-8');

      delete process.env.LC_ALL;
      delete process.env.LANG;
      expect(buildShellEnv('sess-1').LANG).toBe('C.UTF-8');
    } finally {
      if (saved.LANG === undefined) delete process.env.LANG;
      else process.env.LANG = saved.LANG;
      if (saved.LC_ALL === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = saved.LC_ALL;
    }
  });

  it('is what the tmux pane wrapper exports, not a literal', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
    expect(source).not.toContain("'export LANG=en_US.UTF-8'");
    expect(source).not.toContain("'export LC_ALL=en_US.UTF-8'");
    expect(source).toContain('`export LANG=${locale}`');
    expect(source).toContain('`export LC_ALL=${locale}`');
  });
});

describe('buildMuxAttachEnv', () => {
  it('does not pass an inherited tmux context into tmux attach clients', () => {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    process.env.TMUX = '/tmp/tmux-1000/codeman,1169416,9';
    process.env.TMUX_PANE = '%9';

    try {
      const env = buildMuxAttachEnv();

      expect(env.TMUX).toBeUndefined();
      expect(env.TMUX_PANE).toBeUndefined();
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
    }
  });

  // COD-115: `{...process.env, TMUX: undefined}` leaves the KEY present with value
  // undefined; node-pty serializes that as the literal string "TMUX=undefined", which
  // still trips tmux's nesting guard and kills the attach-bridge PTY (exit 1 → respawn
  // loop). The keys must be genuinely ABSENT, which only `delete` achieves.
  it('deletes tmux/claude context keys entirely (absent, not present-with-undefined) (COD-115)', () => {
    const saved = {
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      CLAUDECODE: process.env.CLAUDECODE,
    };
    process.env.TMUX = '/tmp/tmux-1000/codeman,1169416,9';
    process.env.TMUX_PANE = '%9';
    process.env.CLAUDECODE = '1';

    try {
      const env = buildMuxAttachEnv();

      expect('TMUX' in env).toBe(false);
      expect('TMUX_PANE' in env).toBe(false);
      expect('CLAUDECODE' in env).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });
});

describe('spawn env CODEMAN_API_URL (no fallback)', () => {
  const withApiUrl = (value: string | undefined, fn: () => void) => {
    const original = process.env.CODEMAN_API_URL;
    if (value === undefined) delete process.env.CODEMAN_API_URL;
    else process.env.CODEMAN_API_URL = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env.CODEMAN_API_URL;
      else process.env.CODEMAN_API_URL = original;
    }
  };

  it('passes the server-stamped URL through verbatim', async () => {
    const { buildClaudeEnv, buildShellEnv } = await import('../src/session-cli-builder.js');
    withApiUrl('https://127.0.0.1:3199', () => {
      expect(buildClaudeEnv('test-session').CODEMAN_API_URL).toBe('https://127.0.0.1:3199');
      expect(buildShellEnv('test-session').CODEMAN_API_URL).toBe('https://127.0.0.1:3199');
    });
  });

  // A hardcoded fallback was the wrong scheme on HTTPS installs. The key must be
  // genuinely ABSENT when unset: present-with-undefined would serialize through
  // node-pty as the literal string "CODEMAN_API_URL=undefined" (COD-115).
  it('leaves the key absent (not undefined, not a fallback) when the server has not stamped one', async () => {
    const { buildClaudeEnv, buildShellEnv } = await import('../src/session-cli-builder.js');
    withApiUrl(undefined, () => {
      for (const env of [buildClaudeEnv('test-session'), buildShellEnv('test-session')]) {
        expect('CODEMAN_API_URL' in env).toBe(false);
        expect(JSON.stringify(env)).not.toContain('localhost:3000');
      }
    });
  });
});
