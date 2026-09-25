import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_API_URL_PATTERN,
  REMOTE_AGENT_CLI_MARKER,
  REMOTE_AGENT_SKILL_MARKER_FILE,
  buildRemoteAgentCliInstallCommand,
  buildRemoteAgentCliInstallScript,
  buildRemoteAgentSkillInstallCommand,
  buildRemoteAgentSkillInstallScript,
  installRemoteAgentCli,
  installRemoteAgentSkill,
  packAgentSkillDir,
  remoteAgentEnvPrefix,
  resetRemoteAgentCliInstallMemo,
} from '../src/remote-agent-cli.js';
import { rehydrateRemoteHostFields, toAttachedSessionRemote, toSessionRemote } from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { RemoteHostSchema } from '../src/web/schemas.js';
import type { RemoteHost, SessionRemote } from '../src/types.js';

// A remote session's agent runs on another host: without the env and the binary,
// `codeman agent inbox` is impossible there (Joe, 2026-09-24). Opt-in per host via
// `agentApiUrl`; these tests pin the launch env, the install script and the bundle.

const SID = '4677a068-f118-449d-abc3-ab5c06564f01';
const URL = 'http://192.168.50.194:3459';

const host: RemoteHost = {
  id: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  username: 'j',
};

const remote: SessionRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  username: 'j',
  remotePath: '/home/j/work dir',
};

describe('agentApiUrl validation', () => {
  it.each([URL, 'https://codeman.example.org', 'http://[fd7a::1]:3459/', 'http://albus:3459/base'])(
    'accepts %s',
    (u) => {
      expect(AGENT_API_URL_PATTERN.test(u)).toBe(true);
      expect(RemoteHostSchema.safeParse({ ...host, agentApiUrl: u }).success).toBe(true);
    }
  );

  // Every value here would reach a shell: `$`/backtick run LOCALLY inside the
  // `bash -c "…"` launch layer, quotes/spaces break the quoting.
  it.each(['ftp://albus', 'http://$(id)', 'http://a`id`', "http://a'b", 'http://a b', 'albus:3459', 'http://a?x=1'])(
    'rejects %s',
    (u) => {
      expect(AGENT_API_URL_PATTERN.test(u)).toBe(false);
      expect(RemoteHostSchema.safeParse({ ...host, agentApiUrl: u }).success).toBe(false);
    }
  );
});

describe('remote launch env', () => {
  it('adds nothing without agentApiUrl (launch unchanged)', () => {
    expect(remoteAgentEnvPrefix(remote, SID)).toBe('');
    const cmd = buildRemoteLaunchCommand({ mode: 'claude', remote, sessionId: SID });
    expect(cmd).not.toContain('CODEMAN_');
  });

  it('ignores an invalid URL rather than exporting it (defense in depth)', () => {
    expect(remoteAgentEnvPrefix({ agentApiUrl: 'http://$(id)' }, SID)).toBe('');
  });

  it('exports the agent env before cd, for every mode', () => {
    for (const mode of ['claude', 'opencode', 'shell'] as const) {
      const cmd = buildRemoteLaunchCommand({ mode, remote: { ...remote, agentApiUrl: URL }, sessionId: SID });
      expect(cmd).toContain('CODEMAN_MUX=1');
      expect(cmd).toContain(SID);
      expect(cmd).toContain(URL);
      expect(cmd.indexOf('CODEMAN_API_URL')).toBeLessThan(cmd.indexOf('; cd '));
    }
  });

  it('the prefix really exports the three variables in sh', () => {
    const prefix = remoteAgentEnvPrefix({ agentApiUrl: URL }, SID);
    const out = execFileSync('/bin/sh', ['-c', `${prefix}env`], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(out).toContain('CODEMAN_MUX=1');
    expect(out).toContain(`CODEMAN_SESSION_ID=${SID}`);
    expect(out).toContain(`CODEMAN_API_URL=${URL}`);
  });
});

describe('host config carries agentApiUrl', () => {
  it('into owned sessions, not into attached ones', () => {
    const h = { ...host, agentApiUrl: URL };
    expect(toSessionRemote(h, { name: 'c', type: 'remote', hostId: 'hufflepuff', remotePath: '/w' }).agentApiUrl).toBe(
      URL
    );
    expect(toAttachedSessionRemote(h, 'codeman-x', '/w').agentApiUrl).toBeUndefined();
  });

  it('is rehydrated from the host config (authoritative both ways)', () => {
    const hosts = (agentApiUrl?: string) =>
      new Map([['hufflepuff', { ...host, ...(agentApiUrl ? { agentApiUrl } : {}) }]]);
    expect(rehydrateRemoteHostFields(remote, hosts(URL))?.agentApiUrl).toBe(URL);
    expect(rehydrateRemoteHostFields({ ...remote, agentApiUrl: URL }, hosts())?.agentApiUrl).toBeUndefined();
  });
});

describe('remote install script (run in a real sh with a fake HOME)', () => {
  let home: string;
  const target = () => join(home, '.local', 'bin', 'codeman');
  const bundle = (tag: string) =>
    Buffer.from(`#!/usr/bin/env node\n// ${REMOTE_AGENT_CLI_MARKER}\nconsole.log('${tag}')\n`);
  const install = (stdin: Buffer) =>
    spawnSync('/bin/sh', ['-c', buildRemoteAgentCliInstallScript()], {
      env: { HOME: home, PATH: process.env.PATH },
      input: stdin,
      encoding: 'utf8',
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-remote-cli-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installs an executable into ~/.local/bin, creating the directory', () => {
    const res = install(bundle('v1'));
    expect(res.stdout.trim()).toBe('installed');
    expect(readFileSync(target(), 'utf8')).toContain("console.log('v1')");
    expect(execFileSync(target(), { encoding: 'utf8' }).trim()).toBe('v1');
  });

  it('replaces its own earlier copy', () => {
    install(bundle('v1'));
    expect(install(bundle('v2')).stdout.trim()).toBe('installed');
    expect(readFileSync(target(), 'utf8')).toContain("console.log('v2')");
  });

  it('never overwrites a foreign codeman (a real install)', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(target(), '#!/bin/sh\necho real codeman\n');
    chmodSync(target(), 0o755);
    expect(install(bundle('v1')).stdout.trim()).toBe('foreign');
    expect(readFileSync(target(), 'utf8')).toContain('real codeman');
  });

  it('leaves no temp file behind', () => {
    install(bundle('v1'));
    const leftovers = execFileSync('/bin/sh', ['-c', `ls -a "${join(home, '.local', 'bin')}"`], { encoding: 'utf8' });
    expect(leftovers).not.toContain('.tmp.');
  });

  it('connects with the launch connection args', () => {
    const cmd = buildRemoteAgentCliInstallCommand({ ...host, port: 2222 });
    expect(cmd.startsWith('ssh -o BatchMode=yes ')).toBe(true);
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain('j@192.168.50.137');
    expect(cmd).not.toContain(' -t ');
  });
});

describe('installRemoteAgentCli', () => {
  beforeEach(() => resetRemoteAgentCliInstallMemo());
  const logs: string[] = [];
  const deps = (run: (c: string, s: Buffer) => Promise<string>, bundle: Buffer | null = Buffer.from('x')) => ({
    readBundle: () => bundle,
    run,
    log: (m: string) => logs.push(m),
  });

  it('skips a host without agentApiUrl (no ssh at all)', async () => {
    let calls = 0;
    expect(
      await installRemoteAgentCli(
        host,
        deps(async () => (calls++, 'installed'))
      )
    ).toBe('skipped');
    expect(calls).toBe(0);
  });

  it('skips when the build has no bundle', async () => {
    expect(
      await installRemoteAgentCli(
        { ...host, agentApiUrl: URL },
        deps(async () => 'installed', null)
      )
    ).toBe('skipped');
  });

  it('installs once per host and bundle', async () => {
    let calls = 0;
    const d = deps(async () => (calls++, 'installed\n'));
    expect(await installRemoteAgentCli({ ...host, agentApiUrl: URL }, d)).toBe('installed');
    expect(await installRemoteAgentCli({ ...host, agentApiUrl: URL }, d)).toBe('skipped');
    expect(calls).toBe(1);
    // A new bundle (redeploy) goes out again.
    expect(
      await installRemoteAgentCli({ ...host, agentApiUrl: URL }, { ...d, readBundle: () => Buffer.from('y') })
    ).toBe('installed');
    expect(calls).toBe(2);
  });

  it('never throws on failure and retries next time', async () => {
    let calls = 0;
    const d = deps(async () => {
      calls++;
      throw new Error('ssh: connect to host 192.168.50.137 port 22: No route to host');
    });
    expect(await installRemoteAgentCli({ ...host, agentApiUrl: URL }, d)).toBe('failed');
    expect(await installRemoteAgentCli({ ...host, agentApiUrl: URL }, d)).toBe('failed');
    expect(calls).toBe(2);
  });

  it('reports a foreign codeman', async () => {
    expect(
      await installRemoteAgentCli(
        { ...host, agentApiUrl: URL },
        deps(async () => 'foreign')
      )
    ).toBe('foreign');
  });
});

describe('standalone bundle', () => {
  let out: string;
  beforeEach(async () => {
    out = mkdtempSync(join(tmpdir(), 'codeman-agent-bundle-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('runs `agent` on a bare node, without node_modules, and keeps the env guard', async () => {
    const { build } = await import('esbuild');
    const file = join(out, 'codeman-agent.cjs');
    await build({
      entryPoints: [join(__dirname, '..', 'src', 'remote-agent-cli-entry.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: file,
      logLevel: 'silent',
    });
    expect(existsSync(file)).toBe(true);
    const help = spawnSync(process.execPath, [file, 'agent', '--help'], { cwd: out, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('inbox');
    // Outside a Codeman session it still refuses (invariant 1 of cli-agent.ts).
    const env = { PATH: process.env.PATH, HOME: out };
    const ls = spawnSync(process.execPath, [file, 'agent', 'ls'], { cwd: out, env, encoding: 'utf8' });
    expect(ls.status).not.toBe(0);
    expect(ls.stderr).toContain('CODEMAN_MUX');
  }, 30_000);
});

// The CLI alone was not enough: a remote claude without the skill did not know
// `codeman agent` is a shell command, looked for a tool named codeman and read Gmail
// instead (Joe, 2026-09-25, session c24a931d). The launch mirrors the server's skill.
describe('remote skill mirror script (real sh + tar, fake HOME)', () => {
  let home: string;
  let src: string;
  const target = () => join(home, '.claude', 'skills', 'codeman');
  const pack = (body: string) => {
    writeFileSync(join(src, 'SKILL.md'), body);
    return packAgentSkillDir(src)!;
  };
  const install = (stdin: Buffer) =>
    spawnSync('/bin/sh', ['-c', buildRemoteAgentSkillInstallScript()], {
      env: { HOME: home, PATH: process.env.PATH },
      input: stdin,
      encoding: 'utf8',
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-remote-skill-'));
    src = mkdtempSync(join(tmpdir(), 'codeman-skill-src-'));
    mkdirSync(join(src, 'reference'));
    writeFileSync(join(src, 'reference', 'verbs.md'), 'verbs\n');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('installs SKILL.md + reference/ and stamps the marker, creating ~/.claude/skills', () => {
    const res = install(pack('v1'));
    expect(res.stdout.trim()).toBe('installed');
    expect(readFileSync(join(target(), 'SKILL.md'), 'utf8')).toBe('v1');
    expect(readFileSync(join(target(), 'reference', 'verbs.md'), 'utf8')).toBe('verbs\n');
    expect(existsSync(join(target(), REMOTE_AGENT_SKILL_MARKER_FILE))).toBe(true);
  });

  it('replaces its own earlier mirror completely (stale files go)', () => {
    install(pack('v1'));
    writeFileSync(join(target(), 'stale.md'), 'old');
    expect(install(pack('v2')).stdout.trim()).toBe('installed');
    expect(readFileSync(join(target(), 'SKILL.md'), 'utf8')).toBe('v2');
    expect(existsSync(join(target(), 'stale.md'))).toBe(false);
  });

  it('never touches a foreign skill dir (no marker)', () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), 'SKILL.md'), 'my own skill');
    expect(install(pack('v1')).stdout.trim()).toBe('foreign');
    expect(readFileSync(join(target(), 'SKILL.md'), 'utf8')).toBe('my own skill');
  });

  it('treats a symlinked skill dir without marker as foreign, even a dangling one', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, 'nowhere'), target());
    expect(install(pack('v1')).stdout.trim()).toBe('foreign');
    expect(existsSync(join(home, 'nowhere'))).toBe(false);
  });

  it('a broken payload keeps the old mirror and leaves no temp dir', () => {
    install(pack('v1'));
    const res = install(Buffer.from('not a tar archive'));
    expect(res.status).not.toBe(0);
    expect(readFileSync(join(target(), 'SKILL.md'), 'utf8')).toBe('v1');
    const left = readdirSync(join(home, '.claude', 'skills'));
    expect(left).toEqual(['codeman']);
  });

  it('the local pack never ships a marker file of its own', () => {
    writeFileSync(join(src, REMOTE_AGENT_SKILL_MARKER_FILE), '');
    const listing = execFileSync('tar', ['-tf', '-'], { input: pack('v1'), encoding: 'utf8' });
    expect(listing).toContain('SKILL.md');
    expect(listing).not.toContain(REMOTE_AGENT_SKILL_MARKER_FILE);
  });

  it('packs nothing without a SKILL.md', () => {
    rmSync(join(src, 'SKILL.md'), { force: true });
    expect(packAgentSkillDir(src)).toBeNull();
  });

  it('connects with the launch connection args', () => {
    const cmd = buildRemoteAgentSkillInstallCommand({ ...host, port: 2222 });
    expect(cmd.startsWith('ssh -o BatchMode=yes ')).toBe(true);
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain('j@192.168.50.137');
    expect(cmd).not.toContain(' -t ');
  });
});

describe('installRemoteAgentSkill', () => {
  beforeEach(() => resetRemoteAgentCliInstallMemo());
  const deps = (run: (c: string, s: Buffer) => Promise<string>, skill: Buffer | null = Buffer.from('tar')) => ({
    readSkill: () => skill,
    run,
    log: () => {},
  });

  it('skips a host without agentApiUrl (no ssh at all)', async () => {
    let calls = 0;
    expect(
      await installRemoteAgentSkill(
        host,
        deps(async () => (calls++, 'installed'))
      )
    ).toBe('skipped');
    expect(calls).toBe(0);
  });

  it('skips when the server has no skill', async () => {
    let calls = 0;
    expect(
      await installRemoteAgentSkill(
        { ...host, agentApiUrl: URL },
        deps(async () => (calls++, 'installed'), null)
      )
    ).toBe('skipped');
    expect(calls).toBe(0);
  });

  it('mirrors once per host and content; an edited skill goes out again', async () => {
    let calls = 0;
    const d = deps(async () => (calls++, 'installed\n'));
    expect(await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, d)).toBe('installed');
    expect(await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, d)).toBe('skipped');
    expect(calls).toBe(1);
    expect(
      await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, { ...d, readSkill: () => Buffer.from('tar2') })
    ).toBe('installed');
    expect(calls).toBe(2);
  });

  it('does not share the memo with the CLI install (same host, both go out)', async () => {
    let calls = 0;
    const run = async () => (calls++, 'installed');
    await installRemoteAgentCli(
      { ...host, agentApiUrl: URL },
      { readBundle: () => Buffer.from('x'), run, log: () => {} }
    );
    await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, deps(run, Buffer.from('x')));
    expect(calls).toBe(2);
  });

  it('never throws on failure and retries next time', async () => {
    let calls = 0;
    const d = deps(async () => {
      calls++;
      throw new Error('ssh: No route to host');
    });
    expect(await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, d)).toBe('failed');
    expect(await installRemoteAgentSkill({ ...host, agentApiUrl: URL }, d)).toBe('failed');
    expect(calls).toBe(2);
  });

  it('reports a foreign skill', async () => {
    expect(
      await installRemoteAgentSkill(
        { ...host, agentApiUrl: URL },
        deps(async () => 'foreign')
      )
    ).toBe('foreign');
  });

  it('is a no-op under vitest without injected deps (never touches the real home)', async () => {
    expect(await installRemoteAgentSkill({ ...host, agentApiUrl: URL })).toBe('skipped');
  });
});

describe('launch wiring', () => {
  // Launch and respawn both push the CLI; the skill must ride along on each path,
  // otherwise a respawned remote agent gets the binary but not the instructions.
  it('every remote CLI install site also mirrors the skill', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'tmux-manager.ts'), 'utf8');
    const cli = src.match(/void installRemoteAgentCli\(remote\);/g) ?? [];
    const skill = src.match(/void installRemoteAgentSkill\(remote\);/g) ?? [];
    expect(cli.length).toBe(2);
    expect(skill.length).toBe(cli.length);
  });
});
