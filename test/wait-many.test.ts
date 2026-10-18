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
