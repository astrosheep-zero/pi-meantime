import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { truncateUtf8 } from '../src/store.ts';
import { TaskRuntime } from '../src/runtime.ts';
import { runtimeHarness, ok, deferred, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

test('background wait keeps the native result object, blocks and controls; index text has no extra cap', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const command = 'echo hello\n'.repeat(10_000), text = '\x1b[31m\x00' + '字'.repeat(20_000);
    const native = { content: [{ type: 'text' as const, text }, { type: 'image' as const, data: 'eA==', mimeType: 'image/png' }, { type: 'text' as const, text: 'tail' }],
      details: { original: true }, structuredContent: { native: 'data' } };
    const view = await h.runtime.run({ tool: 'extension', kind: 'tool', command, callId: 'native', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve({ result: native, isError: false });
    assert.strictEqual((await h.runtime.wait(view.task.id, 1000)).result, native);
    assert.equal(h.records.get(view.task.id)!.completion!.text, `${text}\ntail`);
    await h.runtime.close();
    const restored = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
    try {
      const result = restored.result(view.task.id.slice(3));
      assert.equal(result.task.command, command);
      assert.deepEqual(result.result!.content, [{ type: 'text', text: `${text}\ntail` }]);
      assert.equal(result.result!.structuredContent, undefined);
      assert.equal(result.task.outputPath, undefined); assert.deepEqual(readdirSync(h.root), []);
    } finally { await restored.close(); }
  } finally { work.resolve(ok()); await h.close(); }
});

test('native paths and exit codes survive recovery; pruning never deletes Pi files for either kind', async () => {
  const h = runtimeHarness({ maxRetained: 1 });
  const path = join(h.root, 'pi-native.log'); writeFileSync(path, 'native');
  try {
    for (const kind of ['bash', 'tool'] as const) {
      const work = deferred<Outcome>();
      const handle = await h.runtime.run({ tool: kind, kind, callId: kind, mode: 'yes', canDetach: true, execute: () => work.promise });
      work.resolve({ result: { content: [{ type: 'text', text: 'native' }],
        details: { fullOutputPath: kind === 'bash' ? '/unused-fallback' : path },
        structuredContent: kind === 'bash' ? { exit_code: 7, full_output_path: path } : { native: true } }, isError: true });
      await until(() => TaskRuntime.liveProducerCount() === 0);
      const restored = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
      try {
        const result = restored.result(handle.task.id);
        assert.equal(result.task.outputPath, path); assert.equal(result.task.exitCode, kind === 'bash' ? 7 : undefined);
        assert.equal(result.task.state, 'failed');
      } finally { await restored.close(); }
      h.runtime.published(kind); h.runtime.result(handle.task.id);
      const next = deferred<Outcome>();
      const other = await h.runtime.run({ tool: kind, kind, callId: 'small', mode: 'yes', canDetach: true, execute: () => next.promise });
      next.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
      h.runtime.published('small'); h.runtime.result(other.task.id);
      assert.throws(() => h.runtime.get(handle.task.id), /No task/);
      assert.equal(readFileSync(path, 'utf8'), 'native');
      assert.deepEqual(readdirSync(h.root), ['pi-native.log']);
    }
  } finally { await h.close(); }
});
test('UTF-8 truncation for presentation budgets never creates a partial codepoint', () => {
  for (let n = 0; n <= 12; n++) assert.ok(!truncateUtf8('你🙂a世界', n).includes('\uFFFD'));
});
