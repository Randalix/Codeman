/**
 * @fileoverview Tests for remote (SSH) file access (`src/remote-files.ts`).
 *
 * Two layers are covered:
 *
 * 1. PURE builders/parsers — command construction, escaping and probe parsing, no
 *    connection involved.
 * 2. The probe SCRIPT itself, executed by a real `/bin/sh` against a real temp
 *    directory. The remote shell is the one place where a quoting mistake becomes an
 *    injection, and it cannot be exercised by an ssh-less unit test any other way: the
 *    script IS the remote command, so `sh -c <script>` reproduces exactly what sshd
 *    runs on the other end.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  RemoteFileAccessError,
  buildRemoteFileCommand,
  buildRemoteProbeCommand,
  buildRemoteReadCommand,
  buildRemoteClaudeTranscriptTailCommand,
  parseRemoteClaudeTranscriptTail,
  remoteReadClaudeTranscriptTail,
  buildRemoteClaudeEditSourcesCommand,
  parseRemoteClaudeEditSources,
  remoteReadClaudeEditSources,
  parseRemoteProbeRecord,
  parseRemoteProbeOutput,
  remoteProbePaths,
  remoteReadFile,
  remoteCreateReadStream,
} from '../src/remote-files.js';
import type { SessionRemote } from '../src/types/session.js';

/**
 * Run a shell line through a real `/bin/sh` and return its `$@` as an argv array,
 * WITHOUT executing anything. This is how the tests see the exact argument vector a
 * command line would hand to the process — the local-shell half of the escaping chain.
 */
function shellArgv(command: string): string[] {
  const out = execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`]);
  // The trailing empty element is the printf format terminator.
  return out.toString().split('\0').slice(0, -1);
}

/** A remote session fixture; every field is optional in production, so keep it minimal. */
function remoteFixture(overrides: Partial<SessionRemote> = {}): SessionRemote {
  return {
    hostId: 'host-1',
    label: 'testhost',
    host: '192.0.2.10',
    username: 'j',
    remotePath: '/srv/case',
    ...overrides,
  };
}

describe('buildRemoteFileCommand', () => {
  it('builds the ssh line from the shared connection args and one shellescaped command', () => {
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), 'cat /etc/hostname'));

    // buildSshConnectionArgs returns tokens, and the shell re-splits them into the
    // flags ssh actually wants (`-o` + `BatchMode=yes`), which is what this pins.
    expect(argv.slice(0, 3)).toEqual(['ssh', '-o', 'BatchMode=yes']);
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).toContain('j@192.0.2.10');
    // The remote command is ONE argument, whatever it contains.
    expect(argv[argv.length - 1]).toBe('cat /etc/hostname');
    expect(argv[argv.length - 2]).toBe('j@192.0.2.10');
  });

  it('routes port, identity, jump host and extra options through buildSshConnectionArgs', () => {
    const argv = shellArgv(
      buildRemoteFileCommand(
        remoteFixture({
          port: 2222,
          identityFile: '~/.ssh/id_ed25519',
          jumpHost: 'bastion.example.com',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        }),
        'true'
      )
    );

    expect(argv).toContain('-p');
    expect(argv).toContain('2222');
    expect(argv).toContain('-J');
    expect(argv).toContain('bastion.example.com');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    // `~` is expanded before escaping: ssh does not expand it inside -i.
    expect(argv).toContain(join(homedir(), '.ssh/id_ed25519'));
  });

  it('keeps a shell-metacharacter command as a single opaque argument', () => {
    const command = "cat '/tmp/it''s here' ; rm -rf ~ #";
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), command));

    expect(argv[argv.length - 1]).toBe(command);
    expect(argv).not.toContain('rm');
    expect(argv).not.toContain('-rf');
  });
});

describe('buildRemoteProbeCommand', () => {
  it('probes every path exactly once, each as its own shell-quoted token', () => {
    const script = buildRemoteProbeCommand(['/srv/case/a.png', '/srv/case']);
    const probeCalls = script.split('\n').filter((line) => line.startsWith('probe '));

    // The index is what the parser keys records on, so it is part of the call.
    expect(probeCalls).toEqual(["probe 0 '/srv/case/a.png'", "probe 1 '/srv/case'"]);
  });

  it('quotes a path with spaces, quotes and a command substitution', () => {
    const nasty = "/srv/case/it's $(touch /tmp/pwned).txt";
    const script = buildRemoteProbeCommand([nasty]);

    expect(script).toContain(`probe 0 '/srv/case/it'\\''s $(touch /tmp/pwned).txt'`);
    expect(shellArgv(buildRemoteFileCommand(remoteFixture(), script)).at(-1)).toBe(script);
  });
});

/**
 * Run the probe script through a real `/bin/sh`. With `shadowReadlinkF` the PATH is
 * fronted by a `readlink` that rejects `-f` the way macOS < 12.3 does (`illegal
 * option -- f`) and otherwise defers to the real one, which forces the portable
 * fallback branch on a host that natively has `readlink -f`.
 */
function runProbe(paths: string[], options: { cwd?: string; shadowReadlinkF?: boolean; shimDir?: string } = {}) {
  const env =
    options.shadowReadlinkF && options.shimDir
      ? { ...process.env, PATH: `${options.shimDir}:${process.env.PATH}` }
      : process.env;
  const stdout = execFileSync('sh', ['-c', buildRemoteProbeCommand(paths)], { cwd: options.cwd, env }).toString();
  return parseRemoteProbeOutput(stdout, paths);
}

describe('the probe script on a real shell', () => {
  let root: string;
  let shimDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-remote-probe-'));
    shimDir = join(root, 'shim-bin');
    mkdirSync(shimDir);
    const realReadlink = execFileSync('sh', ['-c', 'command -v readlink']).toString().trim();
    writeFileSync(
      join(shimDir, 'readlink'),
      `#!/bin/sh\ncase "$1" in -f) echo 'readlink: illegal option -- f' >&2; exit 1;; esac\nexec ${realReadlink} "$@"\n`
    );
    chmodSync(join(shimDir, 'readlink'), 0o755);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the fallback branch on a shell whose readlink has no -f', () => {
    // Sanity check on the shim itself: without it this whole describe would be
    // exercising the native branch twice.
    expect(() =>
      execFileSync('sh', ['-c', 'readlink -f / 2>/dev/null'], {
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      })
    ).toThrow();
  });

  it.each([
    ['readlink -f', false],
    ['portable fallback', true],
  ])('refuses to report a symlink by its own path (%s): the target is what is served', (_label, shadow) => {
    // The reviewer's exact reproduction: ws/notes.txt -> secret/id_rsa. The old
    // fallback resolved only the DIRECTORY chain, returned `ws/notes.txt` as the
    // realpath (with the TARGET's size), containment passed, and `cat` served the key.
    const ws = join(root, `escape-${shadow ? 'fallback' : 'native'}`);
    const secret = join(root, `secret-${shadow ? 'fallback' : 'native'}`);
    mkdirSync(ws);
    mkdirSync(secret);
    writeFileSync(join(secret, 'id_rsa'), 'KEYKEYKEYKEY1');
    execFileSync('ln', ['-s', join(secret, 'id_rsa'), join(ws, 'notes.txt')]);

    const [probe] = runProbe([join(ws, 'notes.txt')], { shadowReadlinkF: shadow, shimDir });

    expect(probe?.realPath).toBe(join(secret, 'id_rsa'));
    expect(probe?.size).toBe(13);
  });

  it('follows a relative symlink chain through a symlinked directory on the fallback branch', () => {
    const ws = join(root, 'chain');
    mkdirSync(join(ws, 'sub'), { recursive: true });
    writeFileSync(join(ws, 'sub', 'real.txt'), 'inside');
    execFileSync('ln', ['-s', 'real.txt', join(ws, 'sub', 'hop1.txt')]);
    execFileSync('ln', ['-s', 'hop1.txt', join(ws, 'sub', 'hop2.txt')]);
    execFileSync('ln', ['-s', 'sub', join(ws, 'subl')]);

    const probes = runProbe([join(ws, 'subl', 'hop2.txt'), join(ws, 'subl')], { shadowReadlinkF: true, shimDir });

    expect(probes[0]).toMatchObject({ kind: 'file', size: 6, realPath: join(ws, 'sub', 'real.txt') });
    expect(probes[1]).toMatchObject({ kind: 'directory', realPath: join(ws, 'sub') });
  });

  it.each([
    ['readlink -f', false],
    ['portable fallback', true],
  ])('fails CLOSED on a symlink loop (%s), never reporting the unresolved path', (_label, shadow) => {
    const ws = join(root, `loop-${shadow ? 'fallback' : 'native'}`);
    mkdirSync(ws);
    execFileSync('ln', ['-s', 'b', join(ws, 'a')]);
    execFileSync('ln', ['-s', 'a', join(ws, 'b')]);

    const [probe] = runProbe([join(ws, 'a')], { shadowReadlinkF: shadow, shimDir });

    expect(probe).toBeNull();
  });

  it('reports kind, size and realpath for a file, a directory and a missing path', () => {
    const filePath = join(root, 'image.png');
    writeFileSync(filePath, 'fake png bytes');

    const probes = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([filePath, root, join(root, 'nope.png')])]).toString(),
      [filePath, root, join(root, 'nope.png')]
    );

    expect(probes[0]).toMatchObject({ kind: 'file', size: 14, realPath: filePath });
    expect(probes[0]?.mtimeMs).toBeGreaterThan(0);
    expect(probes[1]).toMatchObject({ kind: 'directory', size: 0, realPath: root });
    expect(probes[2]).toBeNull();
  });

  it('resolves a symlink to its target', () => {
    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'x');
    execFileSync('ln', ['-s', target, link]);

    const [probe] = parseRemoteProbeOutput(execFileSync('sh', ['-c', buildRemoteProbeCommand([link])]).toString(), [
      link,
    ]);

    expect(probe?.realPath).toBe(target);
  });

  it('treats a hostile filename as data, never as a command', () => {
    // No slashes in the payload: it has to be a legal FILENAME on this host while
    // still being a command substitution to a shell.
    const marker = `codeman_pwned_${process.pid}`;
    const hostile = join(root, `it's; touch ${marker}; $(id).txt`);
    writeFileSync(hostile, 'hostile');

    const [probe] = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([hostile])], { cwd: root }).toString(),
      [hostile]
    );

    expect(probe?.realPath).toBe(hostile);
    expect(existsSync(join(root, marker))).toBe(false);
  });

  it('keeps a filename containing a newline aligned with its own index', () => {
    // One record per LINE would have made this two lines, shifting every record
    // after it by one; records are NUL-terminated and index-keyed instead.
    const weird = join(root, 'a\nb.txt');
    writeFileSync(weird, 'nl');
    const after = join(root, 'after.txt');
    writeFileSync(after, 'after');

    const probes = runProbe([weird, after, join(root, 'nope')]);

    expect(probes[0]).toMatchObject({ kind: 'file', size: 2, realPath: weird });
    expect(probes[1]).toMatchObject({ kind: 'file', size: 5, realPath: after });
    expect(probes[2]).toBeNull();
  });

  it('discards a login banner and rc-file chatter printed before the records', () => {
    const filePath = join(root, 'banner.txt');
    writeFileSync(filePath, 'b');

    const stdout = execFileSync('sh', [
      '-c',
      `echo 'Welcome to box'; printf '0|f|9|9|/etc/shadow\\n'; ${buildRemoteProbeCommand([filePath])}`,
    ]).toString();

    // The chatter even LOOKS like a record; the leading NUL is what fences it off.
    expect(parseRemoteProbeOutput(stdout, [filePath])[0]).toMatchObject({ realPath: filePath, size: 1 });
  });

  it('handles a path containing the field separator', () => {
    const pipePath = join(root, 'a|b.txt');
    writeFileSync(pipePath, 'xy');

    const [probe] = parseRemoteProbeOutput(execFileSync('sh', ['-c', buildRemoteProbeCommand([pipePath])]).toString(), [
      pipePath,
    ]);

    expect(probe?.realPath).toBe(pipePath);
    expect(probe?.size).toBe(2);
  });

  it('walks into a nested directory that exists', () => {
    const nested = join(root, 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'f.txt'), 'abc');

    const [probe] = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([join(nested, 'f.txt')])]).toString(),
      [join(nested, 'f.txt')]
    );

    expect(probe?.size).toBe(3);
    expect(statSync(join(nested, 'f.txt')).size).toBe(3);
  });
});

describe('parseRemoteProbeRecord', () => {
  it('parses a file record and converts mtime to milliseconds', () => {
    expect(parseRemoteProbeRecord('f|1234|1700000000|/srv/case/a.png')).toEqual({
      realPath: '/srv/case/a.png',
      kind: 'file',
      size: 1234,
      mtimeMs: 1700000000 * 1000,
    });
  });

  it('keeps a path that itself contains the separator', () => {
    expect(parseRemoteProbeRecord('f|7|0|/srv/ca|se/a b.txt')?.realPath).toBe('/srv/ca|se/a b.txt');
  });

  it('maps directories, other kinds, the not-found and the unresolvable markers', () => {
    expect(parseRemoteProbeRecord('d|0|5|/srv/case')?.kind).toBe('directory');
    expect(parseRemoteProbeRecord('o|0|0|/srv/case/sock')?.kind).toBe('other');
    expect(parseRemoteProbeRecord('n')).toBeNull();
    // Exists but could not be canonicalized: refused like a missing file, never
    // served under a path whose real target is unknown.
    expect(parseRemoteProbeRecord('x')).toBeNull();
    expect(parseRemoteProbeRecord('')).toBeNull();
  });

  it('rejects malformed lines instead of inventing a path', () => {
    expect(parseRemoteProbeRecord('f|1|2')).toBeNull();
    expect(parseRemoteProbeRecord('x|1|2|/p')).toBeNull();
    expect(parseRemoteProbeRecord('f|1|2|')).toBeNull();
  });
});

describe('parseRemoteProbeOutput', () => {
  it('keys records by index after the leading NUL, so a login banner cannot shift the mapping', () => {
    const stdout = 'welcome to the remote box\n\x000|f|3|1|/srv/a.txt\x001|n\x00';
    expect(parseRemoteProbeOutput(stdout, ['/srv/a.txt', '/srv/b.txt'])).toEqual([
      { realPath: '/srv/a.txt', kind: 'file', size: 3, mtimeMs: 1000 },
      null,
    ]);
  });

  it('accepts records in any order and ignores duplicates of an index', () => {
    const stdout = '\x001|d|0|0|/srv\x000|f|3|1|/srv/a.txt\x000|f|9|9|/evil\x00';
    expect(parseRemoteProbeOutput(stdout, ['/srv/a.txt', '/srv'])).toEqual([
      { realPath: '/srv/a.txt', kind: 'file', size: 3, mtimeMs: 1000 },
      { realPath: '/srv', kind: 'directory', size: 0, mtimeMs: 0 },
    ]);
  });

  it('throws when a requested path has no record (transport or shell failure, never a 404)', () => {
    expect(() => parseRemoteProbeOutput('\x000|f|3|1|/srv/a.txt\x00', ['/a', '/b'])).toThrow(RemoteFileAccessError);
    expect(() => parseRemoteProbeOutput('', ['/a'])).toThrow(RemoteFileAccessError);
    // No leading NUL at all: the script never ran, whatever the shell printed.
    expect(() => parseRemoteProbeOutput('0|f|3|1|/srv/a.txt', ['/srv/a.txt'])).toThrow(RemoteFileAccessError);
  });
});

describe('under vitest', () => {
  const remote = remoteFixture();

  it('never opens a connection: probes and reads reject with a clear error', async () => {
    // Mirrors checkRemoteTmuxAvailable's guard. The route tests mock this module, so
    // this is the backstop for the next test that reaches the real one.
    await expect(remoteProbePaths(remote, ['/srv/case'])).rejects.toThrow(/disabled under test/);
    await expect(remoteReadFile(remote, '/srv/case/a.txt', 1024)).rejects.toThrow(/disabled under test/);
  });

  it('never opens a connection: a stream fails through its own error path', async () => {
    const { stream, close } = remoteCreateReadStream(remote, '/srv/case/a.mp4');
    const failure = await new Promise<Error>((resolveError) => stream.on('error', resolveError));
    expect(failure).toBeInstanceOf(RemoteFileAccessError);
    expect(() => close()).not.toThrow();
  });
});

describe('buildRemoteReadCommand', () => {
  it('streams the whole file with cat', () => {
    expect(buildRemoteReadCommand("/srv/case/it's.mp4")).toBe("cat '/srv/case/it'\\''s.mp4'");
  });

  it('turns a byte range into a constant-memory tail | head', () => {
    expect(buildRemoteReadCommand('/srv/case/v.mp4', { start: 2, end: 5 })).toBe(
      "tail -c +3 '/srv/case/v.mp4' | head -c 4"
    );
  });

  it('covers the first byte of the file (tail -c +1, not +0)', () => {
    expect(buildRemoteReadCommand('/f', { start: 0, end: 0 })).toBe("tail -c +1 '/f' | head -c 1");
  });
});

describe('the remote claude transcript script on a real shell', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-remote-transcript-'));
    mkdirSync(join(home, '.claude', 'projects', '-other'), { recursive: true });
    mkdirSync(join(home, '.claude', 'projects', '-mnt-work dir'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-other', 'abc.jsonl'), 'unrelated\n');
    writeFileSync(join(home, '.claude', 'projects', '-mnt-work dir', 'conv-1.jsonl'), 'line one\nline two\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const run = (ids: string[], maxBytes = 1024) => {
    const env = { ...process.env, HOME: home };
    try {
      return {
        code: 0,
        stdout: execFileSync('sh', ['-c', buildRemoteClaudeTranscriptTailCommand(ids, maxBytes)], { env }).toString(),
      };
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      return { code: e.status, stdout: e.stdout.toString() };
    }
  };

  it('finds the transcript in any project dir (spaces included) and reports the matched id', () => {
    const { code, stdout } = run(['missing-id', 'conv-1']);
    expect(code).toBe(0);
    expect(parseRemoteClaudeTranscriptTail('banner from .bashrc\n' + stdout)).toEqual({
      sessionId: 'conv-1',
      content: 'line one\nline two\n',
    });
  });

  it('returns only the last maxBytes bytes', () => {
    expect(parseRemoteClaudeTranscriptTail(run(['conv-1'], 9).stdout)?.content).toBe('line two\n');
  });

  it('does not depend on the remote ls (Hufflepuff: zsh aliases ls to eza, whose -t takes an argument)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'codeman-fake-ls-'));
    try {
      writeFileSync(join(bin, 'ls'), '#!/bin/sh\necho broken ls >&2\nexit 2\n');
      chmodSync(join(bin, 'ls'), 0o755);
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      const stdout = execFileSync('sh', ['-c', buildRemoteClaudeTranscriptTailCommand(['conv-1'], 1024)], { env });
      expect(parseRemoteClaudeTranscriptTail(stdout.toString())?.sessionId).toBe('conv-1');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('runs under an explicit sh, never the login shell (zsh aborts the script on an unmatched glob)', () => {
    expect(buildRemoteClaudeTranscriptTailCommand(['conv-1'], 10)).toMatch(/^sh -c '/);
  });

  it('picks the newest file when the id exists in two project dirs', () => {
    const older = join(home, '.claude', 'projects', '-other', 'conv-1.jsonl');
    writeFileSync(older, 'stale\n');
    utimesSync(older, new Date('2020-01-01'), new Date('2020-01-01'));
    try {
      expect(parseRemoteClaudeTranscriptTail(run(['conv-1']).stdout)?.content).toBe('line one\nline two\n');
    } finally {
      rmSync(older);
    }
  });

  it('exits 3 when no id has a transcript', () => {
    expect(run(['nope']).code).toBe(3);
  });

  it('never interpolates an id that is not a plain token', () => {
    const command = buildRemoteClaudeTranscriptTailCommand(['$(touch pwned)', "a'b", '../../x'], 1024);
    expect(command).toBe('exit 3');
    expect(command).not.toMatch(/pwned|a'b|\.\.\//);
  });

  it('refuses to open a connection under test', async () => {
    await expect(
      remoteReadClaudeTranscriptTail(
        { hostId: 'h', label: 'h', host: '192.0.2.1', username: 'j', remotePath: '/' },
        ['a'],
        10
      )
    ).rejects.toBeInstanceOf(RemoteFileAccessError);
  });
});

describe('parseRemoteClaudeTranscriptTail', () => {
  it('is null when the protocol markers are missing', () => {
    expect(parseRemoteClaudeTranscriptTail('Welcome to host')).toBeNull();
    expect(parseRemoteClaudeTranscriptTail('\0id-without-terminator')).toBeNull();
  });
});

/** One edit-source record in the script's wire format. */
function editRecord(relPath: string, size: number, start: number, body: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([Buffer.from(`${relPath}\0${size}\0${start}\0${bytes.length}\0`), bytes]);
}

describe('buildRemoteClaudeEditSourcesCommand', () => {
  it('runs under an explicit sh and never calls ls', () => {
    const command = buildRemoteClaudeEditSourcesCommand(['conv-1'], [], 1024);
    expect(command).toMatch(/^sh -c '/);
    expect(command).not.toMatch(/(^|[\s;|(])ls\s/m);
  });

  it('drops ids that are not plain tokens (exit 3 when none is left)', () => {
    expect(buildRemoteClaudeEditSourcesCommand(['$(touch pwned)', "a'b", '../../x'], [], 10)).toBe('exit 3');
    const command = buildRemoteClaudeEditSourcesCommand(['$(touch pwned)', 'conv-1'], [], 10);
    expect(command).toContain('conv-1');
    expect(command).not.toContain('pwned');
  });

  it('ignores invalid relPaths, offsets and lengths', () => {
    const command = buildRemoteClaudeEditSourcesCommand(
      ['conv-1'],
      [
        { relPath: '../../etc/passwd', offset: 0 },
        { relPath: "subagents/agent-a';touch x;'.jsonl", offset: 0 },
        { relPath: 'subagents/agent-neg.jsonl', offset: -1 },
        { relPath: 'subagents/agent-frac.jsonl', offset: 1.5 },
        { relPath: 'subagents/agent-nan.jsonl', offset: Number.NaN },
        { relPath: 'subagents/agent-badlen.jsonl', offset: 0, len: -5 },
        { relPath: 'subagents/agent-ok.jsonl', offset: 7, len: 3 },
        { relPath: 'subagents/agent-ok.jsonl', offset: 99 },
      ],
      100
    );
    expect(command).not.toMatch(/passwd|touch|agent-neg|agent-frac|agent-nan|agent-badlen/);
    // First request per relPath wins.
    expect(command).toContain('agent-ok.jsonl');
    expect(command).toContain('r 7 3');
    expect(command).not.toContain('r 99');
  });
});

describe('parseRemoteClaudeEditSources', () => {
  it('splits several records byte-exactly and keeps a UTF-8 sequence cut at a chunk edge intact as bytes', () => {
    const euro = Buffer.from('a€', 'utf8'); // 61 e2 82 ac
    const stdout = Buffer.concat([
      Buffer.from('banner from .zshrc\n\0conv-1\0'),
      editRecord('main', 10, 6, euro.subarray(0, 3)), // ends mid-€
      editRecord('subagents/agent-x1.jsonl', 4, 0, '{}\n\0'),
      editRecord('subagents/agent-x1.meta.json', 23, 0, '{"agentType":"Explore"}'),
    ]);
    const parsed = parseRemoteClaudeEditSources(stdout);
    expect(parsed?.transcriptId).toBe('conv-1');
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0]).toMatchObject({ relPath: 'main', size: 10, startOffset: 6 });
    expect(parsed?.files[0].chunk.equals(euro.subarray(0, 3))).toBe(true);
    expect(parsed?.files[1].chunk.equals(Buffer.from('{}\n\0'))).toBe(true);
    expect(parsed?.metas).toEqual({ x1: '{"agentType":"Explore"}' });
  });

  it('accepts a zero-length record (budget used up) and a header with no records', () => {
    const parsed = parseRemoteClaudeEditSources(
      Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('main', 500, 500, '')])
    );
    expect(parsed?.files).toEqual([{ relPath: 'main', size: 500, startOffset: 500, chunk: Buffer.alloc(0) }]);
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0'))).toEqual({
      transcriptId: 'conv-1',
      files: [],
      metas: {},
    });
  });

  it('is null when the protocol is broken', () => {
    expect(parseRemoteClaudeEditSources(Buffer.from('no nul at all'))).toBeNull();
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1'))).toBeNull();
    expect(parseRemoteClaudeEditSources(Buffer.from('\0bad id\0'))).toBeNull();
    // Body shorter than declared.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\x0010\x000\x005\x00abc'))).toBeNull();
    // Truncated header.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\x0010\x00'))).toBeNull();
    // Non-numeric size, unknown relPath, slice outside the file.
    expect(parseRemoteClaudeEditSources(Buffer.from('\0conv-1\0main\0x\x000\x000\0'))).toBeNull();
    expect(
      parseRemoteClaudeEditSources(Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('../x', 1, 0, 'a')]))
    ).toBeNull();
    expect(
      parseRemoteClaudeEditSources(Buffer.concat([Buffer.from('\0conv-1\0'), editRecord('main', 2, 1, 'ab')]))
    ).toBeNull();
  });
});

describe('the remote claude edit-sources script on a real shell', () => {
  let home: string;
  const project = () => join(home, '.claude', 'projects', 'p');
  const subagents = () => join(project(), 'conv-1', 'subagents');

  beforeAll(() => {
    // A throwaway HOME: the script only ever sees this directory as $HOME.
    home = mkdtempSync(join(tmpdir(), 'codeman-remote-edit-sources-'));
    mkdirSync(project(), { recursive: true });
    writeFileSync(join(project(), 'conv-1.jsonl'), 'main-0123456789\n');
    writeFileSync(join(project(), 'solo.jsonl'), 'solo €uro\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const run = (ids: string[], requests: Parameters<typeof buildRemoteClaudeEditSourcesCommand>[1], budget: number) => {
    expect(home.startsWith(tmpdir())).toBe(true);
    const env = { ...process.env, HOME: home };
    try {
      return {
        code: 0,
        stdout: execFileSync('sh', ['-c', buildRemoteClaudeEditSourcesCommand(ids, requests, budget)], { env }),
      };
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      return { code: e.status, stdout: e.stdout };
    }
  };
  const text = (chunk: Buffer | undefined) => chunk?.toString('utf8');

  it('reads a transcript that has no subagents folder (tail of the file, budget-capped)', () => {
    const { code, stdout } = run(['missing', 'solo'], [], 6);
    expect(code).toBe(0);
    const parsed = parseRemoteClaudeEditSources(stdout);
    const size = Buffer.byteLength('solo €uro\n');
    expect(parsed?.transcriptId).toBe('solo');
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]).toMatchObject({ relPath: 'main', size, startOffset: size - 6 });
    expect(parsed?.files[0].chunk.equals(Buffer.from('solo €uro\n').subarray(size - 6))).toBe(true);
    expect(parsed?.metas).toEqual({});
  });

  it('exits 3 when no id has a transcript', () => {
    expect(run(['nope'], [], 100).code).toBe(3);
  });

  describe('after a /clear: the conversation the pane’s claude writes now', () => {
    // Fake tmux (pane pid 100) and ps (100 → 200 wrapper → 300 claude); claude's own
    // ~/.claude/sessions/<pid>.json names the current conversation.
    let bin: string;
    const pane = { socket: 'codeman-remote', sessionName: 'codeman-ssh-conv1abc' };
    beforeAll(() => {
      bin = mkdtempSync(join(tmpdir(), 'codeman-fake-tmux-'));
      writeFileSync(
        join(bin, 'tmux'),
        '#!/bin/sh\ncase "$*" in *"=codeman-ssh-conv1abc"*) echo 100 ;; *) echo "no such session" >&2; exit 1 ;; esac\n'
      );
      writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "  1     0\\n100     1\\n200   100\\n300   200\\n"\n');
      chmodSync(join(bin, 'tmux'), 0o755);
      chmodSync(join(bin, 'ps'), 0o755);
      mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    });
    afterAll(() => rmSync(bin, { recursive: true, force: true }));
    const runIn = (p: typeof pane | undefined, ids = ['conv-1']) => {
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      const out = execFileSync('sh', ['-c', buildRemoteClaudeEditSourcesCommand(ids, [], 100, p)], { env, cwd: bin });
      return parseRemoteClaudeEditSources(out)?.transcriptId;
    };
    const session = (body: string) => writeFileSync(join(home, '.claude', 'sessions', '300.json'), body);

    it('reads the live conversation of a grandchild claude before the stored ids', () => {
      session('{"pid":300,"sessionId":"solo","cwd":"/w","kind":"interactive"}');
      expect(runIn(pane)).toBe('solo');
    });

    it('the transcript tail read tries the live conversation first too', () => {
      session('{"pid":300,"sessionId":"solo"}');
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      const tail = (p: typeof pane | undefined) =>
        parseRemoteClaudeTranscriptTail(
          execFileSync('sh', ['-c', buildRemoteClaudeTranscriptTailCommand(['conv-1'], 1024, p)], {
            env,
            cwd: bin,
          }).toString()
        )?.sessionId;
      expect(tail(pane)).toBe('solo');
      expect(tail(undefined)).toBe('conv-1');
    });

    it('falls back to the stored ids without a pane, for an unknown session, or a live id with no transcript', () => {
      session('{"pid":300,"sessionId":"solo"}');
      expect(runIn(undefined)).toBe('conv-1');
      expect(runIn({ ...pane, sessionName: 'codeman-ssh-other' })).toBe('conv-1');
      session('{"pid":300,"sessionId":"gone"}');
      expect(runIn(pane)).toBe('conv-1');
    });

    it('takes only an id-shaped value from the sessions file, and only plain socket/session names', () => {
      session('{"pid":300,"sessionId":"x$(touch pwned)"}');
      expect(runIn(pane)).toBe('conv-1');
      expect(existsSync(join(bin, 'pwned'))).toBe(false);
      const command = buildRemoteClaudeEditSourcesCommand(['conv-1'], [], 10, { socket: "a';x", sessionName: 's' });
      expect(command).not.toContain('list-panes');
    });
  });

  describe('with subagents', () => {
    beforeAll(() => {
      mkdirSync(subagents(), { recursive: true });
      writeFileSync(join(subagents(), 'agent-a1.jsonl'), 'AAAAAAAAAA');
      writeFileSync(join(subagents(), 'agent-a1.meta.json'), '{"agentType":"Explore"}');
      writeFileSync(join(subagents(), 'agent-b2.jsonl'), 'BBBBB');
      writeFileSync(join(subagents(), 'agent-bad name.jsonl'), 'never read');
    });

    it('continues from the stored offsets and reads new subagents with their meta', () => {
      const parsed = parseRemoteClaudeEditSources(
        run(
          ['conv-1'],
          [
            { relPath: 'main', offset: 5 },
            { relPath: 'subagents/agent-b2.jsonl', offset: 2, len: 2 },
          ],
          1000
        ).stdout
      );
      expect(parsed?.files.map((file) => [file.relPath, file.size, file.startOffset, text(file.chunk)])).toEqual([
        ['main', 16, 5, '0123456789\n'],
        ['subagents/agent-a1.jsonl', 10, 0, 'AAAAAAAAAA'],
        ['subagents/agent-b2.jsonl', 5, 2, 'BB'],
      ]);
      // b2 had a request, so it is not new: only a1's meta is sent.
      expect(parsed?.metas).toEqual({ a1: '{"agentType":"Explore"}' });
    });

    it('reads nothing past the end and clamps an offset beyond a truncated file', () => {
      const parsed = parseRemoteClaudeEditSources(
        run(
          ['conv-1'],
          [
            { relPath: 'main', offset: 16 },
            { relPath: 'subagents/agent-a1.jsonl', offset: 10 },
            { relPath: 'subagents/agent-b2.jsonl', offset: 50 },
          ],
          1000
        ).stdout
      );
      expect(parsed?.files.map((file) => [file.relPath, file.size, file.startOffset, file.chunk.length])).toEqual([
        ['main', 16, 16, 0],
        ['subagents/agent-a1.jsonl', 10, 10, 0],
        ['subagents/agent-b2.jsonl', 5, 5, 0],
      ]);
      expect(parsed?.metas).toEqual({});
    });

    it('shares one budget across files and still reports the size of files it could not read', () => {
      const parsed = parseRemoteClaudeEditSources(run(['conv-1'], [{ relPath: 'main', offset: 0 }], 20).stdout);
      expect(parsed?.files.map((file) => [file.relPath, file.size, file.startOffset, text(file.chunk)])).toEqual([
        ['main', 16, 0, 'main-0123456789\n'],
        // 4 bytes left: the newest 4 of a1.
        ['subagents/agent-a1.jsonl', 10, 6, 'AAAA'],
        // Budget exhausted: a zero-length record carrying the size.
        ['subagents/agent-b2.jsonl', 5, 5, ''],
      ]);
      // Metas sit outside the budget.
      expect(Object.keys(parsed?.metas ?? {}).sort()).toEqual(['a1']);
    });

    it('treats a hostile request as data: it never reaches the shell', () => {
      const marker = join(home, 'pwned');
      const parsed = parseRemoteClaudeEditSources(
        run(['conv-1'], [{ relPath: `subagents/agent-x.jsonl'; touch ${marker}; '`, offset: 0 }], 1000).stdout
      );
      expect(existsSync(marker)).toBe(false);
      expect(parsed?.files.map((file) => file.relPath)).toEqual([
        'main',
        'subagents/agent-a1.jsonl',
        'subagents/agent-b2.jsonl',
      ]);
    });
  });

  it('refuses to open a connection under test', async () => {
    await expect(
      remoteReadClaudeEditSources(
        { hostId: 'h', label: 'h', host: '192.0.2.1', username: 'j', remotePath: '/' },
        ['a'],
        [],
        10
      )
    ).rejects.toBeInstanceOf(RemoteFileAccessError);
  });
});
