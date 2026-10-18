import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { TaskRuntime } from '../src/runtime.ts';
import type { Snapshot } from '../src/runtime.ts';
import { install } from '../src/extension.ts';
import { FakePi, basicTool, fixtureBash } from './host.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

const run = (runtime: TaskRuntime, callId: string, work: Promise<Outcome>) => runtime.run({
  tool: 'noncooperative', kind: 'tool', callId, mode: 'yes', canDetach: true, execute: () => work,
});

test('recovery observes late completion without replay, stale notifications, or lifecycle writes', async () => {
  const h = runtimeHarness({ maxRunning: 1 }); const work = deferred<Outcome>();
  const view = await run(h.runtime, 'late', work.promise); h.runtime.published('late'); await h.runtime.close();
  const restored = new TaskRuntime(h.store, h.config, { ...h.sink, notify() { assert.fail('stale notification'); } }, [...h.records.values()]);
  try {
    assert.equal(restored.get(view.task.id).state, 'outcome_unknown');
    assert.equal(restored.result(view.task.id).result, undefined);
    assert.throws(() => restored.cancel(view.task.id), /no live local controller/);
    assert.throws(() => run(restored, 'other', Promise.resolve(ok())), /capacity/);
    work.resolve(ok('LATE_RESULT')); await until(() => TaskRuntime.liveProducerCount() === 0);
    const result = restored.result(view.task.id.slice(3));
    assert.equal(result.task.state, 'completed'); assert.equal(result.task.recovered, true);
    assert.deepEqual(result.result, JSON.parse(JSON.stringify(ok('LATE_RESULT').result)));
    const before = readFileSync(result.task.resultPath!, 'utf8');
    restored.flushNotifications(); await restored.close();
    assert.equal(readFileSync(result.task.resultPath!, 'utf8'), before);
    assert.equal(h.notifications.length, 0);
    assert.equal(readdirSync(h.store.directory).length, 1);
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
    assert.equal(existsSync(h.store.directory), false);
    cancelled.resolve(ok()); closing.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(readdirSync(h.store.directory).length, 2);
    assert.equal(h.records.size, 2);
  } finally { cancelled.resolve(ok()); closing.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await h.close(); }
});

test('failed index append keeps normal detach in the foreground without an uncaught timer error', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const runtime = new TaskRuntime(h.store, h.config, { notify() {}, index() { throw new Error('disk full'); } });
  try {
    const wait = run(runtime, 'one', work.promise);
    await sleep(5); assert.equal(runtime.list()[0]!.delivery, 'foreground');
    assert.match(runtime.list()[0]!.storageError!, /disk full/);
    work.resolve(ok()); assert.equal((await wait).kind, 'result');
    assert.equal(existsSync(h.store.directory), false);
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});

test('retention protects pending notifications and removes both the result and its session index', async () => {
  const h = runtimeHarness({ maxRetained: 1, notifyDebounceMs: 5000 });
  const jobs = [deferred<Outcome>(), deferred<Outcome>()];
  try {
    const handles: Awaited<ReturnType<typeof run>>[] = [];
    for (let i = 0; i < jobs.length; i++) { handles.push(await run(h.runtime, `c${i}`, jobs[i]!.promise)); h.runtime.published(`c${i}`); }
    h.runtime.prompt(true);
    for (const work of jobs) { work.resolve(ok()); await sleep(2); }
    await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.list().length, 2); assert.equal(h.records.size, 2);
    h.runtime.prompt(false); await new Promise<void>(resolve => setImmediate(resolve)); h.runtime.flushNotifications();
    assert.equal(h.notifications.flat().length, 2); assert.equal(h.records.size, 1);
    assert.equal(readdirSync(h.store.directory).length, 1);
    await h.runtime.close();
    const restored = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
    try {
      assert.equal(restored.list().length, 1);
      assert.throws(() => restored.get(handles[0]!.task.id), /No task/);
      assert.ok(restored.result(handles[1]!.task.id).result);
    } finally { await restored.close(); }
  } finally { jobs.forEach(w => w.resolve(ok())); await h.close(); }
});

test('retention deletion failure remains discoverable after restore and can be retried', async () => {
  const h = runtimeHarness({ maxRetained: 1 });
  const remove = h.store.remove.bind(h.store);
  h.store.remove = () => { throw new Error('EACCES'); };
  let restored: TaskRuntime | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const work = deferred<Outcome>();
      const handle = await run(h.runtime, `delete${i}`, work.promise);
      h.runtime.published(`delete${i}`);
      work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
      h.runtime.result(handle.task.id);
    }
    assert.equal(h.records.size, 2);
    assert.ok(h.runtime.list().some(task => task.storageError?.includes('EACCES')));
    await h.runtime.close();
    restored = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
    assert.equal(restored.list().length, 2);
    h.store.remove = remove;
    assert.equal(restored.list().length, 1);
    assert.equal(h.records.size, 1);
    assert.equal(readdirSync(h.store.directory).length, 1);
  } finally { h.store.remove = remove; await restored?.close(); await h.close(); }
});

test('Pi session index survives tree navigation and resume, but a fork cannot adopt its tasks', async () => {
  const h = runtimeHarness(); const pi = new FakePi('A'); const work = deferred<Outcome>(); let executions = 0;
  pi.registerTool(basicTool('mcp__test__late', async () => { executions++; return (await work.promise).result; }));
  const instance = install(pi, { config: h.config, makeBash: fixtureBash });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const handle = await pi.call('mcp__test__late_mt', { __meantime__: 'yes' });
    const id = (handle.result.details as Snapshot).id, originalCtx = pi.ctx;
    assert.equal(pi.entries.length, 1);
    await pi.emit('session_tree', { type: 'session_tree' });
    const active = await pi.call('meantime', { action: 'status', id });
    assert.equal((active.result.details as Snapshot).state, 'running');
    await pi.emit('session_shutdown', { type: 'session_shutdown' });
    // A fork copies entries but uses another owner. Late completion must not
    // append entries or notifications to the new session.
    pi.ctx = { ...pi.ctx, sessionManager: { getSessionId: () => 'B', getSessionFile: () => '/sessions/B.jsonl', getEntries: () => [...pi.entries] } };
    await pi.emit('session_start', { type: 'session_start' });
    assert.equal((await pi.call('meantime', { action: 'status', id })).isError, true);
    const entriesBefore = pi.entries.length;
    work.resolve(ok('LATE_OWNER_A')); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(pi.entries.length, entriesBefore); assert.equal(pi.notifications.length, 0);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }); pi.ctx = originalCtx;
    await pi.emit('session_start', { type: 'session_start' });
    const result = await pi.call('meantime', { action: 'result', id: id.slice(3) });
    assert.equal(result.isError, false); assert.match(JSON.stringify(result.result.content), /LATE_OWNER_A/);
    assert.equal(executions, 1); assert.equal(pi.notifications.length, 0);
  } finally { work.resolve(ok()); await instance.dispose(); await h.close(); }
});
