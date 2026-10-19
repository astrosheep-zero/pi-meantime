import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../src/runtime.ts';
import type { Snapshot } from '../src/runtime.ts';
import { install } from '../src/extension.ts';
import { FakePi, basicTool } from './host.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

const run = (runtime: TaskRuntime, callId: string, work: Promise<Outcome>) => runtime.run({
  tool: 'noncooperative', kind: 'tool', callId, mode: 'yes', canDetach: true, execute: () => work,
});

test('late text cannot establish an outcome without a bound completion index', async () => {
  const h = runtimeHarness({ maxRunning: 1 }); const work = deferred<Outcome>();
  const view = await run(h.runtime, 'late', work.promise); h.runtime.published('late'); await h.runtime.close();
  const restored = new TaskRuntime(h.config, { ...h.sink, notify() { assert.fail('stale notification'); } }, [...h.records.values()]);
  try {
    assert.equal(restored.get(view.task.id).state, 'outcome_unknown');
    assert.equal(restored.result(view.task.id).result, undefined);
    assert.throws(() => restored.cancel(view.task.id), /no live local controller/);
    assert.throws(() => run(restored, 'other', Promise.resolve(ok())), /capacity/);
    work.resolve(ok('LATE_RESULT'.repeat(6000))); await until(() => TaskRuntime.liveProducerCount() === 0);
    const result = restored.result(view.task.id.slice(3));
    assert.equal(result.task.state, 'outcome_unknown'); assert.equal(result.task.recovered, true);
    assert.equal(result.result, undefined); assert.equal(result.task.outputPath, undefined);
    assert.equal(h.records.get(view.task.id)!.completion, undefined);
    restored.flushNotifications(); assert.equal(h.notifications.length, 0);
  } finally { work.resolve(ok()); await restored.close(); await h.close(); }
});

test('cancellation grace and shutdown both index an unfinished foreground handle once', async () => {
  const h = runtimeHarness({ autoDetachMs: 0 }); const cancelled = deferred<Outcome>(); const closing = deferred<Outcome>();
  try {
    const wait = h.runtime.run({ tool: 'cancel', kind: 'tool', callId: 'cancel', mode: 'no', canDetach: true, execute: () => cancelled.promise });
    await sleep(1); h.runtime.cancel(h.runtime.list()[0]!.id);
    const handle = await wait;
    assert.equal(handle.kind, 'handle'); assert.equal(h.records.size, 1);
    const shutdownWait = h.runtime.run({ tool: 'close', kind: 'tool', callId: 'close', mode: 'no', canDetach: true, execute: () => closing.promise });
    await sleep(1); // The producer has started before shutdown requests cancellation.
    await h.runtime.close(); const shutdownHandle = await shutdownWait;
    assert.equal(shutdownHandle.kind, 'handle'); assert.equal(h.records.size, 2);
    cancelled.resolve(ok()); closing.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.records.size, 2);
  } finally { cancelled.resolve(ok()); closing.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await h.close(); }
});

test('failed index append keeps normal detach in the foreground without an uncaught timer error', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const runtime = new TaskRuntime(h.config, { notify() {}, index() { throw new Error('disk full'); } });
  try {
    const wait = runtime.run({ tool: 'one', kind: 'tool', callId: 'one', mode: 'no', canDetach: true, execute: () => work.promise });
    assert.equal(runtime.detachAll('shortcut'), 0);
    await sleep(5); assert.equal(runtime.list()[0]!.delivery, 'foreground');
    assert.match(runtime.list()[0]!.indexError!, /disk full/);
    work.resolve(ok()); assert.equal((await wait).kind, 'result');
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});

test('completion index failure does not replace the native result; recovery remains unknown', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const runtime = new TaskRuntime(h.config, { ...h.sink, index(change) {
    if ('completion' in change) throw new Error('disk full');
    h.sink.index(change);
  } });
  try {
    const view = await run(runtime, 'one', work.promise);
    const native = ok('native result'); work.resolve(native);
    const collected = await runtime.wait(view.task.id, 1000);
    assert.strictEqual(collected.result, native.result);
    assert.equal(collected.task.state, 'completed'); assert.equal(collected.task.isError, false);
    assert.match(collected.task.indexError!, /Completion index.*disk full/);
    await runtime.close();
    const restored = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
    try { assert.equal(restored.result(view.task.id).task.state, 'outcome_unknown'); }
    finally { await restored.close(); }
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});

test('retention protects pending notifications and removes both the result and its session index', async () => {
  const h = runtimeHarness({ maxRetained: 1, notifyDebounceMs: 5000 });
  const jobs = [deferred<Outcome>(), deferred<Outcome>()];
  try {
    const handles: Awaited<ReturnType<typeof run>>[] = [];
    for (let i = 0; i < jobs.length; i++) { handles.push(await run(h.runtime, `c${i}`, jobs[i]!.promise)); h.runtime.published(`c${i}`); }
    h.runtime.prompt(true);
    for (const work of jobs) { work.resolve(ok('x'.repeat(60_000))); await sleep(2); }
    await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.list().length, 2); assert.equal(h.records.size, 2);
    h.runtime.prompt(false); await new Promise<void>(resolve => setImmediate(resolve)); h.runtime.flushNotifications();
    assert.equal(h.notifications.flat().length, 2); assert.equal(h.records.size, 1);
    await h.runtime.close();
    const restored = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
    try {
      assert.equal(restored.list().length, 1);
      assert.throws(() => restored.get(handles[0]!.task.id), /No task/);
      assert.ok(restored.result(handles[1]!.task.id).result);
    } finally { await restored.close(); }
  } finally { jobs.forEach(w => w.resolve(ok())); await h.close(); }
});

test('Pi session index survives tree navigation and resume, but a fork cannot adopt its tasks', async () => {
  const h = runtimeHarness(); const pi = new FakePi('A'); const work = deferred<Outcome>(); let executions = 0;
  pi.registerTool(basicTool('mcp__test__late', async () => { executions++; return (await work.promise).result; }));
  const instance = install(pi, { config: h.config, connect: () => pi });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const handle = await pi.call('mcp__test__late', { __background__: 'yes' });
    const id = (handle.result.details as Snapshot).id, originalCtx = pi.ctx;
    assert.equal(pi.entries.length, 1);
    await pi.emit('session_tree', { type: 'session_tree' });
    const active = await pi.call('meantime', { action: 'wait', timeout: 0, id });
    assert.equal((active.result.details as Snapshot).state, 'running');
    await pi.emit('session_shutdown', { type: 'session_shutdown' });
    // A fork copies entries but uses another owner. Late completion must not
    // append entries or notifications to the new session.
    pi.ctx = { ...pi.ctx, sessionManager: { getSessionId: () => 'B', getSessionFile: () => '/sessions/B.jsonl', getEntries: () => [...pi.entries] } };
    await pi.emit('session_start', { type: 'session_start' });
    assert.equal((await pi.call('meantime', { action: 'wait', timeout: 0, id })).isError, true);
    const entriesBefore = pi.entries.length;
    work.resolve(ok('LATE_OWNER_A')); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(pi.entries.length, entriesBefore); assert.equal(pi.notifications.length, 0);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }); pi.ctx = originalCtx;
    await pi.emit('session_start', { type: 'session_start' });
    const result = await pi.call('meantime', { action: 'wait', timeout: 0, id: id.slice(3) });
    assert.equal(result.isError, false); assert.match(JSON.stringify(result.result.content), /outcome_unknown/);
    assert.doesNotMatch(JSON.stringify(result.result.content), /LATE_OWNER_A/);
    assert.equal(executions, 1); assert.equal(pi.notifications.length, 0);
  } finally { work.resolve(ok()); await instance.dispose(); await h.close(); }
});
