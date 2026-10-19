import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, truncateUtf8 } from '../src/store.ts';
import { TaskRuntime } from '../src/runtime.ts';
import { runtimeHarness, ok, deferred, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

test('only oversized text creates a private atomic output file; traversal and symlinks are rejected', async () => {
  const h = runtimeHarness();
  try {
    assert.deepEqual(h.store.save('mt_12345678', 'small'), { text: 'small', truncated: false });
    assert.equal(existsSync(h.store.directory), false);
    const text = '字'.repeat(20_000), stored = h.store.save('mt_12345678', text);
    assert.equal(statSync(h.store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(stored.outputPath!).mode & 0o777, 0o600);
    assert.equal(readFileSync(stored.outputPath!, 'utf8'), text);
    assert.equal(stored.truncated, false); assert.ok(stored.text.length < 2001);
    assert.deepEqual(readdirSync(h.store.directory), ['mt_12345678.txt']);
    assert.throws(() => h.store.find('../../secret'), /Invalid/);
    assert.equal(h.store.find('mt_00000000'), undefined);
    const external = join(h.root, 'external.txt'); writeFileSync(external, 'external');
    symlinkSync(external, join(h.store.directory, 'mt_87654321.txt'));
    assert.throws(() => h.store.find('mt_87654321'), /Unsafe/);
    const linkedRoot = join(h.root, 'symlink-root'); symlinkSync(h.store.directory, linkedRoot);
    assert.throws(() => new TaskStore(linkedRoot, 'x', 4096).save('mt_12345678', text), /symlink/);
  } finally { await h.close(); }
});
test('long Bash commands and native bounded text survive recovery without any meantime file', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const command = 'echo hello\n'.repeat(10_000), text = 'x'.repeat(40_000);
    const view = await h.runtime.run({ tool: 'bash', kind: 'bash', command, callId: 'long-command', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve(ok(text)); await until(() => TaskRuntime.liveProducerCount() === 0); await h.runtime.close();
    const restored = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
    try {
      const result = restored.result(view.task.id.slice(3));
      assert.equal(result.task.command, command); assert.deepEqual(result.result!.content, ok(text).result.content);
      assert.equal(result.result!.structuredContent, undefined);
      assert.equal(result.task.outputPath, undefined); assert.equal(existsSync(h.store.directory), false);
    } finally { await restored.close(); }
  } finally { work.resolve(ok()); await h.close(); }
});
test('oversized output file alone is capped, with a clean UTF-8 preview', async () => {
  const h = runtimeHarness({ maxResultBytes: 4096 });
  try {
    const result = h.store.save('mt_12345678', '\x1b[31m' + '字'.repeat(20_000));
    assert.equal(result.truncated, true);
    assert.ok(statSync(result.outputPath!).size <= 4096);
    assert.equal(readFileSync(result.outputPath!, 'utf8'), '字'.repeat(1365));
    assert.ok(!result.text.includes('\uFFFD'));
  } finally { await h.close(); }
});
test('Bash native paths and exit codes survive recovery; pruning never deletes Pi files', async () => {
  const h = runtimeHarness({ maxRetained: 1 });
  const path = join(h.root, 'pi-bash-native.log'); writeFileSync(path, 'native');
  try {
    const work = deferred<Outcome>();
    const handle = await h.runtime.run({ tool: 'bash', kind: 'bash', callId: 'native', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve({ result: { content: [{ type: 'text', text: 'native' }], details: { fullOutputPath: '/unused-fallback' },
      structuredContent: { exit_code: 7, full_output_path: path } }, isError: true });
    await until(() => TaskRuntime.liveProducerCount() === 0);
    const restored = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
    try {
      const result = restored.result(handle.task.id);
      assert.equal(result.task.outputPath, path); assert.equal(result.task.exitCode, 7);
      assert.equal(result.task.state, 'failed');
    } finally { await restored.close(); }
    h.runtime.published('native'); h.runtime.result(handle.task.id);
    const next = deferred<Outcome>();
    const other = await h.runtime.run({ tool: 'bash', kind: 'bash', callId: 'small', mode: 'yes', canDetach: true, execute: () => next.promise });
    next.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    h.runtime.published('small'); h.runtime.result(other.task.id);
    assert.throws(() => h.runtime.get(handle.task.id), /No task/);
    assert.equal(readFileSync(path, 'utf8'), 'native');
    assert.equal(existsSync(h.store.directory), false);
  } finally { await h.close(); }
});
test('UTF-8 truncation never creates a partial codepoint', () => {
  for (let n = 0; n <= 12; n++) assert.ok(!truncateUtf8('你🙂a世界', n).includes('\uFFFD'));
});
