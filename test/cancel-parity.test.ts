import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { TaskRuntime } from '../src/runtime.ts';
import type { Outcome, Result } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, basicTool } from './host.ts';
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

test('cancelled lifecycle state preserves either native outcome without claiming rollback', async () => {
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
      assert.equal(final.task.state, 'cancelled');
      assert.equal(final.task.isError, isError);
      assert.equal(final.task.cancelRequestedAt, cancelled.cancelRequestedAt);
      assert.deepEqual(final.result, native);
      assert.equal(h.runtime.cancel(view.task.id).state, final.task.state);
      const restored = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
      try { assert.equal(restored.get(view.task.id).state, 'cancelled'); }
      finally { await restored.close(); }
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
    assert.equal(seen, reason); assert.equal(view.task.state, 'cancelled');
    assert.equal(view.task.isError, true);
  } finally { await h.close(); }
});

test('model cancellation observes settlement before even a synchronous notification flush', async () => {
  const h = runtimeHarness({ shutdownGraceMs: 100, notifyDebounceMs: 0 });
  h.sink.changed = () => h.runtime.flushNotifications();
  try {
    const native = ok('late native success');
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c', mode: 'yes', canDetach: true,
      execute: signal => new Promise(resolve => signal.addEventListener('abort', () => resolve(native))) });
    h.runtime.published('c');
    const final = await h.runtime.wait(view.task.id, h.config.shutdownGraceMs, undefined, true);
    assert.equal(final.task.state, 'cancelled');
    assert.equal(final.task.notification, 'observed');
    assert.equal(final.task.isError, false);
    assert.deepEqual(final.result, native.result);
    h.runtime.flushNotifications(); assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test('model cancellation can collect a still-foreground task without losing its native result', async () => {
  const h = runtimeHarness({ autoDetachMs: 0, shutdownGraceMs: 100 });
  try {
    const native = ok('foreground cancellation settled');
    const foreground = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c', mode: 'no', canDetach: true,
      execute: signal => new Promise(resolve => signal.addEventListener('abort', () => resolve(native))) });
    await sleep(1);
    const final = await h.runtime.wait(h.runtime.list()[0]!.id, h.config.shutdownGraceMs, undefined, true);
    assert.equal(final.task.state, 'cancelled'); assert.equal(final.task.notification, 'observed');
    assert.deepEqual(final.result, native.result);
    const original = await foreground;
    assert.equal(original.kind, 'result');
    if (original.kind === 'result') assert.deepEqual(original.result, native.result);
    h.runtime.flushNotifications(); assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test('cancel grace timeout and interrupted cancel wait both preserve a later notification', async () => {
  const h = runtimeHarness({ shutdownGraceMs: 10, notifyDebounceMs: 0 });
  try {
    for (const interrupt of [false, true]) {
      const work = deferred<Outcome>(); const caller = new AbortController();
      const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: `c-${interrupt}`, mode: 'yes', canDetach: true,
        execute: signal => {
          if (interrupt) signal.addEventListener('abort', () => caller.abort(new Error('stop observing')));
          return work.promise;
        } });
      h.runtime.published(`c-${interrupt}`);
      const cancelling = h.runtime.wait(view.task.id, h.config.shutdownGraceMs, caller.signal, true);
      if (interrupt) {
        await assert.rejects(cancelling, /stop observing/);
      } else {
        const pending = await cancelling;
        assert.equal(pending.task.state, 'cancel_requested');
        assert.equal(pending.result, undefined);
        assert.notEqual(pending.task.notification, 'observed');
      }
      assert.equal(h.notifications.flat().filter(t => t.id === view.task.id).length, 0);
      work.resolve(ok('finished later'));
      await until(() => h.notifications.flat().some(t => t.id === view.task.id));
      h.runtime.flushNotifications();
      const notices = h.notifications.flat().filter(t => t.id === view.task.id);
      assert.equal(notices.length, 1); assert.equal(notices[0]!.state, 'cancelled');
    }
  } finally { await h.close(); }
});

test('model cancel returns the single-wait stored result with native payload and no wakeup', async () => {
  const pi = new FakePi();
  const native: Result = { content: [{ type: 'text', text: 'native cancellation result' }],
    details: { fullOutputPath: '/tmp/native-output', extra: { retained: true } },
    structuredContent: { native: ['exact', 42] }, isError: true };
  pi.registerTool(basicTool('mcp__test__cancel', async (_id, _args, signal) => new Promise(resolve => {
    signal?.addEventListener('abort', () => resolve(native));
  })));
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 }), connect: () => pi });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const handle = await pi.call('mcp__test__cancel', { __background__: 'yes' });
    const id = (handle.result.details as Snapshot).id;
    const cancelled = await pi.call('meantime', { action: 'cancel', ids: [id] });
    const wait = await pi.call('meantime', { action: 'wait', ids: [id], timeout: 0 });
    assert.deepEqual(cancelled.result, wait.result);
    assert.deepEqual(cancelled.result.content.slice(1), native.content);
    assert.deepEqual(cancelled.result.details, { nativeDetails: native.details!, task: (wait.result.details as { task: Snapshot }).task });
    assert.deepEqual((cancelled.result.structuredContent as { result: unknown }).result, native.structuredContent);
    assert.equal(cancelled.isError, true);
    const task = (cancelled.result.details as { task: Snapshot }).task;
    assert.equal(task.state, 'cancelled'); assert.equal(task.notification, 'observed');
    await sleep(10); assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); }
});

test('real SDK: a script-created task is cancelled directly without a completion message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'meantime-codemode-cancel-'));
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['codemode', 'fixture', 'meantime'] });
  let instance: ReturnType<typeof install> | undefined;
  let session: sdk.AgentSession | undefined;
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [sdk.createCodemodeExtension(), pi => {
      pi.registerTool({ name: 'fixture', label: 'fixture', description: 'Cooperative cancellation fixture',
        parameters: { type: 'object', properties: {} },
        async execute(_id, _args, signal) {
          return new Promise<Result>(resolve => signal!.addEventListener('abort', () => resolve({
            content: [{ type: 'text', text: 'native settled result' }], details: { exact: true },
            structuredContent: { marker: 'CODEMODE_CANCELLED_NATIVE' },
          })));
        } });
      instance = install(pi, { config: validateConfig({ include: ['fixture'], autoDetachMs: 0,
        shutdownGraceMs: 100, notifyDebounceMs: 0 }) });
    }] });
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    const code = `return await tools.fixture({__background__: 'yes'});`;
    const manager = sdk.SessionManager.inMemory(root);
    // SDK nested dispatch requires a recorded assistant call as its parent.
    manager.appendMessage({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture',
      content: [{ type: 'toolCall', id: 'cancel-script', name: 'codemode', arguments: { code } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: Date.now() });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, modelRuntime,
      sessionManager: manager }));
    await session.bindExtensions({ mode: 'rpc' });
    session.setActiveToolsByName(['codemode', 'fixture', 'meantime']);
    const codemode = session.agent.state.tools.find(tool => tool.name === 'codemode')!;
    const script = await codemode.execute('cancel-script', { code }, new AbortController().signal);
    assert.notEqual(script.isError, true, JSON.stringify(script));
    const output = script.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const handle = JSON.parse(output.slice(output.indexOf('Output:\n') + 'Output:\n'.length));
    const control = session.agent.state.tools.find(tool => tool.name === 'meantime')!;
    const result = await control.execute('cancel-control', { action: 'cancel', ids: [handle.task.id] }, new AbortController().signal);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual((result.structuredContent as { result: unknown }).result, { marker: 'CODEMODE_CANCELLED_NATIVE' });
    assert.match(JSON.stringify(result.content), /cancelled/);
    const task = (instance!.inspect() as { tasks: Snapshot[] }).tasks[0]!;
    assert.equal(task.state, 'cancelled'); assert.equal(task.notification, 'observed');
    await sleep(10);
    assert.equal(session.messages.filter(message => message.role === 'custom' && message.customType === 'meantime-completion').length, 0);
  } finally {
    if (session) await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
    await instance?.dispose(); session?.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

async function commandHarness() {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-command-')); const pi = new FakePi('A', 'rpc');
  const work = deferred<Outcome>(); let aborts = 0;
  pi.registerTool(basicTool('mcp__test__one', async (_id, _args, signal) => {
    signal?.addEventListener('abort', () => { aborts++; }); return (await work.promise).result;
  }));
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, shutdownGraceMs: 10 }), connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' }); await sleep(1); pi.refresh();
  assert.equal(pi.commands.get('bg'), pi.commands.get('meantime'));
  const command = (args: string) => pi.commands.get('meantime')!(args, pi.ctx);
  return { pi, work, command, aborts: () => aborts, async close() { work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await instance.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('/bg cancel requires one explicit id and never guesses among current session tasks', async () => {
  const h = await commandHarness();
  try {
    const a = await h.pi.call('mcp__test__one', { __background__: 'yes' });
    const b = await h.pi.call('mcp__test__one', { __background__: 'yes' });
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
    const listed = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [idB ]});
    assert.equal((listed.result.details as Snapshot).state, 'running');
  } finally { await h.close(); }
});

test('TUI command cancellation leaves one cancelled completion for the model', async () => {
  const h = await commandHarness();
  try {
    const handle = await h.pi.call('mcp__test__one', { __background__: 'yes' });
    const id = (handle.result.details as Snapshot).id;
    await h.command(`cancel ${id}`);
    h.work.resolve(ok('native success after cancellation'));
    await until(() => h.pi.notifications.length === 1);
    assert.match(h.pi.notifications[0]!.content, new RegExp(`Meantime ${id} cancelled`));
    const list = await h.pi.call('meantime', { action: 'list' });
    assert.equal((list.result.details as { tasks: Snapshot[] }).tasks[0]!.state, 'cancelled');
    await sleep(10); assert.equal(h.pi.notifications.length, 1);
  } finally { await h.close(); }
});

test('/bg cancel rejects an old session id and does not cancel a different task', async () => {
  const h = await commandHarness();
  try {
    const a = await h.pi.call('mcp__test__one', { __background__: 'yes' }); const id = (a.result.details as Snapshot).id;
    await h.command(''); assert.equal(h.pi.uiWidgets.size, 1);
    await h.pi.emit('session_shutdown', { type: 'session_shutdown' });
    assert.equal(h.pi.uiWidgets.size, 0);
    h.pi.ctx = { ...h.pi.ctx, sessionManager: { getSessionId: () => 'B', getSessionFile: () => '/sessions/B.jsonl', getEntries: () => [] } };
    await h.pi.emit('session_start', { type: 'session_start' });
    const b = await h.pi.call('mcp__test__one', { __background__: 'yes' }); const idB = (b.result.details as Snapshot).id; const before = h.aborts();
    await h.command(`cancel ${id}`); assert.equal(h.aborts(), before);
    const statusB = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [idB ]});
    assert.equal((statusB.result.details as Snapshot).state, 'running');
    assert.match(h.pi.uiMessages.at(-1)!, /No task with that id in this session/);
    await h.command('cancel'); assert.ok(h.pi.uiMessages.at(-1)!.includes(idB)); assert.ok(!h.pi.uiMessages.at(-1)!.includes(id));
  } finally { await h.close(); }
});


test('permission denial settles before pending detach resumes after ui_prompt_end', async () => {
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'guarded', mode: 'no', canDetach: true, execute: () => work.promise });
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
      const recovered = new TaskRuntime(h.config, { ...h.sink, notify() { throw new Error('must not notify'); } }, [...h.records.values()]);
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
    const outcome = await h.pi.call('mcp__test__one', { __background__: 'yes' }); const id = (outcome.result.details as Snapshot).id;
    h.work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    await h.command(`cancel ${id}`); await h.command(`cancel ${id}`);
    assert.equal(h.aborts(), 0); assert.match(h.pi.uiMessages.at(-1)!, /completed.*No running local call was cancelled/);
  } finally { await h.close(); }
});

test('batch cancel validates every target before aborting any of them', async () => {
  const h = runtimeHarness({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 });
  const work = deferred<Outcome>(); const native = ok('settled after cancel'); let aborts = 0;
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'one', mode: 'yes', canDetach: true,
      execute: signal => { signal.addEventListener('abort', () => { aborts++; work.resolve(native); }); return work.promise; } });
    h.runtime.published('one');
    const before = h.runtime.get(view.task.id);
    await assert.rejects(h.runtime.cancelMany([view.task.id, 'mt_00000000'], h.config.shutdownGraceMs), /No task with that id/);
    assert.equal(aborts, 0);
    assert.deepEqual(h.runtime.get(view.task.id), before, 'an unknown sibling leaves no cancellation or state change');
    // A fully valid batch still cancels every target and reports the same per-task shape.
    const second = deferred<Outcome>();
    const other = await h.runtime.run({ tool: 'two', kind: 'tool', callId: 'two', mode: 'yes', canDetach: true,
      execute: signal => { signal.addEventListener('abort', () => second.resolve(ok('second settled'))); return second.promise; } });
    h.runtime.published('two');
    const batch = await h.runtime.cancelMany([view.task.id, other.task.id.slice(3), view.task.id], h.config.shutdownGraceMs);
    assert.equal(aborts, 1);
    assert.deepEqual(batch.tasks.map(pair => pair.task.id), [view.task.id, other.task.id], 'duplicates collapse, order follows the batch');
    assert.deepEqual(batch.tasks.map(pair => pair.task.state), ['cancelled', 'cancelled']);
    assert.deepEqual(batch.tasks.map(pair => pair.result?.structuredContent), [native.result.structuredContent, { value: 'second settled' }]);
    assert.deepEqual(batch.pending, []);
    assert.equal(h.runtime.get(view.task.id).notification, 'observed');
  } finally { work.resolve(ok()); await h.close(); }
});

test('batch cancel rejects an ambiguous prefix without aborting a valid sibling', async () => {
  const h = runtimeHarness({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 });
  const work = deferred<Outcome>(); let aborts = 0;
  // Recovery records share a prefix; resolving it would silently pick one.
  const runtime = new TaskRuntime(h.config, h.sink, [
    { id: 'mt_ab120000', tool: 'old', kind: 'tool', mode: 'yes', createdAt: 1 },
    { id: 'mt_ab120001', tool: 'old', kind: 'tool', mode: 'yes', createdAt: 2 }]);
  try {
    const view = await runtime.run({ tool: 'one', kind: 'tool', callId: 'one', mode: 'yes', canDetach: true,
      execute: signal => { signal.addEventListener('abort', () => { aborts++; work.resolve(ok('settled')); }); return work.promise; } });
    await assert.rejects(runtime.cancelMany(['ab12', view.task.id], h.config.shutdownGraceMs), /Ambiguous task id prefix ab12/);
    assert.equal(aborts, 0);
    assert.equal(runtime.get(view.task.id).state, 'running');
    const single = await runtime.cancelMany([view.task.id], h.config.shutdownGraceMs);
    assert.equal(aborts, 1);
    assert.deepEqual(single.tasks.map(pair => pair.task.state), ['cancelled']);
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});

test('batch cancel refuses a recovered outcome_unknown sibling before aborting the producer', async () => {
  const h = runtimeHarness({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 });
  const work = deferred<Outcome>(); let aborts = 0;
  // Unfinished recovery: retained record, no live local controller, no endedAt.
  const runtime = new TaskRuntime(h.config, h.sink, [{ id: 'mt_ab120002', tool: 'old', kind: 'tool', mode: 'yes', createdAt: 1 }]);
  const refused = /Recovered task has no live local controller/;
  try {
    const view = await runtime.run({ tool: 'one', kind: 'tool', callId: 'one', mode: 'yes', canDetach: true,
      execute: signal => { signal.addEventListener('abort', () => { aborts++; }); return work.promise; } });
    const before = runtime.get(view.task.id);
    assert.equal(runtime.get('ab120002').state, 'outcome_unknown');
    // Single-ID behavior is unchanged: same refusal, and no producer is touched.
    assert.throws(() => runtime.cancel('ab120002'), refused);
    await assert.rejects(runtime.cancelMany([view.task.id, 'ab120002'], h.config.shutdownGraceMs), refused);
    assert.equal(aborts, 0, 'the refusal lands before the first abort signal');
    assert.deepEqual(runtime.get(view.task.id), before, 'no abort, cancel request or state change on the valid producer');
    // The batch still cancels once the un-cancellable sibling is gone.
    const cancelled = await runtime.cancelMany([view.task.id], h.config.shutdownGraceMs);
    assert.equal(aborts, 1);
    assert.deepEqual(cancelled.tasks.map(pair => [pair.task.id, pair.task.state]), [[view.task.id, 'cancel_requested']]);
    assert.deepEqual(cancelled.pending.map(task => task.id), [view.task.id]);
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});

test('model batch cancel refuses an unknown id before cancelling valid producers', async () => {
  const pi = new FakePi('A', 'rpc');
  let aborts = 0;
  pi.registerTool(basicTool('mcp__test__batch', (_id, _args, signal) => new Promise<Result>(resolve => {
    signal?.addEventListener('abort', () => { aborts++; resolve(ok(`native settled ${aborts}`).result); });
  })));
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 }), connect: () => pi });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const first = await pi.call('mcp__test__batch', { __background__: 'yes' });
    const id = (first.result.details as Snapshot).id;
    const invalid = await pi.call('meantime', { action: 'cancel', ids: [id, 'mt_00000000'] });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.result.content), /No task with that id in this session/);
    assert.equal(aborts, 0);
    const running = await pi.call('meantime', { action: 'wait', ids: [id], timeout: 0 });
    assert.equal((running.result.details as Snapshot).state, 'running');
    const second = await pi.call('mcp__test__batch', { __background__: 'yes' });
    const other = (second.result.details as Snapshot).id;
    const batch = await pi.call('meantime', { action: 'cancel', ids: [id, other] });
    assert.notEqual(batch.isError, true);
    const page = batch.result.details as { tasks: Snapshot[]; pending: Snapshot[] };
    assert.deepEqual(page.tasks.map(task => [task.id, task.state]), [[id, 'cancelled'], [other, 'cancelled']]);
    assert.deepEqual(page.pending, []);
    assert.equal(aborts, 2);
    assert.match(JSON.stringify(batch.result.content), /native settled 1/);
    await sleep(10); assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); }
});
