import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Outcome } from '../src/protocol.ts';
import { deferred, ok, runtimeHarness, until } from './helpers.ts';

test('waitMany races any, times out all, and returns settled results in requested order', async () => {
  const h = runtimeHarness(); const a = deferred<Outcome>(), b = deferred<Outcome>();
  try {
    const first = await h.runtime.run({ tool: 'a', kind: 'tool', callId: 'a', mode: 'yes', canDetach: true, execute: () => a.promise });
    const second = await h.runtime.run({ tool: 'b', kind: 'tool', callId: 'b', mode: 'yes', canDetach: true, execute: () => b.promise });
    const ids = [first.task.id.slice(3), second.task.id];
    const waiting = h.runtime.waitMany(ids, 'any', 5000);
    b.resolve(ok('second'));
    const any = await waiting;
    assert.deepEqual(any.tasks.map(view => view.task.id), [second.task.id]);
    assert.deepEqual(any.pending.map(task => task.id), [first.task.id]);
    assert.equal(any.tasks[0]!.task.notification, 'observed');
    const all = await h.runtime.waitMany(ids, 'all', 5);
    assert.deepEqual(all.tasks.map(view => view.task.id), [second.task.id]);
    assert.deepEqual(all.pending.map(task => task.id), [first.task.id]);
    a.resolve(ok('first'));
    const finished = await h.runtime.waitMany(ids, 'all', 5000);
    assert.deepEqual(finished.tasks.map(view => view.task.id), [first.task.id, second.task.id]);
    assert.deepEqual(finished.pending, []);
  } finally { a.resolve(ok()); b.resolve(ok()); await h.close(); }
});

for (const ending of ['completion', 'timeout', 'abort', 'detach'] as const) test(`waitMany retains a concurrently cancelled result under retention pressure until ${ending}`, async () => {
  const h = runtimeHarness({ maxRetained: 1, shutdownGraceMs: 100, notifyDebounceMs: 0 });
  const a = deferred<Outcome>(), b = deferred<Outcome>(); const caller = new AbortController();
  try {
    const first = await h.runtime.run({ tool: 'a', kind: 'tool', callId: 'a', mode: 'yes', canDetach: true,
      execute: signal => {
        signal.addEventListener('abort', () => a.resolve(ok('A cancelled')));
        return a.promise;
      } });
    const second = await h.runtime.run({ tool: 'b', kind: 'tool', callId: 'b', mode: 'yes', canDetach: true, execute: () => b.promise });
    h.runtime.published('a'); h.runtime.published('b');
    const ids = [first.task.id, second.task.id];
    const batch = h.runtime.waitMany(ids, 'all', ending === 'timeout' ? 10 : 5000, caller.signal);
    const cancelled = await h.runtime.wait(first.task.id, h.config.shutdownGraceMs, undefined, true);
    assert.equal(cancelled.task.state, 'completed'); assert.equal(cancelled.task.notification, 'observed');
    if (ending === 'abort') {
      caller.abort(new Error('stop batch'));
      await assert.rejects(batch, /stop batch/);
    } else if (ending === 'timeout' || ending === 'detach') {
      if (ending === 'detach') h.runtime.releaseWaiters();
      const partial = await batch;
      assert.deepEqual(partial.tasks.map(view => view.task.id), [first.task.id]);
      assert.deepEqual(partial.pending.map(task => task.id), [second.task.id]);
    }
    b.resolve(ok('B completed'));
    if (ending === 'completion') {
      const complete = await batch;
      assert.deepEqual(complete.tasks.map(view => view.task.id), ids);
      assert.deepEqual(complete.tasks.map(view => view.task.state), ['completed', 'completed']);
      assert.deepEqual(complete.tasks.map(view => view.result?.structuredContent), [{ value: 'A cancelled' }, { value: 'B completed' }]);
      assert.deepEqual(complete.pending, []);
      h.runtime.flushNotifications(); assert.equal(h.notifications.length, 0);
    } else {
      await until(() => h.notifications.length === 1);
      assert.deepEqual(h.notifications.flat().map(task => task.id), [second.task.id]);
    }
    assert.deepEqual(h.runtime.list().map(task => task.id), [second.task.id], 'released guards allow normal pruning');
  } finally { a.resolve(ok()); b.resolve(ok()); await h.close(); }
});

test('waitMany validates all ids before ack and abort only stops the wait', async () => {
  const h = runtimeHarness(); const a = deferred<Outcome>(), b = deferred<Outcome>();
  let producerSignal: AbortSignal | undefined;
  try {
    const first = await h.runtime.run({ tool: 'a', kind: 'tool', callId: 'a', mode: 'yes', canDetach: true, execute: () => a.promise });
    const second = await h.runtime.run({ tool: 'b', kind: 'tool', callId: 'b', mode: 'yes', canDetach: true, execute: signal => { producerSignal = signal; return b.promise; } });
    a.resolve(ok()); await until(() => !h.runtime.get(first.task.id).localRunning);
    await assert.rejects(h.runtime.waitMany([first.task.id, 'missing'], 'any', 5000), /No task/);
    assert.notEqual(h.runtime.get(first.task.id).notification, 'observed');
    const controller = new AbortController();
    const waiting = h.runtime.waitMany([first.task.id, second.task.id], 'all', 5000, controller.signal);
    controller.abort(new Error('stop waiting'));
    await assert.rejects(waiting, /stop waiting/);
    assert.equal(producerSignal!.aborted, false);
    assert.equal(h.runtime.get(second.task.id).state, 'running');
    assert.notEqual(h.runtime.get(first.task.id).notification, 'observed');
  } finally { a.resolve(ok()); b.resolve(ok()); await h.close(); }
});

test('cancelMany mirrors waitMany preflight: a bad id aborts nothing and a signal only ends the wait', async () => {
  const h = runtimeHarness({ autoDetachMs: 0, shutdownGraceMs: 100, notifyDebounceMs: 0 });
  const stubborn = deferred<Outcome>(), cooperative = deferred<Outcome>();
  let producerSignal: AbortSignal | undefined, aborts = 0;
  try {
    const first = await h.runtime.run({ tool: 'a', kind: 'tool', callId: 'a', mode: 'yes', canDetach: true,
      execute: signal => { producerSignal = signal; signal.addEventListener('abort', () => { aborts++; }); return stubborn.promise; } });
    h.runtime.published('a');
    await assert.rejects(h.runtime.cancelMany([first.task.id, 'missing'], h.config.shutdownGraceMs), /No task/);
    assert.equal(aborts, 0); assert.equal(producerSignal!.aborted, false);
    assert.equal(h.runtime.get(first.task.id).state, 'running');
    const caller = new AbortController();
    const waiting = h.runtime.cancelMany([first.task.id], h.config.shutdownGraceMs, caller.signal);
    caller.abort(new Error('stop observing'));
    await assert.rejects(waiting, /stop observing/);
    assert.equal(aborts, 1, 'an interrupted observation keeps the cancellation it already requested');
    assert.equal(h.runtime.get(first.task.id).state, 'cancel_requested');
    const second = await h.runtime.run({ tool: 'b', kind: 'tool', callId: 'b', mode: 'yes', canDetach: true,
      execute: signal => { signal.addEventListener('abort', () => cooperative.resolve(ok('B cancelled'))); return cooperative.promise; } });
    h.runtime.published('b');
    const settled = await h.runtime.cancelMany([second.task.id, second.task.id.slice(3)], h.config.shutdownGraceMs);
    assert.deepEqual(settled.tasks.map(view => [view.task.id, view.task.state]), [[second.task.id, 'completed']], 'duplicate ids collapse');
    assert.deepEqual(settled.pending, []);
  } finally { stubborn.resolve(ok()); cooperative.resolve(ok()); await h.close(); }
});

test('waitMany any ignores un-waitable outcome_unknown tasks instead of settling immediately', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const { TaskRuntime } = await import('../src/runtime.ts');
  // A record without completion restores as outcome_unknown: no live promise.
  const ghostRecord = { id: 'mt_deadbeef', tool: 'ghost', kind: 'tool' as const, mode: 'yes' as const, createdAt: Date.now() - 1000 };
  const recovered = new TaskRuntime(h.config, h.sink, [ghostRecord]);
  try {
    assert.equal(recovered.get('mt_deadbeef').state, 'outcome_unknown');
    const live = await recovered.run({ tool: 'live', kind: 'tool', callId: 'live', mode: 'yes', canDetach: true, execute: () => work.promise });
    const waiting = recovered.waitMany(['mt_deadbeef', live.task.id], 'any', 5000);
    // Only the live task is waitable; `any` must wait for IT, not return at once.
    work.resolve(ok('live done'));
    const batch = await waiting;
    assert.deepEqual(batch.tasks.map(view => view.task.id), [live.task.id]);
    assert.deepEqual(batch.pending.map(task => task.id), ['mt_deadbeef']);
  } finally { work.resolve(ok()); await recovered.close(); await h.close(); }
});
