/**
 * @fileoverview The local twin of `remoteReadClaudeEditSources` (remote-files.ts): reads a
 * claude session's main transcript and its subagent transcripts from byte offsets, for
 * the edit history of a session that runs on this host.
 *
 * Same contract as the remote read, so the sync treats both alike:
 *   - the main transcript is the newest `<projects>/<dir>/<id>.jsonl` of the first id that
 *     has one; subagents live in `<that path without .jsonl>/subagents/agent-<id>.jsonl`;
 *   - a requested file is read from its `offset` (clamped to its size), an unrequested
 *     (new) one from `budget` bytes before its end, and a new subagent's `.meta.json`
 *     (≤ 8 KB) comes along;
 *   - `budgetBytes` is shared by all files, main first; once spent, files still report
 *     their size with an empty chunk.
 * Returns null when no transcript exists under any id.
 *
 * Tests: `test/edit-history-local-source.test.ts`.
 *
 * @module edit-history-local-source
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  EditSourceRequest,
  RemoteClaudeEditSources,
  RemoteClaudeEditSourceFile,
  RemoteProbe,
} from './remote-files.js';

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const REL_PATH_PATTERN = /^(main|subagents\/agent-[A-Za-z0-9_-]+\.jsonl)$/;
const AGENT_FILE_PATTERN = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const META_MAX_BYTES = 8192;

export interface LocalEditSourceOptions {
  /** Default `~/.claude/projects`. */
  projectsDir?: string;
}

async function readRange(path: string, offset: number, len: number): Promise<Buffer> {
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh.close();
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** The newest `<id>.jsonl` under any project dir, for the first id that has one. */
async function findMainTranscript(
  projectsDir: string,
  ids: readonly string[]
): Promise<{ id: string; path: string } | null> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const id of new Set(ids)) {
    if (!ID_PATTERN.test(id)) continue;
    let best: { path: string; mtime: number } | null = null;
    for (const dir of dirs) {
      const path = join(projectsDir, dir, `${id}.jsonl`);
      try {
        const s = await stat(path);
        if (s.isFile() && (!best || s.mtimeMs > best.mtime)) best = { path, mtime: s.mtimeMs };
      } catch {
        // not in this project dir
      }
    }
    if (best) return { id, path: best.path };
  }
  return null;
}

export async function readLocalClaudeEditSources(
  ids: readonly string[],
  requests: readonly EditSourceRequest[],
  budgetBytes: number,
  opts: LocalEditSourceOptions = {}
): Promise<RemoteClaudeEditSources | null> {
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const main = await findMainTranscript(projectsDir, ids);
  if (!main) return null;

  const byPath = new Map<string, EditSourceRequest>();
  for (const r of requests) {
    if (!REL_PATH_PATTERN.test(r.relPath) || byPath.has(r.relPath)) continue;
    if (!Number.isSafeInteger(r.offset) || r.offset < 0) continue;
    if (r.len !== undefined && (!Number.isSafeInteger(r.len) || r.len < 0)) continue;
    byPath.set(r.relPath, r);
  }

  const subDir = join(main.path.slice(0, -'.jsonl'.length), 'subagents');
  const sources: Array<{ relPath: string; path: string; agentId?: string }> = [{ relPath: 'main', path: main.path }];
  try {
    for (const name of (await readdir(subDir)).sort()) {
      const m = AGENT_FILE_PATTERN.exec(name);
      if (m) sources.push({ relPath: `subagents/${name}`, path: join(subDir, name), agentId: m[1] });
    }
  } catch {
    // no subagents yet
  }

  let remaining = Math.max(0, Math.floor(budgetBytes));
  const files: RemoteClaudeEditSourceFile[] = [];
  const metas: Record<string, string> = {};
  for (const src of sources) {
    const size = await fileSize(src.path);
    if (size === null) continue;
    const req = byPath.get(src.relPath);
    let start: number;
    let len: number;
    if (req) {
      start = Math.min(req.offset, size);
      len = Math.min(req.len ?? remaining, remaining, size - start);
    } else {
      len = Math.min(size, remaining);
      start = size - len;
    }
    const chunk = await readRange(src.path, start, len);
    remaining -= chunk.length;
    files.push({ relPath: src.relPath, size, startOffset: start, chunk });
    if (!req && src.agentId) {
      const metaPath = join(subDir, `agent-${src.agentId}.meta.json`);
      const metaSize = await fileSize(metaPath);
      if (metaSize !== null) {
        metas[src.agentId] = (await readRange(metaPath, 0, Math.min(metaSize, META_MAX_BYTES))).toString('utf8');
      }
    }
  }
  return { transcriptId: main.id, files, metas };
}

/**
 * The local twin of `remoteProbePaths`: per path its resolved path, kind, size and mtime, or
 * null when it does not exist. A leading `~/` means this user's home, like the remote probe.
 */
export async function probeLocalPaths(
  paths: readonly string[],
  home: string = homedir()
): Promise<Array<RemoteProbe | null>> {
  return Promise.all(
    paths.map(async (p) => {
      const path = p.startsWith('~/') ? join(home, p.slice(2)) : p;
      try {
        const real = await realpath(path);
        const s = await stat(real);
        return {
          realPath: real,
          kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other',
          size: s.isFile() ? s.size : 0,
          mtimeMs: Math.floor(s.mtimeMs),
        } satisfies RemoteProbe;
      } catch {
        return null;
      }
    })
  );
}
