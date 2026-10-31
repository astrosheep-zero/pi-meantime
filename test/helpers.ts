import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TaskRuntime } from '../src/runtime.ts';
import { validateConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Outcome, Result } from '../src/protocol.ts';
import type { Snapshot, TaskRecord, RuntimeSink } from '../src/runtime.ts';
export { sleep };
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function ok(text = 'done'): Outcome {
  return { result: { content: [{ type: 'text', text }], details: undefined, structuredContent: { value: text } }, isError: false };
}
export function errorResult(text: string): Result { return { content: [{ type: 'text', text }], details: undefined, isError: true }; }
export async function until(test: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await sleep(5); }
}
export function runtimeHarness(overrides: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-test-'));
  const config = validateConfig({ autoDetachMs: 15, explicitDetachMs: 0, shutdownGraceMs: 10, notifyDebounceMs: 5, ...overrides });
  const notifications: Snapshot[][] = [];
  const records = new Map<string, TaskRecord>();
  const sink: RuntimeSink = { notify: tasks => { notifications.push(tasks); }, index(change) {
    if ('task' in change) records.set(change.task.id, structuredClone(change.task));
    else if ('completion' in change) records.get(change.completion.id)!.completion = structuredClone(change.completion);
    else if ('observed' in change) { const r = records.get(change.observed); if (r) r.observed = true; }
    else if ('delivered' in change) for (const id of change.delivered) { const r = records.get(id); if (r) r.delivered = true; }
    else for (const id of change.removed) records.delete(id);
  } };
  const runtime = new TaskRuntime(config, sink);
  return { root, config, runtime, notifications, records, sink, async close() {
    await runtime.close(); rmSync(root, { recursive: true, force: true });
  } };
}
