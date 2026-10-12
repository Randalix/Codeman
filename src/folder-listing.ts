/**
 * @fileoverview Folder listings for the file-preview folder grid.
 *
 * A folder the user opens (a clicked folder path, or "Folder" in the file
 * preview) is resolved, checked against the same attachment guard a single file
 * goes through, and GRANTED an id. The grid then asks for files by
 * `folderId + file name` only, so browser requests never carry arbitrary paths —
 * the rule the attachment routes follow for single files.
 *
 * Grants live in their own small registry, not in the attachment registry: that one
 * is capped at 200 records per session, and a folder of 300 renders would evict the
 * session's real attachments.
 *
 * Listings contain non-hidden subfolders and files whose type the preview supports
 * (`isSupportedAttachmentExtension`), newest first, capped at
 * {@link MAX_FOLDER_ENTRIES}. Local folders are read with `fs`; a remote (SSH) case's
 * folder is listed on its host in one ssh round trip (`remoteListFolder`).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, posix } from 'node:path';
import {
  getAttachmentType,
  isSupportedAttachmentExtension,
  supportedAttachmentExtensions,
} from './attachment-registry.js';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from './config/attachment-guard.js';
import { isMultiUserMode, userSpacePath } from './config/multiuser.js';
import { remoteListFolder, RemoteFileAccessError, type RemoteFolderEntry } from './remote-files.js';
import type { AttachmentDetectedType, AuthUser } from './types.js';
import type { SessionRemote } from './types/session.js';
import { describeUnknownPath, probePathKind } from './utils/bounded-path-probe.js';
import { validateSessionFilePath } from './web/route-helpers.js';

/** Most entries (files + subfolders) one listing returns. */
export const MAX_FOLDER_ENTRIES = 1000;

/** Most paths one path set (`{a,b}` brace expansion) may name. */
export const MAX_PATH_SET_PATHS = 100;

/** Most distinct folders one path set may span; each costs one listing (one ssh round trip on a remote case). */
export const MAX_PATH_SET_FOLDERS = 16;

/** Folder grants kept per session; the oldest is dropped beyond this. */
const MAX_FOLDER_GRANTS_PER_SESSION = 32;

export interface FolderFileEntry {
  name: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
}

export interface FolderListing {
  folderId: string;
  /** The folder with symlinks resolved (on the session's host). */
  path: string;
  files: FolderFileEntry[];
  /** Non-hidden subfolder names, sorted. */
  folders: string[];
  truncated: boolean;
}

export class FolderListingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
  }
}

interface FolderGrant {
  folderId: string;
  dir: string;
}

class FolderGrants {
  private bySession = new Map<string, Map<string, FolderGrant>>();

  grant(sessionId: string, dir: string): string {
    let grants = this.bySession.get(sessionId);
    if (!grants) {
      grants = new Map();
      this.bySession.set(sessionId, grants);
    }
    for (const existing of grants.values()) {
      if (existing.dir === dir) {
        // Refresh its position so an often-used folder is the last to be dropped.
        grants.delete(existing.folderId);
        grants.set(existing.folderId, existing);
        return existing.folderId;
      }
    }
    const folderId = `fld_${randomUUID()}`;
    grants.set(folderId, { folderId, dir });
    while (grants.size > MAX_FOLDER_GRANTS_PER_SESSION) {
      const oldest = grants.keys().next().value;
      if (oldest === undefined) break;
      grants.delete(oldest);
    }
    return folderId;
  }

  get(sessionId: string, folderId: string): FolderGrant | undefined {
    return this.bySession.get(sessionId)?.get(folderId);
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

export const folderGrants = new FolderGrants();

/**
 * A file name inside a granted folder, or null when it is not one: no path
 * separator, not hidden (which also rules out `.`/`..`; the listing leaves hidden
 * entries out, so the routes do too), no NUL, and a type the preview supports.
 */
export function validFolderFileName(name: unknown): string | null {
  if (typeof name !== 'string' || !name || name.length > 255) return null;
  if (name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const extension = extname(name).toLowerCase().replace(/^\./, '');
  return isSupportedAttachmentExtension(extension) ? name : null;
}

/** Where a granted folder's file lives (on the session's host). */
export function folderFilePath(dir: string, name: string): string {
  return posix.join(dir, name);
}

interface ListFolderOptions {
  sessionWorkingDir?: string;
  remote?: SessionRemote;
  /** The requesting identity; in multi-user mode a regular user is held to {@link folderAllowedForUser}. */
  user?: AuthUser;
}

/**
 * Multi-user rule for folder grants, the same one the filesystem path picker follows:
 * a regular user reaches only their own space (`userSpacePath`) or the session's
 * `workingDir`. User spaces live inside `homedir()`, so without it a user could list
 * and read another user's space. Always true in single-user mode and for admins; a
 * remote session's folders are on its host, where only the `workingDir` applies.
 *
 * @param path Already resolved (realpath on the session's host).
 */
export function folderAllowedForUser(
  path: string,
  user: AuthUser | undefined,
  scope: { workingDir?: string; remote?: SessionRemote }
): boolean {
  if (!isMultiUserMode()) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (scope.remote) return !!scope.workingDir && isUnderTree(path, scope.workingDir);
  return [userSpacePath(user.username), scope.workingDir].some(
    (root) => !!root && !!validateSessionFilePath(root, path)
  );
}

/**
 * Resolve, guard, list and grant a folder for `sessionId`.
 *
 * A local folder is probed bounded first (`probePathKind`): one on a network mount
 * that stopped answering must not freeze the server, and "did not answer" is never
 * reported as "not found". The guard runs on the resolved folder before it is read.
 *
 * @param requestedPath Absolute, or `~/…` (the home of the session's host).
 * @throws FolderListingError 400 not absolute / not a folder, 403 blocked or outside the
 *   user's space, 404 missing, 502 remote unreachable, 503 local folder not answering.
 */
export async function listFolder(
  sessionId: string,
  requestedPath: string,
  options: ListFolderOptions = {}
): Promise<FolderListing> {
  const homeRelative = typeof requestedPath === 'string' && (requestedPath === '~' || requestedPath.startsWith('~/'));
  if (!requestedPath || typeof requestedPath !== 'string' || (!isAbsolute(requestedPath) && !homeRelative)) {
    throw new FolderListingError('Folder path must be absolute');
  }

  const guard = await loadAttachmentGuardConfig();
  const workingDir = options.sessionWorkingDir;
  const assertAllowed = (dir: string): void => {
    const confined = !guard.confineToWorkspace
      ? true
      : options.remote
        ? !!workingDir && isUnderTree(dir, workingDir)
        : !!workingDir && !!validateSessionFilePath(workingDir, dir);
    if (!confined || isBlockedAttachmentPath(dir, guard.blockedTrees)) {
      throw new FolderListingError('Access to this folder is blocked', 403);
    }
    if (!folderAllowedForUser(dir, options.user, { workingDir, remote: options.remote })) {
      throw new FolderListingError('Folder is outside your space', 403);
    }
  };

  let dir: string;
  let entries: RemoteFolderEntry[];
  let truncated = false;
  if (options.remote) {
    const remotePath = requestedPath === '~' ? '~/' : requestedPath;
    let listing;
    try {
      listing = await remoteListFolder(options.remote, remotePath, supportedAttachmentExtensions(), MAX_FOLDER_ENTRIES);
    } catch (err) {
      throw new FolderListingError(err instanceof RemoteFileAccessError ? err.message : 'remote host unreachable', 502);
    }
    if (!listing) throw new FolderListingError('Folder not found', 404);
    if (listing === 'not-a-folder') throw new FolderListingError('Not a folder');
    ({ dir, entries, truncated } = listing);
    // One ssh call lists and resolves together, so the guard can only run after it;
    // nothing of a refused listing leaves this function.
    assertAllowed(dir);
  } else {
    const expanded = homeRelative ? join(homedir(), requestedPath.slice(2)) : requestedPath;
    const kind = await probePathKind(expanded, { pastCap: true });
    if (kind === 'unknown') {
      throw new FolderListingError(describeUnknownPath('Folder', expanded, { pastCap: true }), 503);
    }
    if (kind === 'absent') throw new FolderListingError('Folder not found', 404);
    if (kind !== 'directory') throw new FolderListingError('Not a folder');
    try {
      dir = await fs.realpath(expanded);
    } catch {
      throw new FolderListingError('Folder not found', 404);
    }
    assertAllowed(dir);
    ({ entries, truncated } = await listLocalFolder(dir));
  }

  const files: FolderFileEntry[] = [];
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // A secret that happens to sit in an open folder stays out of the grid too.
    if (isBlockedAttachmentPath(folderFilePath(dir, entry.name), guard.blockedTrees)) continue;
    if (entry.kind === 'directory') {
      folders.push(entry.name);
      continue;
    }
    const extension = extname(entry.name).toLowerCase().replace(/^\./, '');
    if (!isSupportedAttachmentExtension(extension)) continue;
    files.push({
      name: entry.name,
      extension,
      attachmentType: getAttachmentType(extension),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  folders.sort((a, b) => a.localeCompare(b));

  return { folderId: folderGrants.grant(sessionId, dir), path: dir, files, folders, truncated };
}

/** Local counterpart of the remote listing script: subfolders + supported files, stat'ed through symlinks. */
async function listLocalFolder(dir: string): Promise<{ entries: RemoteFolderEntry[]; truncated: boolean }> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries: RemoteFolderEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    if (entries.length >= MAX_FOLDER_ENTRIES) {
      truncated = true;
      break;
    }
    const extension = extname(dirent.name).toLowerCase().replace(/^\./, '');
    const maybeFile = isSupportedAttachmentExtension(extension);
    if (!dirent.isDirectory() && !maybeFile && !dirent.isSymbolicLink()) continue;
    let stat;
    try {
      stat = await fs.stat(join(dir, dirent.name));
    } catch {
      continue; // dangling symlink, or gone since readdir
    }
    if (stat.isDirectory()) {
      entries.push({ kind: 'directory', name: dirent.name, size: 0, mtimeMs: 0 });
    } else if (stat.isFile() && maybeFile) {
      entries.push({ kind: 'file', name: dirent.name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return { entries, truncated };
}

export interface PathSetListing {
  /** One per folder that holds at least one requested name; files and folders narrowed to those names. */
  listings: FolderListing[];
  /** Requested paths with no previewable file or folder there (or in a folder the guard refused). */
  missing: string[];
}

/**
 * List the files a set of paths names — what a shell brace set
 * (`…/{vorher,nachher}/synth-{sedan,jeep}/{leerlauf,start}.wav`) expands to.
 *
 * Each distinct folder goes through {@link listFolder}, so it is granted and
 * guarded exactly like a clicked folder, and the grid serves its files over the
 * ordinary `folders/:folderId/files/:name` routes: a path set adds no way to read
 * anything a folder click did not already allow. The answer is each listing cut
 * down to the requested names, files and subfolders in the order asked.
 *
 * A folder the guard refuses (or that is gone) only drops ITS paths into
 * `missing`; the error surfaces when nothing at all is left.
 *
 * @throws FolderListingError 400 for a malformed or oversized request, the first
 *   non-404 folder error (403, 502, 503) when no folder was usable, else 404.
 */
export async function listPathSet(
  sessionId: string,
  requestedPaths: unknown,
  options: ListFolderOptions = {}
): Promise<PathSetListing> {
  if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) {
    throw new FolderListingError('Missing paths');
  }
  if (requestedPaths.length > MAX_PATH_SET_PATHS) {
    throw new FolderListingError(`A path set holds at most ${MAX_PATH_SET_PATHS} paths`);
  }

  const groups = new Map<string, Array<{ name: string; path: string }>>();
  for (const raw of requestedPaths) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new FolderListingError('Invalid path');
    const homeRelative = raw.startsWith('~/');
    if (!homeRelative && !isAbsolute(raw)) throw new FolderListingError('Path must be absolute');
    const path = posix.normalize(raw).replace(/\/+$/, '') || '/';
    const cut = path.lastIndexOf('/');
    const name = path.slice(cut + 1);
    if (!name || name === '.' || name === '..') throw new FolderListingError('Invalid path');
    const dir = cut > 0 ? path.slice(0, cut) : '/';
    const entries = groups.get(dir) ?? [];
    entries.push({ name, path });
    groups.set(dir, entries);
  }
  if (groups.size > MAX_PATH_SET_FOLDERS) {
    throw new FolderListingError(`A path set spans at most ${MAX_PATH_SET_FOLDERS} folders`);
  }

  const settled = await Promise.all(
    [...groups].map(async ([dir, entries]) => {
      try {
        return { entries, listing: await listFolder(sessionId, dir, options), error: null };
      } catch (err) {
        if (err instanceof FolderListingError) return { entries, listing: null, error: err };
        throw err;
      }
    })
  );

  const listings: FolderListing[] = [];
  const missing: string[] = [];
  let firstError: FolderListingError | null = null;
  for (const { entries, listing, error } of settled) {
    if (!listing) {
      missing.push(...entries.map((e) => e.path));
      if (error && error.statusCode !== 404 && !firstError) firstError = error;
      continue;
    }
    const byName = new Map(listing.files.map((f) => [f.name, f]));
    const folderNames = new Set(listing.folders);
    const files: FolderFileEntry[] = [];
    const folders: string[] = [];
    for (const { name, path } of entries) {
      const file = byName.get(name);
      if (file) files.push(file);
      else if (folderNames.has(name)) folders.push(name);
      else missing.push(path);
    }
    if (files.length === 0 && folders.length === 0) continue;
    listings.push({ ...listing, files, folders });
  }
  if (listings.length === 0) {
    throw firstError ?? new FolderListingError('None of these paths exists', 404);
  }
  return { listings, missing };
}
