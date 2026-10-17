import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { TaskRuntime } from '../src/runtime.ts';
import { TaskStore } from '../src/store.ts';
import { deferred, ok, runtimeHarness, sleep, until } from './helpers.ts';
import type { Outcome } from '../src/protocol.ts';

const run = (runtime: TaskRuntime, callId: string, work: Promise<Outcome>) => runtime.run({
  tool: 'noncooperative', kind: 'tool', callId, mode: 'yes', canDetach: true, execute: () => work,
});

test('the current restored runtime refreshes late success and cannot overwrite it on close', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>(); let calls = 0; const notes: unknown[] = [];
  const view = await run(h.runtime, 'late', work.promise.then(result => { calls++; return result; }));
  h.runtime.published('late'); await h.runtime.close();
  const restored = new TaskRuntime(h.store, h.config, { notify: tasks => notes.push(tasks) });
  try {
    assert.equal(restored.get(view.task.id).state, 'outcome_unknown');
    work.resolve(ok('LATE_RESULT')); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(restored.list()[0]!.state, 'completed');
    const read = restored.result(view.task.id);
    assert.equal(read.task.state, 'completed'); assert.equal(read.task.recovered, true);
    assert.deepEqual(read.result, JSON.parse(JSON.stringify(ok('LATE_RESULT').result)));
    assert.ok(read.task.endedAt); assert.ok(read.task.resultPath);
    const before = h.store.readMeta(view.task.id); await restored.close();
    assert.deepEqual(h.store.readMeta(view.task.id), before);
    assert.equal(before!.notification, 'observed'); assert.equal(calls, 1); assert.equal(notes.length, 0);
  } finally { work.resolve(ok()); await restored.close(); await h.close(); }
});

test('multiple stale observers may close before and after late completion without lifecycle writes', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const view = await run(h.runtime, 'late', work.promise); await h.runtime.close();
  const a = new TaskRuntime(h.store, h.config, { notify() { assert.fail('stale notification'); } });
  const b = new TaskRuntime(h.store, h.config, { notify() { assert.fail('stale notification'); } });
  try {
    await a.close(); work.resolve(ok('late')); await until(() => TaskRuntime.liveProducerCount() === 0);
    const canonical = h.store.readMeta(view.task.id); assert.equal(canonical!.state, 'completed');
    await b.close(); assert.deepEqual(h.store.readMeta(view.task.id), canonical);
    assert.equal(b.result(view.task.id).task.state, 'completed');
  } finally { work.resolve(ok()); await a.close(); await b.close(); await h.close(); }
});

test('observer acknowledgement is merged and producer shutdown cannot regress it', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const view = await run(h.runtime, 'one', work.promise); h.runtime.published('one');
  work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
  const restored = new TaskRuntime(h.store, h.config, { notify() {} });
  try {
    const read = restored.result(view.task.id); assert.ok(read.result);
    await h.runtime.close();
    const disk = h.store.readMeta(view.task.id)!;
    assert.equal(disk.notification, 'observed'); assert.equal(disk.state, 'completed');
    assert.equal(disk.resultPath, read.task.resultPath); assert.equal(disk.endedAt, read.task.endedAt);
  } finally { await restored.close(); await h.close(); }
});

test('flush alone enforces retention and removes matching metadata and result files', async () => {
  const h = runtimeHarness({ maxRetained: 1, notifyDebounceMs: 5000 });
  const jobs = [deferred<Outcome>(), deferred<Outcome>(), deferred<Outcome>()];
  try {
    const handles = [];
    for (let i = 0; i < 3; i++) {
      handles.push(await run(h.runtime, `c${i}`, jobs[i]!.promise)); h.runtime.published(`c${i}`);
    }
    h.runtime.prompt(true);
    for (const work of jobs) { work.resolve(ok()); await sleep(2); }
    await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.list().length, 3); assert.equal(h.store.loadMetadata().length, 3);
    assert(h.runtime.list().every(t => t.notification === 'pending'));
    h.runtime.prompt(false); await new Promise<void>(resolve => setImmediate(resolve));
    h.runtime.flushNotifications(); // no later run/finish/publish; permission verdict microtasks have settled
    assert.equal(h.notifications.flat().length, 3);
    assert.equal(h.runtime.list().length, 1); assert.equal(h.store.loadMetadata().length, 1);
    assert.equal(readdirSync(h.store.directory).filter(x => x.endsWith('.result.json')).length, 1);
    assert.equal(h.runtime.list()[0]!.notification, 'queued');
    assert.equal(h.runtime.list()[0]!.id, handles[2]!.task.id);
    assert.ok(h.runtime.result(handles[2]!.task.id).result);
  } finally { jobs.forEach(w => w.resolve(ok())); await h.close(); }
});

test('recovery loads all pending records; each remains readable until observation releases retention', async () => {
  const h = runtimeHarness({ maxRetained: 1, notifyDebounceMs: 5000 });
  const jobs = [deferred<Outcome>(), deferred<Outcome>(), deferred<Outcome>()];
  let recovered: TaskRuntime | undefined;
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const v = await run(h.runtime, `c${i}`, jobs[i]!.promise); ids.push(v.task.id); h.runtime.published(`c${i}`); }
    h.runtime.prompt(true); jobs.forEach(w => w.resolve(ok())); await until(() => TaskRuntime.liveProducerCount() === 0);
    recovered = new TaskRuntime(h.store, h.config, { notify() { assert.fail('recovery cannot notify'); } });
    assert.equal(recovered.list().length, 3);
    for (const id of ids) assert.ok(recovered.result(id).result);
    assert.equal(recovered.list().length, 1); assert.equal(h.store.loadMetadata().length, 1);
  } finally { jobs.forEach(w => w.resolve(ok())); await recovered?.close(); await h.close(); }
});

test('recovered uncertainty is never pruned as a terminal task or used to free a live lease', async () => {
  const h = runtimeHarness({ maxRetained: 1, maxRunning: 1 }); const work = deferred<Outcome>();
  const view = await run(h.runtime, 'late', work.promise); await h.runtime.close();
  const recovered = new TaskRuntime(h.store, h.config, { notify() {} });
  try {
    assert.equal(recovered.get(view.task.id).state, 'outcome_unknown');
    assert.equal(h.store.readMeta(view.task.id)!.localRunning, true);
    assert.throws(() => run(recovered, 'other', Promise.resolve(ok())), /capacity/);
    assert.throws(() => recovered.cancel(view.task.id), /no live local controller/);
    await recovered.close(); assert.equal(h.store.readMeta(view.task.id)!.state, 'outcome_unknown');
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.store.readMeta(view.task.id)!.state, 'completed');
  } finally { work.resolve(ok()); await recovered.close(); await h.close(); }
});

test('same session ID with a different session file has no task access or late notification', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  const a = new TaskRuntime(new TaskStore(h.root, 'session\0/path/a.jsonl', h.config.maxResultBytes), h.config, { notify() { assert.fail('old owner notified'); } });
  const b = new TaskRuntime(new TaskStore(h.root, 'session\0/path/b.jsonl', h.config.maxResultBytes), h.config, { notify() { assert.fail('wrong owner notified'); } });
  try {
    const view = await run(a, 'same-call', work.promise); a.published('same-call'); await a.close();
    assert.throws(() => b.result(view.task.id), /No task/); assert.equal(b.list().length, 0);
    work.resolve(ok()); await until(() => TaskRuntime.liveProducerCount() === 0); b.flushNotifications();
    assert.throws(() => b.result(view.task.id), /No task/); assert.equal(b.list().length, 0);
  } finally { work.resolve(ok()); await a.close(); await b.close(); await h.close(); }
});

test('a writer ownership conflict is visible and never clobbers the canonical record', async () => {
  const h = runtimeHarness();
  try {
    const view = await h.runtime.run({ tool: 'one', kind: 'tool', callId: 'c', mode: 'no', canDetach: true, execute: async () => ok() });
    h.store.updateMeta(view.task.id, current => ({ ...current, producerId: 'another-writer' }));
    const before = h.store.readMeta(view.task.id); await h.runtime.close();
    assert.deepEqual(h.store.readMeta(view.task.id), before);
    assert.match(h.runtime.get(view.task.id).storageError!, /ownership changed/);
    assert.ok(existsSync(view.task.resultPath!));
  } finally { await h.close(); }
});

test('final lease release prunes simultaneous observed finishes without a later event', async () => {
  const h = runtimeHarness({ maxRetained: 1 }); const jobs = [deferred<Outcome>(), deferred<Outcome>(), deferred<Outcome>()];
  try {
    const waits = jobs.map((job, i) => h.runtime.run({ tool: 'foreground', kind: 'tool', callId: `c${i}`, mode: 'no', canDetach: true, execute: () => job.promise }));
    // The host has already published these call IDs; all producers settle in a
    // single microtask batch, and foreground results need no notifications.
    for (let i = 0; i < 3; i++) h.runtime.published(`c${i}`);
    jobs.forEach(job => job.resolve(ok())); await Promise.all(waits);
    await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.runtime.list().length, 1); assert.equal(h.store.loadMetadata().length, 1);
    assert.equal(h.notifications.length, 0);
  } finally { jobs.forEach(job => job.resolve(ok())); await h.close(); }
});

test('an ownership conflict before late finish cannot replace another canonical result', async () => {
  const h = runtimeHarness(); const work = deferred<Outcome>();
  try {
    const view = await run(h.runtime, 'late', work.promise);
    const canonical = h.store.saveResult(view.task.id, ok('OTHER_CANONICAL_RESULT').result);
    h.store.updateMeta(view.task.id, current => ({ ...current, producerId: 'another-writer',
      localRunning: false, endedAt: Date.now(), state: 'completed', resultPath: canonical.path }));
    const before = h.store.readMeta(view.task.id);
    work.resolve(ok('STALE_WRITER_RESULT')); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.deepEqual(h.store.readMeta(view.task.id), before);
    assert.match(JSON.stringify(h.store.readResult(view.task.id)), /OTHER_CANONICAL_RESULT/);
    assert.equal(h.runtime.get(view.task.id).state, 'outcome_unknown');
    assert.match(h.runtime.get(view.task.id).storageError!, /ownership changed/);
  } finally { work.resolve(ok()); await h.close(); }
});

test('reading a pending older result retains the file promised by that returned view', async () => {
  const h = runtimeHarness({ maxRetained: 1, notifyDebounceMs: 5000 }); const jobs = [deferred<Outcome>(), deferred<Outcome>()];
  try {
    const older = await run(h.runtime, 'old', jobs[0]!.promise); h.runtime.published('old');
    const newer = await run(h.runtime, 'new', jobs[1]!.promise); h.runtime.published('new');
    h.runtime.prompt(true); jobs[0]!.resolve(ok('old payload')); await sleep(2); jobs[1]!.resolve(ok('new payload'));
    await until(() => TaskRuntime.liveProducerCount() === 0);
    const oldResult = h.runtime.result(older.task.id); assert.ok(oldResult.result); assert.ok(existsSync(oldResult.task.resultPath!));
    // The other pending task remains protected even if maxRetained is one.
    assert.equal(h.runtime.list().length, 2); assert.equal(h.runtime.get(newer.task.id).notification, 'pending');
    const newResult = h.runtime.result(newer.task.id); assert.ok(existsSync(newResult.task.resultPath!));
    assert.equal(h.runtime.list().length, 1); assert.equal(h.store.loadMetadata().length, 1);
  } finally { jobs.forEach(job => job.resolve(ok())); await h.close(); }
});
