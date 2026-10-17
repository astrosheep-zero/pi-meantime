import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, mkdirSync,
  renameSync, readdirSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from './protocol.ts';
import { isRecord } from './schema.ts';

export interface StoredResult { result: Result; truncated: boolean; originalBytes: number; path: string }
export function cleanText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
export function truncateUtf8(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function validateId(id: string): void {
  if (!/^bg_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task id');
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlink task directory');
  chmodSync(path, 0o700);
}
/** Atomic per-task snapshots. Result data is deliberately separate from status
 * and notification summaries. No input arguments or credentials are persisted. */
export class TaskStore {
  readonly directory: string;
  readonly maxBytes: number;
  constructor(root: string, owner: string, maxBytes: number) {
    privateDir(root);
    this.directory = join(root, createHash('sha256').update(owner).digest('hex').slice(0, 32));
    privateDir(this.directory);
    this.maxBytes = maxBytes;
  }
  private path(id: string, suffix: string): string {
    validateId(id); return join(this.directory, `${id}.${suffix}.json`);
  }
  private atomic(path: string, value: unknown): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); }
    finally { closeSync(fd); }
    try { renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  saveMeta(id: string, meta: unknown): void { this.atomic(this.path(id, 'meta'), meta); }
  readMeta(id: string): Record<string, unknown> | undefined {
    const path = this.path(id, 'meta');
    let fd: number;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Unsafe metadata file');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isRecord(value) || value.id !== id) throw new Error('Invalid task metadata');
      return value;
    } finally { closeSync(fd); }
  }
  // Synchronous read/merge/rename is one uninterrupted operation for runtimes
  // in the same Pi process. This is not a cross-process transactional database.
  updateMeta(id: string, update: (current: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
    const current = this.readMeta(id);
    if (!current) throw new Error('Task metadata disappeared; refusing to recreate a stale record');
    const next = update(current);
    this.saveMeta(id, next);
    return next;
  }
  saveResult(id: string, result: Result): StoredResult {
    // Never fabricate success after serialization failure or enormous output.
    const text = JSON.stringify(result);
    const originalBytes = Buffer.byteLength(text);
    const truncated = originalBytes > this.maxBytes;
    const retained: Result = truncated ? {
      content: [{ type: 'text', text: `Result exceeded ${this.maxBytes} bytes; structured data/images omitted. Original bytes: ${originalBytes}.\n${truncateUtf8(cleanText(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')), Math.floor(this.maxBytes / 4))}` }],
      details: { truncated: true, originalBytes },
      isError: result.isError,
      usage: result.usage,
    } : result;
    const path = this.path(id, 'result');
    this.atomic(path, retained);
    return { result: retained, truncated, originalBytes, path };
  }
  readResult(id: string): Result {
    const path = this.path(id, 'result');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.size > this.maxBytes * 2) throw new Error('Unsafe result file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isRecord(value) || !Array.isArray(value.content)) throw new Error('Invalid stored result');
      return value as unknown as Result;
    } finally { closeSync(fd); }
  }
  loadMetadata(): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    for (const file of readdirSync(this.directory)) {
      const id = file.replace(/\.meta\.json$/, '');
      if (!file.endsWith('.meta.json') || !/^bg_[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const path = this.path(id, 'meta');
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
        const meta: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (isRecord(meta)) records.push(meta);
      } catch { /* A bad snapshot must not prevent other tasks from being recovered. */ }
    }
    return records;
  }
  remove(id: string): void {
    // Keep metadata discoverable if deleting the result fails. Callers retain
    // the record and surface the error rather than silently orphaning a result.
    for (const suffix of ['result', 'meta']) rmSync(this.path(id, suffix), { force: true });
  }
}
