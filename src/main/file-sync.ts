import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  FileManifestEntry,
  FileChunk,
  FILE_CHUNK_SIZE,
  MAX_FILE_SIZE,
  IGNORE_PATTERNS,
} from '../shared/types';

/**
 * Check if a file/directory name matches ignore patterns.
 * Handles: exact directory names, file extensions (*.ext), exact filenames.
 */
export function matchesIgnorePattern(name: string, isDirectory: boolean): boolean {
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.startsWith('*.')) {
      // Extension match
      if (!isDirectory && name.endsWith(pattern.slice(1))) return true;
    } else {
      // Exact name match (works for both dirs and files)
      if (name === pattern) return true;
    }
  }
  return false;
}

/**
 * Normalize path to forward slashes for cross-platform compat.
 */
function normalizePath(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Quick hash: SHA-256 of (first 4KB + last 4KB + size string).
 * Fast enough for diffing without reading entire file.
 */
function quickHash(filePath: string, size: number): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(4096, size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    hash.update(headBuf);

    if (size > 4096) {
      const tailBuf = Buffer.alloc(Math.min(4096, size));
      fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, size - 4096));
      hash.update(tailBuf);
    }

    hash.update(String(size));
    return hash.digest('hex').slice(0, 16);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build a manifest of all files under projectPath, skipping ignored patterns.
 */
export function buildManifest(projectPath: string): FileManifestEntry[] {
  const entries: FileManifestEntry[] = [];

  function walk(dir: string) {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (matchesIgnorePattern(item.name, item.isDirectory())) continue;

      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;

          const relPath = normalizePath(path.relative(projectPath, fullPath));
          entries.push({
            path: relPath,
            size: stat.size,
            quickHash: quickHash(fullPath, stat.size),
            modifiedAt: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(projectPath);
  return entries;
}

/**
 * Read a file and split into base64-encoded chunks.
 */
export function readFileChunked(projectPath: string, relPath: string, syncId: string): FileChunk[] {
  const fullPath = path.join(projectPath, ...relPath.split('/'));
  const data = fs.readFileSync(fullPath);
  const totalChunks = Math.ceil(data.length / FILE_CHUNK_SIZE) || 1;
  const chunks: FileChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * FILE_CHUNK_SIZE;
    const end = Math.min(start + FILE_CHUNK_SIZE, data.length);
    chunks.push({
      syncId,
      filePath: relPath,
      chunkIndex: i,
      totalChunks,
      data: data.subarray(start, end).toString('base64'),
      fileSize: data.length,
    });
  }

  return chunks;
}

/**
 * Reassemble chunks and write file to disk.
 * Returns true when all chunks received and file written.
 */
const pendingFiles: Map<string, Map<number, string>> = new Map();

export function receiveChunk(projectPath: string, chunk: FileChunk): boolean {
  const key = `${chunk.syncId}:${chunk.filePath}`;

  if (!pendingFiles.has(key)) {
    pendingFiles.set(key, new Map());
  }
  const chunkMap = pendingFiles.get(key)!;
  chunkMap.set(chunk.chunkIndex, chunk.data);

  if (chunkMap.size === chunk.totalChunks) {
    // All chunks received — reassemble and write
    const parts: Buffer[] = [];
    for (let i = 0; i < chunk.totalChunks; i++) {
      parts.push(Buffer.from(chunkMap.get(i)!, 'base64'));
    }
    const fullData = Buffer.concat(parts);

    const fullPath = path.join(projectPath, ...chunk.filePath.split('/'));
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, fullData);

    pendingFiles.delete(key);
    return true;
  }

  return false;
}

/**
 * Compare two manifests and return paths that differ or are new.
 */
export function diffManifests(
  local: FileManifestEntry[],
  remote: FileManifestEntry[]
): { toPush: string[]; toPull: string[] } {
  const localMap = new Map(local.map(e => [e.path, e]));
  const remoteMap = new Map(remote.map(e => [e.path, e]));

  const toPush: string[] = [];
  const toPull: string[] = [];

  // Files that are new or changed locally
  for (const [p, entry] of localMap) {
    const remote = remoteMap.get(p);
    if (!remote || remote.quickHash !== entry.quickHash) {
      toPush.push(p);
    }
  }

  // Files that are new or changed on remote
  for (const [p, entry] of remoteMap) {
    const local = localMap.get(p);
    if (!local || local.quickHash !== entry.quickHash) {
      toPull.push(p);
    }
  }

  return { toPush, toPull };
}
