import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_API_URL_PATTERN,
  REMOTE_AGENT_CLI_MARKER,
  buildRemoteAgentCliInstallCommand,
  buildRemoteAgentCliInstallScript,
  installRemoteAgentCli,
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
