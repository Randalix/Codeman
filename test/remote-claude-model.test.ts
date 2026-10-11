import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';

// The remote claude launch nests its command three shells deep (local sh → ssh's
// remote sh → tmux's sh → the login shell's -c). Reading the escaped string proves
// little, so this runs the real launch through sh with stand-ins for ssh, tmux and
// claude, and checks the argv claude finally receives (Joe, 2026-10-11).

describe('remote claude --model survives every shell layer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-model-'));
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    // ssh <opts…> user@host '<remote command>': run the last argument in a shell.
    script('ssh', 'for last; do :; done\nexec sh -c "$last"');
    // tmux … new-session -A -s <name> -c <dir> '<command>' \; set …: run the command.
    script('tmux', 'while [ "$#" -gt 0 ]; do if [ "$1" = -c ]; then exec sh -c "$3"; fi; shift; done\nexit 9');
    // One argv element per line, so a split or globbed argument shows.
    script('claude', `printf '%s\\n' "$@" > '${dir}/argv'`);
    // The login shell (`-i -l`) resets PATH from /etc/profile, then reads ~/.profile —
    // the same way the real host finds a ~/.local/bin claude.
    writeFileSync(join(dir, '.profile'), `PATH='${dir}':"$PATH"\n`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function argvFor(model?: string): string[] {
    const command = buildRemoteLaunchCommand({
      mode: 'claude',
      remote: { hostId: 'h', label: 'H', host: 'h', username: 'u', remotePath: dir },
      sessionId: 'abc123def456',
      model,
    });
    const res = spawnSync('sh', ['-c', command], {
      env: { PATH: `${dir}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: dir },
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    return readFileSync(join(dir, 'argv'), 'utf8').trimEnd().split('\n');
  }

  it('a plain alias', () => {
    expect(argvFor('haiku')).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'haiku',
      '--session-id',
      'abc123def456',
    ]);
  });

  it('a bracketed id stays one unglobbed argument, even with a matching file present', () => {
    writeFileSync(join(dir, 'opus1'), ''); // `opus[1m]` would glob to this unquoted
    expect(argvFor('opus[1m]')).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus[1m]',
      '--session-id',
      'abc123def456',
    ]);
  });

  it('no model, no flag', () => {
    expect(argvFor()).toEqual(['--dangerously-skip-permissions', '--session-id', 'abc123def456']);
  });
});
