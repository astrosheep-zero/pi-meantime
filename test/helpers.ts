import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TaskRuntime } from '../src/runtime.ts';
import { TaskStore } from '../src/store.ts';
import { validateConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Outcome, Result } from '../src/protocol.ts';
import type { Snapshot, TaskIndex, RuntimeSink } from '../src/runtime.ts';
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
  const config = validateConfig({ storageRoot: root, autoDetachMs: 15, shutdownGraceMs: 10, notifyDebounceMs: 5, ...overrides });
  const notifications: Snapshot[][] = [];
  const store = new TaskStore(root, 'test-owner', config.maxResultBytes);
  const records = new Map<string, TaskIndex>();
  const sink: RuntimeSink = { notify: tasks => notifications.push(tasks), index(change) {
    if ('task' in change) records.set(change.task.id, structuredClone(change.task));
    else for (const id of change.removed) records.delete(id);
  } };
  const runtime = new TaskRuntime(store, config, sink);
  return { root, config, store, runtime, notifications, records, sink, async close() {
    await runtime.close(); rmSync(root, { recursive: true, force: true });
  } };
}
