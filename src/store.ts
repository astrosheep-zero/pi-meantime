import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, mkdirSync,
  renameSync, rmSync, lstatSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from './protocol.ts';
import { isRecord } from './schema.ts';

export interface Completion { endedAt: number; isError: boolean; cancelRequestedAt?: number }
export interface StoredResult {
  completion: Completion; result: Result; truncated: boolean; originalBytes: number; path: string;
}
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
export const TASK_ID = /^mt_[a-f0-9]{8}$/;
export function newTaskId(): string { return `mt_${randomBytes(4).toString('hex')}`; }
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlink task directory');
  chmodSync(path, 0o700);
}
/** One immutable completion file per background task. Pi owns the task index.
 * Construction and foreground execution create no directories or files. */
export class TaskStore {
  readonly directory: string;
  readonly root: string;
  readonly maxBytes: number;
  constructor(root: string, owner: string, maxBytes: number) {
    this.root = root; this.maxBytes = maxBytes;
    this.directory = join(root, createHash('sha256').update(owner).digest('hex').slice(0, 32));
  }
  private path(id: string): string {
    if (!TASK_ID.test(id)) throw new Error('Invalid task id');
    return join(this.directory, `${id}.result.json`);
  }
  has(id: string): boolean { return existsSync(this.path(id)); }
  save(id: string, completion: Completion, result: Result): StoredResult {
    const path = this.path(id);
    const text = JSON.stringify(result), originalBytes = Buffer.byteLength(text);
    const truncated = Buffer.byteLength(JSON.stringify({ completion, result, truncated: false, originalBytes })) > this.maxBytes;
    const retained: Result = truncated ? {
      content: [{ type: 'text', text: `Result exceeded ${this.maxBytes} bytes; structured data/images omitted. Original bytes: ${originalBytes}.\n${truncateUtf8(cleanText(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')), Math.floor(this.maxBytes / 4))}` }],
      details: { truncated: true, originalBytes }, isError: result.isError, usage: result.usage,
    } : result;
    privateDir(this.root); privateDir(this.directory);
    const stored = { completion, result: retained, truncated, originalBytes };
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeFileSync(fd, JSON.stringify(stored)); } finally { closeSync(fd); }
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    return { ...stored, path };
  }
  read(id: string): StoredResult | undefined {
    const path = this.path(id);
    let fd: number;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.size > this.maxBytes * 2) throw new Error('Unsafe result file');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isRecord(value) || !isRecord(value.completion) || typeof value.completion.endedAt !== 'number'
        || typeof value.completion.isError !== 'boolean' || !isRecord(value.result) || !Array.isArray(value.result.content)) throw new Error('Invalid stored completion');
      return { ...value, path } as unknown as StoredResult;
    } finally { closeSync(fd); }
  }
  remove(id: string): void { rmSync(this.path(id), { force: true }); }
}
