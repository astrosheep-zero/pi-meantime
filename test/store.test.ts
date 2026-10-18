import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, truncateUtf8 } from '../src/store.ts';
import { TaskRuntime } from '../src/runtime.ts';
import { runtimeHarness, ok, deferred, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

const completion = { endedAt: 10, isError: false };
test('completion files are private, atomic and reject path traversal', async () => {
  const h = runtimeHarness();
  try {
    const id = 'mt_12345678', stored = h.store.save(id, completion, ok().result);
    assert.equal(statSync(h.store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(stored.path).mode & 0o777, 0o600);
    assert.throws(() => h.store.read('../../secret'), /Invalid/);
    assert.deepEqual(h.store.read(id)!.result.content, ok().result.content);
    assert.deepEqual(h.store.read(id)!.completion, completion);
  } finally { await h.close(); }
});
test('long commands stay in the session index and survive recovery without bloating result files', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const command = 'echo hello\n'.repeat(10_000);
    const view = await h.runtime.run({ tool: 'bash', kind: 'bash', command, callId: 'long-command', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await h.runtime.close();
    const restored = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
    try {
      const result = restored.result(view.task.id.slice(3));
      assert.equal(result.task.command, command); assert.deepEqual(result.result!.content, ok().result.content);
      assert.ok(statSync(result.task.resultPath!).size < 4096);
    } finally { await restored.close(); }
  } finally { work.resolve(ok()); await h.close(); }
});
test('oversized output is explicitly truncated and the whole envelope fits the budget', async () => {
  const h = runtimeHarness({ maxResultBytes: 4096 });
  try {
    const result = h.store.save('mt_12345678', completion, ok('字'.repeat(20_000)).result);
    assert.equal(result.truncated, true); assert.ok(result.originalBytes > 4096);
    assert.ok(statSync(result.path).size < 4096); assert.match(readFileSync(result.path, 'utf8'), /omitted/);
  } finally { await h.close(); }
});
test('UTF-8 truncation never creates a partial codepoint', () => {
  for (let n = 0; n <= 12; n++) assert.ok(!truncateUtf8('你🙂a世界', n).includes('\uFFFD'));
});
test('missing, malformed and symlink results cannot masquerade as a completed operation', async () => {
  const h = runtimeHarness();
  try {
    const id = 'mt_12345678'; assert.equal(h.store.read(id), undefined);
    const stored = h.store.save(id, completion, ok().result);
    writeFileSync(stored.path, '{broken'); assert.throws(() => h.store.read(id));
    const external = join(h.root, 'external.json'); writeFileSync(external, JSON.stringify(ok().result));
    symlinkSync(external, join(h.store.directory, 'mt_87654321.result.json'));
    assert.throws(() => h.store.read('mt_87654321'), /Unsafe/);
    const linkedRoot = join(h.root, 'symlink-root'); symlinkSync(h.store.directory, linkedRoot);
    assert.throws(() => new TaskStore(linkedRoot, 'x', 4096).save(id, completion, ok().result), /symlink/);
  } finally { await h.close(); }
});
