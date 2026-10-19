import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { TaskRuntime } from '../src/runtime.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

// Every async test owns and drains its producers, making leak assertions meaningful.
test('fast foreground result completes without a completion notification', async () => {
  const h = runtimeHarness();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: async () => ok() });
    assert.equal(view.kind, 'result'); assert.equal(view.task.state, 'completed');
    h.runtime.published('c1'); await sleep(15); assert.equal(h.notifications.length, 0);
    assert.equal(view.task.outputPath, undefined); assert.equal(existsSync(h.store.directory), false);
    assert.equal(h.records.size, 0); assert.equal(h.runtime.list().length, 0);
  } finally { await h.close(); }
});
test('explicit background returns before producer, notification waits for finalized parent result', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'slow', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    assert.equal(view.kind, 'handle'); assert.equal(view.task.state, 'running');
    work.resolve(ok()); await until(() => h.runtime.get(view.task.id).state === 'completed');
    await sleep(10); assert.equal(h.notifications.length, 0);
    h.runtime.published('c1'); await until(() => h.notifications.length === 1);
    h.runtime.published('c1'); h.runtime.flushNotifications(); assert.equal(h.notifications.length, 1);
  } finally { work.resolve(ok()); await h.close(); }
});
test('auto timeout detaches, never aborts the producer', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>(); let signal: AbortSignal | undefined;
  try {
    const view = await h.runtime.run({ tool: 'long', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: s => { signal = s; return work.promise; } });
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'timeout'); assert.equal(signal!.aborted, false);
  } finally { work.resolve(ok()); await h.close(); }
});
test('steer and shortcut share the detach transition, later parent abort is disconnected', async () => {
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>(); const parent = new AbortController(); let signal: AbortSignal | undefined;
  try {
    const wait = h.runtime.run({ tool: 'long', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, parentSignal: parent.signal, execute: s => { signal = s; return work.promise; } });
    await sleep(1); assert.equal(h.runtime.detachAll('steer'), 1); assert.equal(h.runtime.detachAll('shortcut'), 0);
    const view = await wait; parent.abort(); assert.equal(signal!.aborted, false); assert.equal(view.task.detachReason, 'steer');
  } finally { work.resolve(ok()); await h.close(); }
});
test('no mode disables timed detachment but remains cancellable', async () => {
  const h = runtimeHarness(); let aborted = false;
  try {
    const wait = h.runtime.run({ tool: 'strict', kind: 'tool', callId: 'c1', mode: 'no', canDetach: true,
      execute: signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }) });
    await sleep(h.config.autoDetachMs + 10);
    assert.equal(h.runtime.detachAll('timeout'), 0);
    assert.equal(h.runtime.list()[0]!.delivery, 'foreground'); assert.equal(h.records.size, 0);
    const id = h.runtime.list()[0]!.id; h.runtime.cancel(id); const view = await wait;
    assert.equal(aborted, true); assert.equal(view.task.state, 'failed'); assert.equal(view.task.isError, true);
  } finally { await h.close(); }
});
test('no-mode user detachment waits for approval and nested-call readiness', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>(); let ready = false;
  try {
    h.runtime.prompt(true);
    const wait = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'c1', mode: 'no', canDetach: true,
      readyToDetach: () => ready, execute: () => work.promise });
    assert.equal(h.runtime.detachAll('steer'), 0);
    h.runtime.prompt(false); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.runtime.list()[0]!.delivery, 'foreground'); assert.equal(h.records.size, 0);
    ready = true; h.runtime.ready('c1'); const view = await wait;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'steer'); assert.equal(h.records.size, 1);
  } finally { work.resolve(ok()); await h.close(); }
});
test('approval gate defers detach until prompt closes', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    await sleep(10); assert.equal(h.runtime.list()[0]!.delivery, 'foreground');
    h.runtime.prompt(false); assert.equal((await waiting).kind, 'handle');
  } finally { work.resolve(ok()); await h.close(); }
});
test('queued nested call does not detach before host attributes the original invocation', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>(); let ready = false;
  try {
    const wait = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, readyToDetach: () => ready, execute: () => work.promise });
    await sleep(10); assert.equal(h.runtime.list()[0]!.delivery, 'foreground');
    ready = true; h.runtime.ready('c1'); assert.equal((await wait).kind, 'handle');
  } finally { work.resolve(ok()); await h.close(); }
});
test('reading result acknowledges completion and prevents duplicate notification', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve(ok()); await until(() => h.runtime.get(view.task.id).state === 'completed');
    assert.ok(h.runtime.result(view.task.id).result); h.runtime.published('c1'); await sleep(15);
    assert.equal(h.notifications.length, 0);
  } finally { work.resolve(ok()); await h.close(); }
});
test('notification enqueue failure is retried; it is not falsely marked delivered', async () => {
  const h = runtimeHarness(); await h.runtime.close(); let sends = 0;
  const runtime = new TaskRuntime(h.store, h.config, { ...h.sink, notify() { if (++sends < 2) throw new Error('busy'); } });
  const work = deferred<Outcome>();
  try {
    const view = await runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    runtime.published('c1'); work.resolve(ok()); await until(() => runtime.get(view.task.id).notification === 'queued');
    assert.equal(sends, 2);
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});
test('capacity counts actual live producers, not foreground waiters', async () => {
  const h = runtimeHarness({ maxRunning: 1 }); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    h.runtime.cancel(view.task.id);
    assert.equal(h.runtime.get(view.task.id).state, 'cancel_requested');
    assert.throws(() => h.runtime.run({ tool: 'two', kind: 'tool', callId: 'c2', mode: 'yes', canDetach: true, execute: async () => ok() }), /capacity/);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.get(view.task.id).state, 'completed'); // A late success is truth, even after cancel.
  } finally { work.resolve(ok()); await h.close(); }
});
test('non-cooperative producer survives local cancel; shutdown is bounded and no late notification leaks', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'remote', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    h.runtime.published('c1'); await h.runtime.close();
    assert.equal(h.runtime.get(view.task.id).state, 'outcome_unknown');
    assert.equal(h.runtime.get(view.task.id).localRunning, true);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); assert.equal(h.notifications.length, 0);
  } finally { work.resolve(ok()); await h.close(); }
});
test('recovery never replays unfinished work or generates stale notifications', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const view = await h.runtime.run({ tool: 'remote', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
  await h.runtime.close();
  const other = new TaskRuntime(h.store, h.config, { ...h.sink, notify() { throw new Error('must not notify'); } }, [...h.records.values()]);
  try {
    const restored = other.get(view.task.id); assert.equal(restored.state, 'outcome_unknown'); assert.equal(restored.recovered, true);
    assert.throws(() => other.cancel(restored.id), /no live local controller/);
  } finally { work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); await other.close(); await h.close(); }
});
test('pre-aborted calls and print-mode explicit background never execute', async () => {
  const h = runtimeHarness(); let calls = 0; const ctrl = new AbortController(); ctrl.abort();
  try {
    const request = { tool: 'one', kind: 'tool' as const, callId: 'c1', mode: 'yes' as const, canDetach: true, execute: async () => { calls++; return ok(); } };
    assert.throws(() => h.runtime.run({ ...request, parentSignal: ctrl.signal }), /cancelled before/);
    assert.throws(() => h.runtime.run({ ...request, canDetach: false }), /unavailable/); assert.equal(calls, 0);
  } finally { await h.close(); }
});
test('no-mode user triggers cannot bypass print/json detach admission', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const wait = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'print', mode: 'no', canDetach: false, execute: () => work.promise });
    assert.equal(h.runtime.detachAll('steer'), 0); assert.equal(h.runtime.detachAll('shortcut'), 0);
    work.resolve(ok()); assert.equal((await wait).kind, 'result'); assert.equal(h.records.size, 0);
  } finally { work.resolve(ok()); await h.close(); }
});
test('progress stops being sent to the old foreground callback after detach', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>(); let update: ((r: ReturnType<typeof ok>['result']) => void) | undefined; const visible: string[] = [];
  try {
    const wait = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true,
      onUpdate: r => visible.push(r.content[0]!.type), execute: (_s, u) => { update = u; return work.promise; } });
    await sleep(1); update!(ok('first').result); h.runtime.detachAll('shortcut'); const view = await wait;
    update!(ok('second').result); assert.equal(visible.length, 1); assert.equal(h.runtime.get(view.task.id).progress, 'second');
  } finally { work.resolve(ok()); await h.close(); }
});

test('a rejected or malformed producer produces a settled error, never an unhandled rejection or hanging waiter', async () => {
  const h = runtimeHarness();
  try {
    for (const execute of [async () => { throw new Error('rejected'); }, async () => ({ result: { content: [null] }, isError: false } as unknown as Outcome)]) {
      const view = await h.runtime.run({ tool: 'broken', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute });
      assert.equal(view.kind, 'result'); assert.equal(view.task.state, 'failed');
    }
  } finally { await h.close(); }
});
test('late tool usage stays in the task ledger without inventing foreground usage', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'metered', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const result = ok(); result.result.usage = usage; work.resolve(result);
    await until(() => h.runtime.get(view.task.id).state === 'completed');
    assert.deepEqual(h.runtime.result(view.task.id).result!.usage, usage);
  } finally { work.resolve(ok()); await h.close(); }
});
test('quota is retained across runtime shutdown until non-cooperative producers actually settle', async () => {
  const h = runtimeHarness({ maxRunning: 1 }); const work = deferred<Outcome>();
  await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
  await h.runtime.close(); const next = new TaskRuntime(h.store, h.config, h.sink, [...h.records.values()]);
  try {
    assert.throws(() => next.run({ tool: 'next', kind: 'tool', callId: 'c2', mode: 'yes', canDetach: true, execute: async () => ok() }), /capacity/);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal((await next.run({ tool: 'next', kind: 'tool', callId: 'c3', mode: 'auto', canDetach: true, execute: async () => ok() })).kind, 'result');
  } finally { work.resolve(ok()); await next.close(); await h.close(); }
});
test('terminal retention is bounded and oversized text keeps only its preview in memory', async () => {
  const h = runtimeHarness({ maxRetained: 2 });
  try {
    for (let i = 0; i < 5; i++) {
      const work = deferred<Outcome>();
      const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: `c${i}`, mode: 'yes', canDetach: true, execute: () => work.promise });
      h.runtime.published(`c${i}`); work.resolve(ok('x'.repeat(100_000)));
      await until(() => !h.runtime.get(view.task.id).localRunning);
      h.runtime.result(view.task.id);
    }
    assert.equal(h.runtime.list().length, 2);
    for (const task of h.runtime.tasks.values()) assert.ok(task.result!.content[0]!.type === 'text' && task.result!.content[0]!.text.length <= 2000);
  } finally { await h.close(); }
});

test('a finalized result with a reused call ID but another task UUID cannot release notification', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'reused', mode: 'yes', canDetach: true, execute: () => work.promise });
    work.resolve(ok()); await until(() => h.runtime.get(view.task.id).state === 'completed');
    h.runtime.published('reused', 'mt_0000000f'); await sleep(10);
    assert.equal(h.notifications.length, 0);
    h.runtime.published('reused', view.task.id); await until(() => h.notifications.length === 1);
  } finally { work.resolve(ok()); await h.close(); }
});

test('a long-running task finishing last keeps its result even when newer-created tasks filled retention', async () => {
  const h = runtimeHarness({ maxRetained: 1 }); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'old-long', kind: 'tool', callId: 'long', mode: 'yes', canDetach: true, execute: () => work.promise });
    for (let i = 0; i < 3; i++) {
      const short = deferred<Outcome>();
      const handle = await h.runtime.run({ tool: 'new-short', kind: 'tool', callId: `short${i}`, mode: 'yes', canDetach: true, execute: () => short.promise });
      h.runtime.published(`short${i}`); short.resolve(ok());
      await until(() => !h.runtime.get(handle.task.id).localRunning); h.runtime.result(handle.task.id);
    }
    work.resolve(ok('late result'));
    h.runtime.published('long');
    await until(() => !h.runtime.get(view.task.id).localRunning);
    assert.match(JSON.stringify(h.runtime.result(view.task.id).result), /late result/);
    assert.equal(h.runtime.list().length, 1); assert.equal(h.runtime.list()[0]!.tool, 'old-long');
  } finally { work.resolve(ok()); await h.close(); }
});
test('wait handles timeouts, cancellation and long waits without cancelling the producer', async (t) => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'slow', kind: 'tool', callId: 'w1', mode: 'yes', canDetach: true, execute: () => work.promise });
    assert.match(view.task.id, /^mt_[a-f0-9]{8}$/);
    const early = await h.runtime.wait(view.task.id, 10);
    assert.equal(early.result, undefined); assert.equal(early.task.state, 'running');
    const aborted = new AbortController(); aborted.abort(new Error('stop waiting'));
    await assert.rejects(h.runtime.wait(view.task.id, 5000, aborted.signal), /stop waiting/);
    const controller = new AbortController();
    const cancelledWait = h.runtime.wait(view.task.id, 5000, controller.signal);
    controller.abort(new Error('stop waiting'));
    await assert.rejects(cancelledWait, /stop waiting/);
    assert.equal(h.runtime.get(view.task.id).state, 'running');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const pending = h.runtime.wait(view.task.id.slice(3, 7), 2_147_483_647 + 5000).then(value => { settled = true; return value; });
    t.mock.timers.tick(2_147_483_647);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the first timer chunk must not end the wait');
    t.mock.timers.reset();
    work.resolve(ok('waited'));
    const done = await pending;
    assert.equal(done.task.state, 'completed'); assert.match(JSON.stringify(done.result), /waited/);
  } finally { work.resolve(ok()); await h.close(); }
});
