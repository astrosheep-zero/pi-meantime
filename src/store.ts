import { randomBytes } from 'node:crypto';

export function truncateUtf8(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export const TASK_ID = /^mt_[a-f0-9]{8}$/;
export function newTaskId(): string { return `mt_${randomBytes(4).toString('hex')}`; }
