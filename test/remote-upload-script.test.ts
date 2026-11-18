/**
 * @fileoverview The remote half of a prompt upload (buildRemoteUploadScript), run for
 * real under a local `sh`, the way sshd hands it to the remote login shell: wrapped by
 * remoteLoginShellLine, bytes on stdin. No ssh connection is opened.
 *
 * Port: N/A
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRemoteUploadScript,
  remoteLoginShellLine,
  REMOTE_UPLOAD_DIR_REFUSED_EXIT,
  REMOTE_UPLOAD_NO_WORKSPACE_EXIT,
} from '../src/remote-files.js';

const NAME = 'paste-1700000000000-0a1b2c3d-notes.md';

function runUpload(workspace: string, bytes: Buffer, opts: { size?: number; home?: string; name?: string } = {}) {
  const script = buildRemoteUploadScript(workspace, opts.name ?? NAME, opts.size ?? bytes.length);
  const result = spawnSync('sh', ['-c', remoteLoginShellLine(script)], {
    input: bytes,
    env: { PATH: process.env.PATH, HOME: opts.home ?? process.env.HOME },
  });
  const stdout = result.stdout.toString('utf8');
  return { status: result.status, path: stdout.slice(stdout.lastIndexOf('\0') + 1), stdout };
}

describe('buildRemoteUploadScript', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-remote-upload-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the bytes into a self-ignoring .codeman-uploads and prints the path after a NUL', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 39, 92]);
    const { status, path, stdout } = runUpload(root, bytes);
    expect(status).toBe(0);
    expect(stdout.startsWith('\0')).toBe(true);
    expect(path).toBe(join(root, '.codeman-uploads', NAME));
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(readFileSync(join(root, '.codeman-uploads', '.gitignore'), 'utf8')).toBe('*\n');
    expect(readdirSync(join(root, '.codeman-uploads')).sort()).toEqual(['.gitignore', NAME]);
  });

  it('never overwrites a .gitignore already in the folder', () => {
    mkdirSync(join(root, '.codeman-uploads'));
    writeFileSync(join(root, '.codeman-uploads', '.gitignore'), 'mine\n');
    expect(runUpload(root, Buffer.from('x')).status).toBe(0);
    expect(readFileSync(join(root, '.codeman-uploads', '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('refuses a symlinked .codeman-uploads and writes nothing through it', () => {
    const elsewhere = join(root, 'elsewhere');
    const ws = join(root, 'ws');
    mkdirSync(elsewhere);
    mkdirSync(ws);
    symlinkSync(elsewhere, join(ws, '.codeman-uploads'));
    expect(runUpload(ws, Buffer.from('x')).status).toBe(REMOTE_UPLOAD_DIR_REFUSED_EXIT);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a regular file where the folder should be', () => {
    writeFileSync(join(root, '.codeman-uploads'), '');
    expect(runUpload(root, Buffer.from('x')).status).toBe(REMOTE_UPLOAD_DIR_REFUSED_EXIT);
  });

  it('reports a missing workspace instead of creating it', () => {
    const ws = join(root, 'gone');
    expect(runUpload(ws, Buffer.from('x')).status).toBe(REMOTE_UPLOAD_NO_WORKSPACE_EXIT);
    expect(readdirSync(root)).toEqual([]);
  });

  it('removes a transfer that arrived short, leaving neither the file nor its .part', () => {
    const { status } = runUpload(root, Buffer.from('abc'), { size: 10 });
    expect(status).not.toBe(0);
    expect(readdirSync(join(root, '.codeman-uploads'))).toEqual(['.gitignore']);
  });

  it('takes a ~/ workspace relative to the remote home', () => {
    mkdirSync(join(root, 'proj'));
    const { status, path } = runUpload('~/proj', Buffer.from('hi'), { home: root });
    expect(status).toBe(0);
    expect(path).toBe(join(root, 'proj', '.codeman-uploads', NAME));
  });

  it('keeps a workspace path with quotes, spaces and $(…) a plain path', () => {
    const ws = join(root, `it's a $(touch pwned) dir`);
    mkdirSync(ws);
    const { status, path } = runUpload(ws, Buffer.from('hi'));
    expect(status).toBe(0);
    expect(path).toBe(join(ws, '.codeman-uploads', NAME));
    expect(readdirSync(root)).toEqual([`it's a $(touch pwned) dir`]);
  });

  it('accepts only the route’s own paste names', () => {
    expect(() => buildRemoteUploadScript(root, '../x', 1)).toThrow(/invalid upload name/);
    expect(() => buildRemoteUploadScript(root, 'paste-a b', 1)).toThrow(/invalid upload name/);
    expect(() => buildRemoteUploadScript(root, NAME, -1)).toThrow(/invalid upload size/);
  });
});
