import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, mkdirSync,
  renameSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

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
/** Only oversized tool text needs a file. Pi owns the completion index and Bash files. */
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
    return join(this.directory, `${id}.txt`);
  }
  find(id: string): string | undefined {
    const path = this.path(id);
    try {
      if (!lstatSync(path).isFile()) throw new Error('Unsafe output file');
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(id: string, raw: string): { text: string; truncated: boolean; outputPath?: string } {
    const text = cleanText(raw);
    if (Buffer.byteLength(text) <= 50 * 1024) return { text, truncated: false };
    const path = this.path(id), retained = truncateUtf8(text, this.maxBytes);
    privateDir(this.root); privateDir(this.directory);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, retained); } finally { closeSync(fd); }
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    return { text: truncateUtf8(retained, 2000), truncated: retained !== text, outputPath: path };
  }
  remove(id: string): void { rmSync(this.path(id), { force: true }); }
}
