/**
 * @fileoverview Host-local restore helpers: per-mode conversation discovery (claude
 * transcript, codex originator, opencode session list) and the
 * `deleted` records the server writes to the lifecycle log. Pure/injectable — nothing
 * here spawns opencode or touches the live server.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexHistorySession } from '../src/codex-transcript.js';
import {
  claudeTranscriptExists,
  DISCOVERY_BY_MODE,
  discoverCliSessionId,
  findDeletedSession,
  pickOpenCodeSession,
  readDeletedSessions,
  type ConversationRunner,
} from '../src/session-restore.js';

describe('pickOpenCodeSession', () => {
  const dir = '/cases/NeonGetaway';
  const rows = [
    { id: 'ses_old', directory: dir, updated: 100 },
    { id: 'ses_new', directory: dir, updated: 300 },
    { id: 'ses_other', directory: '/cases/Other', updated: 999 },
    { id: 'ses_mid', directory: dir, updated: 200 },
  ];

  it('picks the newest conversation in EXACTLY that directory', () => {
    expect(pickOpenCodeSession(JSON.stringify(rows), dir)).toBe('ses_new');
    expect(pickOpenCodeSession(JSON.stringify(rows), '/cases/Other')).toBe('ses_other');
    expect(pickOpenCodeSession(JSON.stringify(rows), '/cases/Nope')).toBeNull();
  });

  it('is tolerant of garbage (never throws, just no answer)', () => {
    expect(pickOpenCodeSession('not json', dir)).toBeNull();
    expect(pickOpenCodeSession('{}', dir)).toBeNull();
    expect(pickOpenCodeSession(JSON.stringify([null, 42, { id: 'x' }]), dir)).toBeNull();
  });
});

describe('discoverCliSessionId', () => {
  it('runs opencode in the working directory and returns its conversation', async () => {
    const calls: Array<[string, string[], string]> = [];
    const runner: ConversationRunner = async (command, args, cwd) => {
      calls.push([command, args, cwd]);
      return { code: 0, stdout: JSON.stringify([{ id: 'ses_x', directory: '/cases/A', updated: 1 }]) };
    };
    expect(await discoverCliSessionId({ mode: 'opencode', workingDir: '/cases/A', sessionId: 'cm-1', runner })).toBe(
      'ses_x'
    );
    expect(calls[0][0]).toBe('opencode');
    expect(calls[0][1]).toContain('session');
    expect(calls[0][2]).toBe('/cases/A');
  });

  it('returns null for a failing runner and for a mode with no discovery', async () => {
    const failing: ConversationRunner = async () => ({ code: 1, stdout: '' });
    expect(
      await discoverCliSessionId({ mode: 'opencode', workingDir: '/cases/A', sessionId: 'cm-1', runner: failing })
    ).toBeNull();
    expect(await discoverCliSessionId({ mode: 'gemini', workingDir: '/cases/A', sessionId: 'cm-1' })).toBeNull();
    expect(DISCOVERY_BY_MODE.opencode).toBeDefined();
  });
});

describe('claude discovery: the Codeman id is the conversation (--session-id)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function projects(files: Record<string, string[]>): string {
    const root = mkdtempSync(join(tmpdir(), 'codeman-claude-projects-'));
    dirs.push(root);
    for (const [dir, ids] of Object.entries(files)) {
      mkdirSync(join(root, dir));
      for (const id of ids) writeFileSync(join(root, dir, `${id}.jsonl`), '{}\n');
    }
    return root;
  }

  it('returns the Codeman id when Claude wrote a transcript for it, in any project folder', async () => {
    const root = projects({ '-cases-A': ['other'], '-home-joe-wiki-Coding-Projects-Neon-Getaway': ['f2e180e8-x'] });
    expect(claudeTranscriptExists(root, 'f2e180e8-x')).toBe(true);
    expect(
      await discoverCliSessionId({
        mode: 'claude',
        workingDir: '/whatever',
        sessionId: 'f2e180e8-x',
        claudeProjectsDir: root,
      })
    ).toBe('f2e180e8-x');
  });

  it('refuses (null) a session deleted before its first prompt: no transcript, nothing to resume', async () => {
    const root = projects({ '-cases-A': ['other'] });
    expect(
      await discoverCliSessionId({
        mode: 'claude',
        workingDir: '/cases/A',
        sessionId: 'never',
        claudeProjectsDir: root,
      })
    ).toBeNull();
    expect(claudeTranscriptExists(join(root, 'missing'), 'x')).toBe(false);
  });
});

describe("codex discovery: the rollout stamped with this pane's originator", () => {
  const row = (sessionId: string, originator?: string, extra: Partial<CodexHistorySession> = {}): CodexHistorySession =>
    ({ sessionId, originator, workingDir: '/cases/A', source: 'cli', ...extra }) as CodexHistorySession;

  it('picks the newest rollout whose originator is codeman_<id>, ignoring other panes in the same dir', async () => {
    const history = async () => [
      row('thread-other-pane', 'codeman_cm-2'),
      row('thread-after-new', 'codeman_cm-1'),
      row('thread-first', 'codeman_cm-1'),
      row('thread-manual', 'codex_cli_rs'),
    ];
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: history })
    ).toBe('thread-after-new');
  });

  // Measured 2026-09-25: codex 0.157's shared app-server daemon inherited w5's env, and a
  // throwaway pane attached to it wrote its rollout (other case, source "vscode") under
  // w5's originator. Newest-by-originator would have resumed w5 into that thread.
  it("ignores a daemon client's rollout that carries this pane's originator (source vscode)", async () => {
    const history = async () => [
      row('01a0d92c-throwaway', 'codeman_cm-1', { source: 'vscode', workingDir: '/cases/zz-origin-test' }),
      row('01a0d8fa-same-dir-client', 'codeman_cm-1', { source: 'vscode' }),
      row('01a0d755-own', 'codeman_cm-1'),
    ];
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: history })
    ).toBe('01a0d755-own');
  });

  it('matches the directory case-blind, needs it to match, and trusts a rollout with no source field', async () => {
    const other = async () => [row('t-elsewhere', 'codeman_cm-1', { workingDir: '/cases/B' })];
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: other })
    ).toBeNull();
    const legacy = async () => [row('t-legacy', 'codeman_cm-1', { source: undefined, workingDir: '/Cases/a' })];
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: legacy })
    ).toBe('t-legacy');
  });

  it('returns null when no rollout carries the originator, or the scan fails', async () => {
    const none = async () => [row('thread-manual', 'codex_cli_rs')];
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: none })
    ).toBeNull();
    const broken = async (): Promise<CodexHistorySession[]> => {
      throw new Error('EACCES');
    };
    expect(
      await discoverCliSessionId({ mode: 'codex', workingDir: '/cases/A', sessionId: 'cm-1', codexHistory: broken })
    ).toBeNull();
  });
});

describe('readDeletedSessions / findDeletedSession', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeLog(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-lifecycle-'));
    dirs.push(dir);
    const file = join(dir, 'session-lifecycle.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    return file;
  }

  it('reads deleted entries newest-first with the extra rebuild fields', () => {
    const file = writeLog([
      { ts: 1, event: 'started', sessionId: 'a', mode: 'opencode' },
      {
        ts: 2,
        event: 'deleted',
        sessionId: 'a',
        name: 'w35',
        mode: 'opencode',
        reason: 'user_delete',
        extra: { workingDir: '/cases/A', cliSessionId: 'a', remote: false },
      },
      { ts: 3, event: 'created', sessionId: 'b' },
      { ts: 4, event: 'deleted', sessionId: 'b', name: 'w36', mode: 'claude', extra: { workingDir: '/cases/B' } },
    ]);
    const records = readDeletedSessions(file);
    expect(records.map((r) => r.id)).toEqual(['b', 'a']);
    expect(records[1]).toMatchObject({ name: 'w35', mode: 'opencode', workingDir: '/cases/A', cliSessionId: 'a' });
  });

  it('is an empty list for a missing file and skips malformed lines', () => {
    expect(readDeletedSessions('/nonexistent/nope.jsonl')).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'codeman-lifecycle-'));
    dirs.push(dir);
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, '{not json\n' + JSON.stringify({ ts: 9, event: 'deleted', sessionId: 'z' }) + '\n', 'utf-8');
    expect(readDeletedSessions(file).map((r) => r.id)).toEqual(['z']);
  });

  it('findDeletedSession: exact id, then prefix (newest wins), then the newest overall', () => {
    const records = readDeletedSessions(
      writeLog([
        { ts: 1, event: 'deleted', sessionId: 'aaaa1111-x', mode: 'claude' },
        { ts: 2, event: 'deleted', sessionId: 'aaaa2222-y', mode: 'claude' },
        { ts: 3, event: 'deleted', sessionId: 'bbbb3333-z', mode: 'claude' },
      ])
    );
    expect(findDeletedSession(records, 'bbbb3333-z')?.id).toBe('bbbb3333-z');
    expect(findDeletedSession(records, 'aaaa')?.id).toBe('aaaa2222-y');
    expect(findDeletedSession(records)?.id).toBe('bbbb3333-z');
    expect(findDeletedSession(records, 'nope')).toBeUndefined();
  });
});
