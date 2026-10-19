import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { TaskRuntime } from '../src/runtime.ts';
import type { Outcome, Result } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, basicTool, fixtureBash } from './host.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';

test('final native Outcome flag wins in both directions without rewriting its payload', async () => {
  const h = runtimeHarness();
  try {
    for (const finalError of [false, true]) {
      const original: Result = { content: [{ type: 'text', text: 'native payload' }], details: { hook: 'retained' },
        structuredContent: { exact: [1, 'two'] }, isError: !finalError };
      const view = await h.runtime.run({ tool: 'hooked', kind: 'tool', callId: `c-${finalError}`, mode: 'no', canDetach: true,
        execute: async () => ({ result: original, isError: finalError }) });
      assert.equal(view.kind, 'result'); if (view.kind !== 'result') throw new Error('Expected result');
      assert.equal(view.task.isError, finalError);
      assert.equal(view.task.state, finalError ? 'failed' : 'completed');
      assert.deepEqual(view.result, original);
      assert.equal(view.task.outputPath, undefined);
    }
  } finally { await h.close(); }
});

test('cancelRequested is a fact, never a classifier for a returned native outcome', async () => {
  const h = runtimeHarness();
  try {
    for (const kind of ['tool', 'bash'] as const) for (const isError of [true, false]) {
      const work = deferred<Outcome>(); let aborts = 0;
      const view = await h.runtime.run({ tool: 'one', kind, callId: `${kind}-${isError}`, mode: 'yes', canDetach: true,
        execute: signal => { signal.addEventListener('abort', () => { aborts++; }); return work.promise; } });
      const cancelled = h.runtime.cancel(view.task.id); h.runtime.cancel(view.task.id);
      assert.equal(cancelled.state, 'cancel_requested'); assert.equal(aborts, 1);
      const native: Result = { content: [{ type: 'text', text: isError ? 'MCP request aborted' : 'native late success' }], details: {} };
      work.resolve({ result: native, isError });
      await until(() => !h.runtime.get(view.task.id).localRunning);
      const final = h.runtime.result(view.task.id);
      assert.equal(final.task.state, isError ? 'failed' : 'completed');
      assert.equal(final.task.isError, isError);
      assert.equal(final.task.cancelRequestedAt, cancelled.cancelRequestedAt);
      assert.deepEqual(final.result, native);
      assert.equal(h.runtime.cancel(view.task.id).state, final.task.state);
    }
  } finally { await h.close(); }
});

test('foreground parent cancellation preserves its AbortSignal reason', async () => {
  const h = runtimeHarness({ autoDetachMs: 0 }); const parent = new AbortController(); const reason = new Error('caller cancellation reason');
  let seen: unknown;
  try {
    const wait = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c', mode: 'no', canDetach: true, parentSignal: parent.signal,
      execute: signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { seen = signal.reason; reject(signal.reason); })) });
    await sleep(1); parent.abort(reason); const view = await wait;
    assert.equal(seen, reason); assert.equal(view.task.state, 'failed');
    assert.equal(view.task.isError, true);
  } finally { await h.close(); }
});

async function commandHarness() {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-command-')); const pi = new FakePi('A', 'rpc');
  const work = deferred<Outcome>(); let aborts = 0;
  pi.registerTool(basicTool('mcp__test__one', async (_id, _args, signal) => {
    signal?.addEventListener('abort', () => { aborts++; }); return (await work.promise).result;
  }));
  const instance = install(pi, { config: validateConfig({ storageRoot: root, autoDetachMs: 0, shutdownGraceMs: 10 }), makeBash: fixtureBash });
  await pi.emit('session_start', { type: 'session_start' }); await sleep(1); pi.refresh();
  assert.equal(pi.commands.get('bg'), pi.commands.get('meantime'));
  const command = (args: string) => pi.commands.get('meantime')!(args, pi.ctx);
  return { pi, work, command, aborts: () => aborts, async close() { work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await instance.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('/bg cancel requires one explicit id and never guesses among current session tasks', async () => {
  const h = await commandHarness();
  try {
    const a = await h.pi.call('mcp__test__one_mt', { __meantime__: 'yes' });
    const b = await h.pi.call('mcp__test__one_mt', { __meantime__: 'yes' });
    const idA = (a.result.details as Snapshot).id, idB = (b.result.details as Snapshot).id;
    const handleText = a.result.content[0]; assert.ok(handleText?.type === 'text');
    assert.match(handleText.text, /In the TUI use \/meantime or \/meantime cancel/);
    await h.command(''); assert.match(h.pi.uiMessages.at(-1)!, /Current session tasks 2:/);
    assert.ok(h.pi.uiMessages.at(-1)!.includes(idA)); assert.ok(!h.pi.uiMessages.at(-1)!.includes('producerId'));
    assert.equal(h.pi.uiWidgets.size, 1); assert.equal(h.pi.notifications.length, 0);
    await h.command('detach'); assert.match(h.pi.uiMessages.at(-1)!, /Detached 0 managed call/);
    await h.command('status'); assert.match(h.pi.uiMessages.at(-1)!, /Use \/meantime \[detach\|rescan\|cancel <id>\]/);
    await h.command('cancel');
    assert.match(h.pi.uiMessages.at(-1)!, /Usage: \/meantime cancel <id>.*No task was cancelled/s);
    assert.ok(h.pi.uiMessages.at(-1)!.includes(idA)); assert.ok(h.pi.uiMessages.at(-1)!.includes(idB)); assert.equal(h.aborts(), 0);
    await h.command(`cancel ${idA} ${idB}`); assert.equal(h.aborts(), 0);
    await h.command('cancel mt_00000000');
    assert.match(h.pi.uiMessages.at(-1)!, /No task with that id in this session/); assert.equal(h.aborts(), 0);
    await h.command(`cancel ${idA}`); await h.command(`cancel ${idA}`); assert.equal(h.aborts(), 1);
    const listed = await h.pi.call('meantime', { action: 'wait', timeout: 0, id: idB });
    assert.equal((listed.result.details as Snapshot).state, 'running');
  } finally { await h.close(); }
});

test('/bg cancel rejects an old session id and does not cancel a different task', async () => {
  const h = await commandHarness();
  try {
    const a = await h.pi.call('mcp__test__one_mt', { __meantime__: 'yes' }); const id = (a.result.details as Snapshot).id;
    await h.command(''); assert.equal(h.pi.uiWidgets.size, 1);
    await h.pi.emit('session_shutdown', { type: 'session_shutdown' });
    assert.equal(h.pi.uiWidgets.size, 0);
    h.pi.ctx = { ...h.pi.ctx, sessionManager: { getSessionId: () => 'B', getSessionFile: () => '/sessions/B.jsonl', getEntries: () => [] } };
    await h.pi.emit('session_start', { type: 'session_start' });
    const b = await h.pi.call('mcp__test__one_mt', { __meantime__: 'yes' }); const idB = (b.result.details as Snapshot).id; const before = h.aborts();
    await h.command(`cancel ${id}`); assert.equal(h.aborts(), before);
    const statusB = await h.pi.call('meantime', { action: 'wait', timeout: 0, id: idB });
    assert.equal((statusB.result.details as Snapshot).state, 'running');
    assert.match(h.pi.uiMessages.at(-1)!, /No task with that id in this session/);
    await h.command('cancel'); assert.ok(h.pi.uiMessages.at(-1)!.includes(idB)); assert.ok(!h.pi.uiMessages.at(-1)!.includes(id));
  } finally { await h.close(); }
});


test('permission denial settles before pending detach resumes after ui_prompt_end', async () => {
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'guarded', mode: 'yes', canDetach: true, execute: () => work.promise });
    await sleep(5); h.runtime.prompt(false);
    assert.equal(h.runtime.detachAll('steer'), 0, 'steer must not overtake the approval continuation');
    await Promise.resolve();
    work.resolve({ result: { content: [{ type: 'text', text: 'Permission denied' }], details: {} }, isError: true });
    const view = await waiting;
    assert.equal(view.kind, 'result'); assert.equal(view.task.state, 'failed');
    assert.equal(view.task.delivery, 'foreground'); assert.equal(view.task.isError, true);
  } finally { work.resolve(ok()); await h.close(); }
});


test('recovery retains the authoritative outcome flag with text-only results', async () => {
  const h = runtimeHarness();
  try {
    for (const isError of [false, true]) {
      const payload: Result = { content: [{ type: 'text', text: 'hooked' }], details: {}, isError: !isError };
      const work = deferred<Outcome>();
      const view = await h.runtime.run({ tool: 'hooked', kind: 'tool', callId: `r-${isError}`, mode: 'yes', canDetach: true,
        execute: () => work.promise });
      work.resolve({ result: payload, isError }); await until(() => TaskRuntime.liveProducerCount() === 0);
      const recovered = new TaskRuntime(h.store, h.config, { ...h.sink, notify() { throw new Error('must not notify'); } }, [...h.records.values()]);
      try {
        const restored = recovered.result(view.task.id);
        assert.equal(restored.task.isError, isError); assert.deepEqual(restored.result!.content, payload.content);
        assert.equal(restored.result!.structuredContent, undefined);
        assert.equal(recovered.cancel(view.task.id).state, isError ? 'failed' : 'completed');
      } finally { await recovered.close(); }
    }
  } finally { await h.close(); }
});

test('/bg cancel of an already completed task is visibly idempotent', async () => {
  const h = await commandHarness();
  try {
    const outcome = await h.pi.call('mcp__test__one_mt', { __meantime__: 'yes' }); const id = (outcome.result.details as Snapshot).id;
    h.work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    await h.command(`cancel ${id}`); await h.command(`cancel ${id}`);
    assert.equal(h.aborts(), 0); assert.match(h.pi.uiMessages.at(-1)!, /completed.*No running local call was cancelled/);
  } finally { await h.close(); }
});
