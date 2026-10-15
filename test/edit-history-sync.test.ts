/**
 * Edit history sync: readers, store, image confirmation, single-flight, failure states and
 * the wake invariant. Readers and probes are fakes; the store is real (temp dir).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditHistoryStore } from '../src/edit-history-store.js';
import type { EditSourceRequest, RemoteClaudeEditSources, RemoteProbe } from '../src/remote-files.js';
import { RemoteFileAccessError } from '../src/remote-files.js';
import {
  confirmImages,
  EditHistorySync,
  type EditHistorySession,
  type EditHistorySyncDeps,
  unsupportedReason,
} from '../src/web/edit-history-sync.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-15T20:00:00.000Z');

function editLine(id: string, ts: number, path: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: new Date(ts).toISOString(),
      cwd: '/w',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
      toolUseResult: {
        filePath: path,
        oldString: 'a',
        newString: 'b',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      },
      ...extra,
    }) + '\n'
  );
}

function bashPair(id: string, start: number, end: number, command: string): string {
  const use = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(start).toISOString(),
    cwd: '/w',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const res = JSON.stringify({
    type: 'user',
    timestamp: new Date(end).toISOString(),
    cwd: '/w',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: '' }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false },
  });
  return use + '\n' + res + '\n';
}

/** An in-memory "host": files by relPath, served with the reader contract. */
class FakeHost {
  transcriptId = 'conv1';
  files = new Map<string, Buffer>();
  metas: Record<string, string> = {};
  calls: EditSourceRequest[][] = [];
  read = async (
    _ids: readonly string[],
    requests: readonly EditSourceRequest[],
    budget: number
  ): Promise<RemoteClaudeEditSources | null> => {
    this.calls.push([...requests]);
    if (this.files.size === 0) return null;
    let remaining = budget;
    const out: RemoteClaudeEditSources = { transcriptId: this.transcriptId, files: [], metas: {} };
    for (const [relPath, buf] of this.files) {
      const req = requests.find((r) => r.relPath === relPath);
      let start: number;
      let len: number;
      if (req) {
        start = Math.min(req.offset, buf.length);
        len = Math.min(req.len ?? remaining, remaining, buf.length - start);
      } else {
        len = Math.min(buf.length, remaining);
        start = buf.length - len;
        const agent = /^subagents\/agent-(.+)\.jsonl$/.exec(relPath)?.[1];
        if (agent && this.metas[agent]) out.metas[agent] = this.metas[agent];
      }
      remaining -= len;
      out.files.push({ relPath, size: buf.length, startOffset: start, chunk: buf.subarray(start, start + len) });
    }
    return out;
  };
  append(relPath: string, text: string): void {
    this.files.set(relPath, Buffer.concat([this.files.get(relPath) ?? Buffer.alloc(0), Buffer.from(text)]));
  }
}

function setup(over: Partial<EditHistorySyncDeps> = {}) {
  const host = new FakeHost();
  const probes = new Map<string, RemoteProbe>();
  const probe = async (paths: readonly string[]) => paths.map((p) => probes.get(p) ?? null);
  const updated: Array<[string, number]> = [];
  const deps: EditHistorySyncDeps = {
    readLocal: (ids, req, budget) => host.read(ids, req, budget),
    readRemote: (_remote, ids, req, budget) => host.read(ids, req, budget),
    probeLocal: probe,
    probeRemote: (_remote, paths) => probe(paths),
    loadStore: (id) => EditHistoryStore.load(id, { dir, debounceMs: 0 }),
    onUpdated: (id, n) => updated.push([id, n]),
    ...over,
  };
  return { host, probes, updated, deps, sync: new EditHistorySync(deps) };
}

const local: EditHistorySession = { id: 's1', mode: 'claude', remote: undefined, claudeSessionId: 'conv1' };
const remote: EditHistorySession = {
  id: 's2',
  mode: 'claude',
  remote: { host: 'huff' } as EditHistorySession['remote'],
  claudeSessionId: 'conv1',
};

describe('unsupportedReason', () => {
  it('accepts claude, rejects docker and non-claude CLIs', () => {
    expect(unsupportedReason(local)).toBeUndefined();
    expect(unsupportedReason({ ...local, docker: { image: 'x' } })).toBe('docker');
    expect(unsupportedReason({ ...local, mode: 'shell' })).toBe('mode');
  });
});

describe('EditHistorySync', () => {
  it('reads new edits forward from the stored offset and reports them', async () => {
    const { host, sync, updated } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    expect(await sync.sync(local)).toEqual({ state: 'ok' });
    host.append('main', editLine('t2', T0 + 1000, '/w/b.ts'));
    await sync.sync(local);
    expect((await sync.getStore('s1')).list().map((e) => e.id)).toEqual(['t2', 't1']);
    expect(host.calls[1]).toEqual([
      { relPath: 'main', offset: host.files.get('main')!.length - editLine('t2', T0 + 1000, '/w/b.ts').length },
    ]);
    expect(updated).toEqual([
      ['s1', 1],
      ['s1', 1],
    ]);
  });

  it('reads subagent transcripts and records their meta', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    host.append('subagents/agent-a1.jsonl', editLine('t9', T0 + 5, '/w/sub.ts', { isSidechain: true, agentId: 'a1' }));
    host.metas.a1 = '{"description":"Fix it","agentType":"coding"}';
    await sync.sync(remote);
    const store = await sync.getStore('s2');
    expect(store.get('t9')?.agentId).toBe('a1');
    expect(store.getAgents().a1).toEqual({ description: 'Fix it', agentType: 'coding' });
  });

  it('re-reads from the end when the answer names a new conversation', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(remote);
    host.transcriptId = 'conv2';
    host.files.set('main', Buffer.from(editLine('n1', T0 + 9, '/w/n.ts')));
    await sync.sync(remote);
    expect(host.calls.at(-2)).toHaveLength(1); // with the old offset
    expect(host.calls.at(-1)).toEqual([]); // repeated without offsets
    const store = await sync.getStore('s2');
    expect(store.getTranscriptId()).toBe('conv2');
    expect(store.list().map((e) => e.id)).toEqual(['n1', 't1']);
  });

  it('keeps reading in passes when a file grew by more than one budget', async () => {
    const { host, sync } = setup({ budget: 600 });
    host.append('main', editLine('t0', T0, '/w/z.ts'));
    await sync.sync(local);
    for (let i = 1; i <= 3; i++) host.append('main', editLine(`t${i}`, T0 + i, `/w/${i}.ts`));
    await sync.sync(local);
    expect((await sync.getStore('s1')).list()).toHaveLength(4);
  });

  it('turns a Bash image into an entry only when its mtime lies in the call window', async () => {
    const { host, probes, sync } = setup();
    host.append('main', bashPair('b1', T0, T0 + 5000, 'render out/new.png old.png ~/x.png'));
    probes.set('/w/out/new.png', { realPath: '/w/out/new.png', kind: 'file', size: 9, mtimeMs: T0 + 4000 });
    probes.set('/w/old.png', { realPath: '/w/old.png', kind: 'file', size: 9, mtimeMs: T0 - 60_000 });
    probes.set('~/x.png', { realPath: '/home/u/x.png', kind: 'file', size: 9, mtimeMs: T0 + 6500 });
    await sync.sync(local);
    expect((await sync.getStore('s1')).list().map((e) => [e.path, e.tool, e.kind])).toEqual([
      ['/w/out/new.png', 'bash', 'image'],
      ['/home/u/x.png', 'bash', 'image'],
    ]);
  });

  it('keeps the edits when only the image probe fails', async () => {
    const { host, sync } = setup({
      probeLocal: async () => {
        throw new Error('probe failed');
      },
    });
    host.append('main', editLine('t1', T0, '/w/a.ts') + bashPair('b1', T0, T0 + 1, 'x out.png'));
    expect(await sync.sync(local)).toEqual({ state: 'ok' });
    expect((await sync.getStore('s1')).list().map((e) => e.id)).toEqual(['t1']);
  });

  it('reports an unreachable host as unavailable and keeps the stored entries', async () => {
    const { host, sync, deps } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(remote);
    deps.readRemote = async () => {
      throw new RemoteFileAccessError('ssh: connect to host huff port 22: Connection timed out');
    };
    const status = await sync.sync(remote);
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('timed out');
    expect((await sync.getStore('s2')).list()).toHaveLength(1);
  });

  it('marks non-claude sessions unsupported without reading', async () => {
    const { host, sync } = setup();
    expect(await sync.sync({ ...local, mode: 'shell' })).toEqual({ state: 'unsupported', reason: 'mode' });
    expect(host.calls).toEqual([]);
  });

  it('runs one sync per session at a time and folds occasions into one more run', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = host.read;
    host.read = async (...a) => {
      await gate;
      return orig(...a);
    };
    const runs = [sync.sync(local), sync.sync(local), sync.sync(local)];
    release();
    await Promise.all(runs);
    expect(host.calls).toHaveLength(2); // the first run + one folded follow-up
  });

  it('loads older blocks on request', async () => {
    const { host, sync } = setup({ budget: 400 });
    for (let i = 0; i < 4; i++) host.append('main', editLine(`t${i}`, T0 + i, `/w/${i}.ts`));
    await sync.sync(local);
    const store = await sync.getStore('s1');
    const before = store.list().length;
    expect(store.backfillTruncated).toBe(true);
    await sync.sync(local, { older: true });
    expect(store.list().length).toBeGreaterThan(before);
  });

  it('flushAll writes pending saves (shutdown) so a reload keeps the entries', async () => {
    const { host, sync } = setup({ loadStore: (id) => EditHistoryStore.load(id, { dir, debounceMs: 60_000 }) });
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    await sync.flushAll();
    const reloaded = await EditHistoryStore.load('s1', { dir });
    expect(reloaded.list().map((e) => e.id)).toEqual(['t1']);
  });

  it('remove deletes the stored history', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    await (await sync.getStore('s1')).flush();
    await sync.remove('s1');
    expect(() => readFileSync(join(dir, 's1.json'))).toThrow();
  });
});

describe('confirmImages', () => {
  it('ignores directories and missing files', () => {
    const c = [{ toolUseId: 'b', start: T0, end: T0 + 1, paths: ['/d.png', '/m.png'] }];
    const out = confirmImages(c, (p) =>
      p === '/d.png' ? { realPath: p, kind: 'directory', size: 0, mtimeMs: T0 } : null
    );
    expect(out).toEqual([]);
  });

  it('skips a file version already recorded: the ls right after the render, a listing after a Write', () => {
    const png = { realPath: '/w/p.png', kind: 'file' as const, size: 9, mtimeMs: T0 + 900 };
    const render = { toolUseId: 'r', start: T0, end: T0 + 1000, paths: ['/w/p.png'] };
    const ls = { toolUseId: 'l', start: T0 + 1500, end: T0 + 1600, paths: ['/w/p.png'] };
    expect(confirmImages([ls, render], () => png).map((i) => i.toolUseId)).toEqual(['r']);
    // A Write entry for the same path at T0 + 950 already covers it.
    expect(
      confirmImages(
        [ls],
        () => png,
        () => T0 + 950
      )
    ).toEqual([]);
    // A later re-render (newer mtime, outside the slack) is a new version.
    const again = { toolUseId: 'r2', start: T0 + 10_000, end: T0 + 11_000, paths: ['/w/p.png'] };
    const newer = { ...png, mtimeMs: T0 + 10_500 };
    expect(
      confirmImages(
        [again],
        () => newer,
        () => T0 + 1000
      ).map((i) => i.toolUseId)
    ).toEqual(['r2']);
  });
});

describe('wake invariant (wiring guard)', () => {
  it('the edit history modules never reach the wake registry', () => {
    for (const file of [
      'src/web/edit-history-sync.ts',
      'src/edit-history-store.ts',
      'src/edit-history-local-source.ts',
    ]) {
      const src = readFileSync(join(__dirname, '..', file), 'utf-8');
      expect(src).not.toMatch(/^import .*remote-wake/m);
      expect(src).not.toMatch(/RemoteWakeRegistry|ensureAwake|handleInput/);
    }
  });
});

vi.setConfig({ testTimeout: 10_000 });
