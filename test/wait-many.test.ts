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
    assert.equal(cancelled.task.state, 'cancelled'); assert.equal(cancelled.task.notification, 'observed');
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
      assert.deepEqual(complete.tasks.map(view => view.task.state), ['cancelled', 'completed']);
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
