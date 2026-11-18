/**
 * The remote half of session suspend (`buildRemoteSuspendScript`), run for real under
 * `sh` against a fake `tmux` on PATH and a real process tree shaped like the one
 * measured on Hufflepuff: the pane's shell leads its session, and the agent runs in
 * a process group of its own (job control), so a signal to the pane's group misses it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_SUSPEND_GONE_EXIT, buildRemoteSuspendCommand, buildRemoteSuspendScript } from '../src/remote-hosts.js';

const FAKE_TMUX = `#!/bin/sh
echo "$*" >> "$HOME/tmux-calls"
case "$*" in
  *list-panes*) [ -n "$FAKE_PANE" ] && echo "$FAKE_PANE" ;;
  *kill-session*) [ -n "$FAKE_PANE" ] && kill -HUP "$FAKE_PANE" ;;
esac
exit 0
`;

const homes: string[] = [];
const children: ChildProcess[] = [];

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'codeman-rsuspend-'));
  homes.push(home);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const tmux = join(home, '.local', 'bin', 'tmux');
  writeFileSync(tmux, FAKE_TMUX);
  chmodSync(tmux, 0o755);
  return home;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runScript(home: string, pane: string) {
  return spawnSync('sh', ['-s'], {
    input: buildRemoteSuspendScript('codeman-ssh-abcd1234'),
    env: { PATH: '/usr/bin:/bin', HOME: home, FAKE_PANE: pane },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid) process.kill(c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('remote suspend script', () => {
  it('stops the pane shell AND the agent in its own process group, then reports 0', async () => {
    const home = fakeHome();
    // Not detached, so `setsid` execs in place: child.pid leads the new session. The
    // shell starts a job-controlled child (its own group), like zsh starting claude.
    const shell = spawn('setsid', ['sh', '-c', 'set -m; sleep 60 & echo $! > "$HOME/agent"; wait'], {
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdio: 'ignore',
    });
    children.push(shell);
    let agent = 0;
    for (let i = 0; i < 50 && !agent; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        agent = Number(readFileSync(join(home, 'agent'), 'utf8').trim());
      } catch {
        // not yet
      }
    }
    expect(agent).toBeGreaterThan(0);
    expect(alive(agent)).toBe(true);

    // The fake kill-session HUPs the shell only; the job-controlled agent never gets it. The
    // script's sweep must SIGKILL the agent after its 5 s grace.
    const res = runScript(home, String(shell.pid));
    expect(res.status).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(agent)).toBe(false);
    const calls = readFileSync(join(home, 'tmux-calls'), 'utf8');
    expect(calls).toContain('-L codeman-remote list-panes -t =codeman-ssh-abcd1234');
    expect(calls).toContain('-L codeman-remote kill-session -t =codeman-ssh-abcd1234');
  }, 20_000);

  it('reports a session that is already gone with its own exit code, and kills nothing', () => {
    const home = fakeHome();
    const res = runScript(home, '');
    expect(res.status).toBe(REMOTE_SUSPEND_GONE_EXIT);
    expect(readFileSync(join(home, 'tmux-calls'), 'utf8')).not.toContain('kill-session');
  });

  it('runs under sh, fed on stdin, so the login shell never parses it', () => {
    const cmd = buildRemoteSuspendCommand({ username: 'j', host: '10.0.0.5', port: 2222 });
    expect(cmd).toMatch(/^ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 j@10\.0\.0\.5 'sh -s'$/);
  });
});
