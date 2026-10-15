/**
 * Local edit-source reader: same contract as the remote one, against a temp projects dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeLocalPaths, readLocalClaudeEditSources } from '../src/edit-history-local-source.js';

let root: string;
const opts = () => ({ projectsDir: root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-src-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string | Buffer, mtimeSec?: number): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (mtimeSec) utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

describe('readLocalClaudeEditSources', () => {
  it('returns null when no transcript exists under any id', async () => {
    put('p/other.jsonl', 'x\n');
    expect(await readLocalClaudeEditSources(['sid'], [], 100, opts())).toBeNull();
  });

  it('takes the first id that has a transcript, the newest one across project dirs', async () => {
    put('a/sid.jsonl', 'old\n', 1000);
    put('b/sid.jsonl', 'new\n', 2000);
    put('c/second.jsonl', 'x\n');
    const res = await readLocalClaudeEditSources(['bad id!', 'sid', 'second'], [], 100, opts());
    expect(res?.transcriptId).toBe('sid');
    expect(res?.files[0].chunk.toString()).toBe('new\n');
  });

  it('reads a new file from its end within the budget, a requested one from its offset', async () => {
    put('p/sid.jsonl', '0123456789');
    const fresh = await readLocalClaudeEditSources(['sid'], [], 4, opts());
    expect(fresh?.files).toEqual([{ relPath: 'main', size: 10, startOffset: 6, chunk: Buffer.from('6789') }]);
    const cont = await readLocalClaudeEditSources(['sid'], [{ relPath: 'main', offset: 3, len: 2 }], 100, opts());
    expect(cont?.files[0]).toMatchObject({ startOffset: 3, chunk: Buffer.from('34') });
  });

  it('clamps an offset past the end to the size (a replaced, shorter file)', async () => {
    put('p/sid.jsonl', 'abc');
    const res = await readLocalClaudeEditSources(['sid'], [{ relPath: 'main', offset: 50 }], 100, opts());
    expect(res?.files[0]).toMatchObject({ size: 3, startOffset: 3, chunk: Buffer.alloc(0) });
  });

  it('lists subagents with their meta for new ones only, and shares the budget main first', async () => {
    put('p/sid.jsonl', 'MAIN');
    put('p/sid/subagents/agent-a1.jsonl', 'AAAA');
    put('p/sid/subagents/agent-a1.meta.json', '{"description":"Fix it"}');
    put('p/sid/subagents/agent-b2.jsonl', 'BBBB');
    put('p/sid/subagents/agent-b2.meta.json', '{"description":"Other"}');
    put('p/sid/subagents/notes.txt', 'ignored');
    const res = await readLocalClaudeEditSources(
      ['sid'],
      [{ relPath: 'subagents/agent-b2.jsonl', offset: 0 }],
      6,
      opts()
    );
    expect(res?.files.map((f) => [f.relPath, f.startOffset, f.chunk.toString()])).toEqual([
      ['main', 0, 'MAIN'],
      ['subagents/agent-a1.jsonl', 2, 'AA'],
      ['subagents/agent-b2.jsonl', 0, ''],
    ]);
    expect(res?.metas).toEqual({ a1: '{"description":"Fix it"}' });
  });

  it('ignores invalid requests', async () => {
    put('p/sid.jsonl', 'abcdef');
    const res = await readLocalClaudeEditSources(
      ['sid'],
      [
        { relPath: '../etc/passwd', offset: 0 },
        { relPath: 'main', offset: -1 },
      ],
      3,
      opts()
    );
    // The invalid main request is dropped, so main is read like a new file.
    expect(res?.files[0]).toMatchObject({ startOffset: 3, chunk: Buffer.from('def') });
  });

  it('keeps multibyte bytes intact (byte offsets, not string lengths)', async () => {
    put('p/sid.jsonl', Buffer.from('äöü\n', 'utf8'));
    const res = await readLocalClaudeEditSources(['sid'], [{ relPath: 'main', offset: 2 }], 100, opts());
    expect(res?.files[0].chunk).toEqual(Buffer.from('äöü\n', 'utf8').subarray(2));
  });
});

describe('probeLocalPaths', () => {
  it('reports kind, size and mtime, expands ~/ against home, null for missing', async () => {
    put('home/img.png', 'PNG!', 1_700_000_000);
    mkdirSync(join(root, 'dir'));
    const res = await probeLocalPaths(['~/img.png', join(root, 'dir'), join(root, 'nope.png')], join(root, 'home'));
    expect(res[0]).toEqual({ realPath: join(root, 'home/img.png'), kind: 'file', size: 4, mtimeMs: 1_700_000_000_000 });
    expect(res[1]).toMatchObject({ kind: 'directory', size: 0 });
    expect(res[2]).toBeNull();
  });
});
