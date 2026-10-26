import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../src/runtime.ts';
import { projectResult } from '../src/schema.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

function steerClock(t: TestContext) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { tick(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}

test('persistent projection omits non-JSON details without mutating the live result or losing usage', () => {
  for (const details of [{ value: 1n }, (() => { const cycle: { self?: unknown } = {}; cycle.self = cycle; return cycle; })()]) {
    const result = { ...ok('safe content').result, details,
      usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      nestedCalls: { calls: [], complete: true },
    };
    const projected = projectResult(result);
    assert.equal(result.details, details);
    assert.throws(() => JSON.stringify(result));
    assert.doesNotThrow(() => JSON.stringify(projected));
    assert.deepEqual(projected.persistenceOmissions, ['details']);
    assert.deepEqual(projected.content, result.content);
    assert.deepEqual(projected.usage, result.usage);
    assert.deepEqual(projected.nestedCalls, result.nestedCalls);
  }
});

test('foreground CodeMode observer releases admission while its separate scope still drains on close', async () => {
  const h = runtimeHarness({ maxRunning: 1, shutdownGraceMs: 1 });
  const scope = deferred<import('../src/protocol.ts').ScopeResult | undefined>();
  const indexed: unknown[] = [];
  const runtime = new TaskRuntime(h.config, { notify() {}, index(change) { indexed.push(change); } });
  let signal: AbortSignal | undefined;
  try {
    const result = ok('child handle');
    const view = await runtime.run({ tool: 'codemode', kind: 'tool', callId: 'root', codemodeRootId: 'root',
      mode: 'auto', canDetach: true, scope: scope.promise,
      execute(s) { signal = s; return Promise.resolve(result); } });
    assert.equal(view.kind, 'result');
    assert.equal(runtime.list().length, 0, 'no observer task blocks the frontend');
    await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal((await runtime.run({ tool: 'other', kind: 'tool', callId: 'other', mode: 'auto', canDetach: true, execute: async () => ok() })).kind, 'result');
    const closing = runtime.close(); let closed = false; void closing.then(() => { closed = true; });
    await sleep(5);
    assert.equal(signal!.aborted, true); assert.equal(closed, false, 'shutdown still owns the late scope');
    scope.resolve({ result: { ...result.result, nestedCalls: { calls: [], complete: true } } });
    await closing;
    assert.equal((indexed[0] as any).completion.lateScope, true);
    assert.equal((indexed[0] as any).completion.toolCallId, 'root');
  } finally { scope.resolve(undefined); await runtime.close(); await h.close(); }
});

// Every async test owns and drains its producers, making leak assertions meaningful.
test('fast foreground result completes without a completion notification', async () => {
  const h = runtimeHarness();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: async () => ok() });
    assert.equal(view.kind, 'result'); assert.equal(view.task.state, 'completed');
    h.runtime.published('c1'); await sleep(15); assert.equal(h.notifications.length, 0);
    assert.equal(view.task.outputPath, undefined);
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
    const waiting = h.runtime.run({ tool: 'long', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: s => { signal = s; return work.promise; } });
    assert.equal(h.runtime.detachAll('steer'), 0);
    const view = await waiting;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'timeout'); assert.equal(signal!.aborted, false);
    assert.equal(h.runtime.tasks.get(view.task.id)!.steerTimer, undefined);
  } finally { work.resolve(ok()); await h.close(); }
});
for (const native of [false, true]) test(`${native ? 'native root inherited' : 'ordinary'} steer waits for its monotonic admission deadline without extending or replaying`, async t => {
  const clock = steerClock(t);
  let wall = 1_000_000; t.mock.method(Date, 'now', () => wall);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>(), entered = deferred<void>();
  const parent = new AbortController(); let signal: AbortSignal | undefined, executions = 0;
  try {
    const wait = h.runtime.run({ tool: native ? 'codemode' : 'long', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true,
      ...(native ? { codemodeRootId: 'c1', userDetach: 'steer' as const } : {}), parentSignal: parent.signal,
      execute: s => { executions++; signal = s; entered.resolve(); return work.promise; } });
    await entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
    const task = [...h.runtime.tasks.values()][0]!;
    clock.tick(1000); assert.equal(h.runtime.detachAll('steer'), 0);
    const timer = task.steerTimer; assert.ok(timer);
    wall += 100_000; clock.tick(1000); assert.equal(h.runtime.detachAll('steer'), 0);
    assert.equal(task.steerTimer, timer, 'repeated steer must reuse the one deadline timer');
    wall -= 200_000; clock.tick(999);
    assert.equal(task.meta.delivery, 'foreground'); assert.equal(h.records.size, 0); assert.equal(signal!.aborted, false);
    clock.tick(1);
    const view = await wait;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'steer'); assert.equal(h.records.size, 1);
    assert.equal(task.steerTimer, undefined); assert.equal(h.runtime.detachAll('shortcut'), 0);
    parent.abort(); assert.equal(signal!.aborted, false); assert.equal(executions, 1);
    work.resolve(ok('continued once'));
    assert.match(JSON.stringify((await h.runtime.wait(view.task.id, 1000)).result), /continued once/);
  } finally { work.resolve(ok()); await h.close(); }
});

test('steer after the startup deadline detaches immediately, with no new timer', async t => {
  const clock = steerClock(t);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    const waiting = h.runtime.run({ tool: 'long', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: () => work.promise });
    await Promise.resolve(); clock.tick(3100);
    assert.equal(h.runtime.detachAll('steer'), 1);
    assert.equal((await waiting).task.detachReason, 'steer');
    assert.equal([...h.runtime.tasks.values()][0]!.steerTimer, undefined);
  } finally { work.resolve(ok()); await h.close(); }
});

for (const ending of ['completion', 'cancel', 'close', 'shortcut', 'explicit'] as const) test(`pending steer timer is cleared by ${ending}`, async t => {
  const clock = steerClock(t);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>(), entered = deferred<void>(); let signal: AbortSignal | undefined;
  try {
    const waiting = h.runtime.run({ tool: 'long', kind: 'tool', callId: 'c1', mode: ending === 'explicit' ? 'yes' : 'auto', canDetach: true,
      execute: s => { signal = s; s.addEventListener('abort', () => work.resolve(ok('cancelled'))); entered.resolve(); return work.promise; } });
    await entered.promise;
    const task = [...h.runtime.tasks.values()][0]!;
    assert.equal(h.runtime.detachAll('steer'), 0); assert.ok(task.steerTimer);
    clock.tick(1000);
    if (ending === 'completion') work.resolve(ok('fast result'));
    else if (ending === 'cancel') { h.runtime.cancel(task.meta.id); assert.equal(task.steerTimer, undefined); }
    else if (ending === 'close') { const closing = h.runtime.close(); assert.equal(task.steerTimer, undefined); await closing; }
    else if (ending === 'shortcut') assert.equal(h.runtime.detachAll('shortcut'), 1);
    const view = await waiting; // Explicit yes runs on its original immediate, not the steer timer.
    assert.equal(view.kind, ending === 'shortcut' || ending === 'explicit' ? 'handle' : 'result');
    assert.equal(task.steerTimer, undefined); assert.equal(task.requestedDetach, undefined);
    assert.equal(signal!.aborted, ending === 'cancel' || ending === 'close');
    clock.tick(3000);
    assert.equal(h.records.size, view.kind === 'handle' ? 1 : 0, 'no delayed/spurious handle after the original view');
    if (view.kind === 'handle') assert.equal(view.task.detachReason, ending === 'explicit' ? 'explicit' : 'shortcut');
    else if (ending === 'completion') assert.match(JSON.stringify(view.result), /fast result/);
    else assert.equal(view.task.state, 'cancelled');
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
    assert.equal(aborted, true); assert.equal(view.task.state, 'cancelled'); assert.equal(view.task.isError, true);
  } finally { await h.close(); }
});
test('no-mode pending steer at its deadline still waits for approval and its continuation turn', async t => {
  const clock = steerClock(t);
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const wait = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'c1', mode: 'no', canDetach: true, execute: () => work.promise });
    await Promise.resolve();
    assert.equal(h.runtime.detachAll('steer'), 0);
    clock.tick(3000);
    assert.equal(h.runtime.list()[0]!.delivery, 'foreground'); assert.equal(h.records.size, 0);
    h.runtime.prompt(false);
    assert.equal(h.runtime.detachAll('steer'), 0, 'ui_prompt_end must not bypass the approval continuation');
    const view = await wait;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'steer'); assert.equal(h.records.size, 1);
  } finally { work.resolve(ok()); await h.close(); }
});

test('prompt-deferred replay before 3s keeps the original startup deadline', async t => {
  const clock = steerClock(t);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    const waiting = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'c1', mode: 'auto', canDetach: true, execute: () => work.promise });
    await Promise.resolve();
    h.runtime.prompt(true); h.runtime.detachAll('steer');
    clock.tick(1000); h.runtime.prompt(false);
    await new Promise<void>(resolve => setImmediate(resolve));
    clock.tick(1999); assert.equal(h.runtime.list()[0]!.delivery, 'foreground');
    clock.tick(1); assert.equal((await waiting).task.detachReason, 'steer');
  } finally { work.resolve(ok()); await h.close(); }
});
test('approval gate defers explicit yes until prompt closes, never until a later steer deadline', async t => {
  const clock = steerClock(t);
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    await new Promise<void>(resolve => setImmediate(resolve));
    clock.tick(1000); assert.equal(h.runtime.detachAll('steer'), 0);
    assert.equal(h.runtime.list()[0]!.delivery, 'foreground');
    h.runtime.prompt(false);
    const view = await waiting;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'explicit');
  } finally { work.resolve(ok()); await h.close(); }
});

test('steer cannot postpone a shortcut already waiting on approval', async t => {
  steerClock(t);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'no', canDetach: true, execute: () => work.promise });
    await Promise.resolve();
    assert.equal(h.runtime.detachAll('shortcut'), 0); assert.equal(h.runtime.detachAll('steer'), 0);
    h.runtime.prompt(false);
    const view = await waiting;
    assert.equal(view.kind, 'handle'); assert.equal(view.task.detachReason, 'shortcut');
  } finally { work.resolve(ok()); await h.close(); }
});

test('at the mature steer deadline, approval denial still settles before prompt-resume detachment', async t => {
  const clock = steerClock(t);
  const h = runtimeHarness({ autoDetachMs: 0 }); const work = deferred<Outcome>();
  try {
    h.runtime.prompt(true);
    const waiting = h.runtime.run({ tool: 'guarded', kind: 'tool', callId: 'c1', mode: 'no', canDetach: true, execute: () => work.promise });
    await Promise.resolve(); clock.tick(3000);
    h.runtime.prompt(false);
    assert.equal(h.runtime.detachAll('steer'), 0, 'only the approval continuation gate prevents this mature steer');
    await Promise.resolve(); work.resolve({ ...ok('Permission denied'), isError: true });
    const view = await waiting;
    assert.equal(view.kind, 'result'); assert.equal(view.task.state, 'failed'); assert.equal(view.task.delivery, 'foreground');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.records.size, 0, 'denial never publishes a handle');
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
  const runtime = new TaskRuntime(h.config, { ...h.sink, notify() { if (++sends < 2) throw new Error('busy'); } });
  const work = deferred<Outcome>();
  try {
    const view = await runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    runtime.published('c1'); work.resolve(ok()); await until(() => runtime.get(view.task.id).notification === 'queued');
    assert.equal(sends, 2);
  } finally { work.resolve(ok()); await runtime.close(); await h.close(); }
});
async function notificationBatch(count: number) {
  const h = runtimeHarness({ notifyDebounceMs: 5000, maxRunning: 32 });
  const work = deferred<Outcome>(), ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: `notice-${i}`, mode: 'yes', canDetach: true, execute: () => work.promise });
    ids.push(view.task.id); h.runtime.published(`notice-${i}`, view.task.id);
  }
  work.resolve(ok());
  await Promise.all([...h.runtime.tasks.values()].map(task => task.done));
  return { ...h, ids };
}

test('notification handoff reserves queued before synchronous reentry and consumption', async () => {
  const h = await notificationBatch(2); let sends = 0;
  h.sink.notify = tasks => {
    sends++;
    assert.ok(tasks.every(task => task.notification === 'queued'));
    h.runtime.flushNotifications(); // A synchronous run start must not resend.
    h.runtime.notificationConsumed(tasks.map(task => task.id));
  };
  try {
    h.runtime.flushNotifications();
    assert.equal(sends, 1);
    assert.ok(h.ids.every(id => h.runtime.get(id).notification === 'delivered'));
    h.runtime.notificationConsumed([...h.ids, 'missing']);
    h.runtime.notificationFailed(h.ids);
    h.runtime.flushNotifications();
    assert.equal(sends, 1, 'duplicate/late receipts cannot rearm delivered tasks');
  } finally { await h.close(); }
});

for (const outcome of ['false', 'throw'] as const) test(`notification ${outcome} rolls back only still-queued members`, async () => {
  const h = await notificationBatch(3);
  const [delivered, observed, retry] = h.ids as [string, string, string];
  h.sink.notify = () => {
    h.runtime.notificationConsumed([delivered]);
    h.runtime.result(observed);
    if (outcome === 'throw') throw new Error('enqueue failed after receipts');
    return false;
  };
  try {
    h.runtime.flushNotifications();
    assert.deepEqual(h.ids.map(id => h.runtime.get(id).notification), ['delivered', 'observed', 'pending']);
    assert.equal(h.runtime.tasks.get(retry)!.notifyAttempts, outcome === 'throw' ? 1 : 0);
    const sent: string[] = [];
    h.sink.notify = tasks => { sent.push(...tasks.map(task => task.id)); h.runtime.notificationConsumed(sent); };
    await h.runtime.flushNotificationsAtBoundary();
    assert.deepEqual(sent, [retry]);
    assert.equal(h.runtime.get(retry).notification, 'delivered');
  } finally { await h.close(); }
});

test('async notification failure waits for a boundary and shares the synchronous retry budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await notificationBatch(1); const id = h.ids[0]!;
  let sends = 0;
  h.sink.notify = () => { if (++sends === 2) throw new Error('synchronous retry failure'); };
  try {
    h.runtime.flushNotifications(); // Ahead of the original debounce timer.
    h.runtime.notificationFailed([id, id, 'missing']);
    assert.equal(h.runtime.tasks.get(id)!.notifyAttempts, 1);
    assert.equal(h.runtime.get(id).notification, 'pending');
    t.mock.timers.tick(10_000);
    assert.equal(sends, 1, 'async failure cannot self-wake via a leftover debounce');
    await h.runtime.flushNotificationsAtBoundary();
    assert.equal(sends, 2, 'synchronous failure cannot retry in the same drain');
    assert.equal(h.runtime.tasks.get(id)!.notifyAttempts, 2);
    t.mock.timers.tick(5000);
    assert.equal(h.runtime.get(id).notification, 'queued');
    h.runtime.notificationFailed([id, id]);
    assert.equal(h.runtime.tasks.get(id)!.notifyAttempts, 3);
    assert.equal(h.runtime.get(id).notification, 'failed');
    t.mock.timers.tick(10_000);
    await h.runtime.flushNotificationsAtBoundary();
    assert.equal(sends, 3);
    h.runtime.notificationConsumed([id]);
    assert.equal(h.runtime.get(id).notification, 'failed', 'late consumption cannot acknowledge an unqueued retry');
  } finally { await h.close(); }
});

test('returned volatile notifications retry without consuming the failure budget', async () => {
  const h = await notificationBatch(1); const id = h.ids[0]!;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      h.runtime.flushNotifications();
      assert.equal(h.runtime.get(id).notification, 'queued');
      h.runtime.notificationReturned([id, 'missing']);
      assert.equal(h.runtime.get(id).notification, 'pending');
      assert.equal(h.runtime.tasks.get(id)!.notifyAttempts, 0);
    }
    h.runtime.notificationConsumed([id]);
    assert.equal(h.runtime.get(id).notification, 'pending', 'a stale receipt cannot consume a returned retry');
    h.sink.notify = tasks => h.runtime.notificationConsumed(tasks.map(task => task.id));
    h.runtime.flushNotifications();
    assert.equal(h.runtime.get(id).notification, 'delivered');
  } finally { await h.close(); }
});

test('boundary drains bounded batches without claiming unconfirmed delivery', async () => {
  const h = await notificationBatch(17);
  try {
    await h.runtime.flushNotificationsAtBoundary();
    assert.deepEqual(h.notifications.map(batch => batch.length), [16, 1]);
    assert.deepEqual(h.notifications.flat().map(task => task.id), h.ids);
    assert.ok(h.ids.every(id => h.runtime.get(id).notification === 'queued'));
    h.runtime.notificationConsumed(h.ids);
    await h.runtime.flushNotificationsAtBoundary();
    assert.equal(h.notifications.length, 2);
    assert.ok(h.ids.every(id => h.runtime.get(id).notification === 'delivered'));
  } finally { await h.close(); }
});

test('late notification receipts preserve observation and closed-generation suppression', async () => {
  const h = await notificationBatch(2);
  try {
    h.runtime.flushNotifications();
    h.runtime.result(h.ids[0]!);
    h.runtime.notificationFailed([h.ids[0]!]);
    h.runtime.notificationConsumed([h.ids[0]!]);
    assert.equal(h.runtime.get(h.ids[0]!).notification, 'observed');
    await h.runtime.close();
    h.runtime.notificationFailed(h.ids);
    h.runtime.notificationConsumed(h.ids);
    await h.runtime.flushNotificationsAtBoundary();
    assert.ok(h.ids.every(id => h.runtime.get(id).notification === 'suppressed'));
    assert.equal(h.notifications.length, 1);
  } finally { await h.close(); }
});

test('capacity counts actual live producers, not foreground waiters', async () => {
  const h = runtimeHarness({ maxRunning: 1 }); const work = deferred<Outcome>();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c1', mode: 'yes', canDetach: true, execute: () => work.promise });
    h.runtime.cancel(view.task.id);
    assert.equal(h.runtime.get(view.task.id).state, 'cancel_requested');
    assert.throws(() => h.runtime.run({ tool: 'two', kind: 'tool', callId: 'c2', mode: 'yes', canDetach: true, execute: async () => ok() }), /capacity/);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.get(view.task.id).state, 'cancelled');
    assert.equal(h.runtime.get(view.task.id).isError, false); // Late native success is retained, not relabelled as an error.
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
  const other = new TaskRuntime(h.config, { ...h.sink, notify() { throw new Error('must not notify'); } }, [...h.records.values()]);
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
  await h.runtime.close(); const next = new TaskRuntime(h.config, h.sink, [...h.records.values()]);
  try {
    assert.throws(() => next.run({ tool: 'next', kind: 'tool', callId: 'c2', mode: 'yes', canDetach: true, execute: async () => ok() }), /capacity/);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal((await next.run({ tool: 'next', kind: 'tool', callId: 'c3', mode: 'auto', canDetach: true, execute: async () => ok() })).kind, 'result');
  } finally { work.resolve(ok()); await next.close(); await h.close(); }
});
test('terminal retention bounds task count without a second text limit', async () => {
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
    for (const task of h.runtime.tasks.values()) assert.deepEqual(task.result!.content, ok('x'.repeat(100_000)).result.content);
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

test('CodeMode close coalesces, really drains late pipelines and persists completion before retiring the sink', async () => {
  const h = runtimeHarness({ shutdownGraceMs: 1 });
  const work = deferred<Outcome>(); let signal: AbortSignal | undefined, released = 0;
  try {
    const view = await h.runtime.run({ tool: 'codemode', kind: 'tool', callId: 'root', codemodeRootId: 'root',
      mode: 'yes', canDetach: true, onSettled() { released++; }, execute(s) { signal = s; return work.promise; } });
    h.runtime.published('root');
    const closing = h.runtime.close();
    assert.equal(h.runtime.close(), closing, 'concurrent shutdown joins the same drain');
    let closed = false; void closing.then(() => { closed = true; });
    await sleep(5);
    assert.equal(signal!.aborted, true); assert.equal(closed, false);
    const native = { ...ok('late').result, details: { original: true }, nestedCalls: { calls: [], complete: true } };
    work.resolve({ result: native, isError: false });
    await closing;
    assert.equal(released, 1); assert.equal(h.notifications.length, 0);
    const record = h.records.get(view.task.id)!;
    assert.equal(record.completion!.toolCallId, 'root');
    assert.deepEqual(record.completion!.result, native);
    const reopened = new TaskRuntime(h.config, h.sink, [record]);
    try { assert.deepEqual(reopened.result(view.task.id).result, native); }
    finally { await reopened.close(); }
  } finally { work.resolve(ok()); await h.close(); }
});
