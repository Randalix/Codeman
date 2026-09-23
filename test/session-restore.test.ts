/**
 * @fileoverview Host-local restore helpers: opencode conversation discovery and the
 * `deleted` records the server writes to the lifecycle log. Pure/injectable — nothing
 * here spawns opencode or touches the live server.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
    expect(await discoverCliSessionId({ mode: 'opencode', workingDir: '/cases/A', runner })).toBe('ses_x');
    expect(calls[0][0]).toBe('opencode');
    expect(calls[0][1]).toContain('session');
    expect(calls[0][2]).toBe('/cases/A');
  });

  it('returns null for a failing runner and for a mode with no discovery', async () => {
    const failing: ConversationRunner = async () => ({ code: 1, stdout: '' });
    expect(await discoverCliSessionId({ mode: 'opencode', workingDir: '/cases/A', runner: failing })).toBeNull();
    expect(await discoverCliSessionId({ mode: 'claude', workingDir: '/cases/A' })).toBeNull();
    expect(DISCOVERY_BY_MODE.opencode).toBeDefined();
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
