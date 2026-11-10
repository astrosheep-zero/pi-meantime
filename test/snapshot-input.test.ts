import assert from 'node:assert/strict';
import { test } from 'node:test';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Snapshot } from '../src/runtime.ts';
import type { Result } from '../src/protocol.ts';
import { FakePi, basicTool } from './host.ts';
import { deferred, ok, until } from './helpers.ts';

const config = validateConfig({ autoDetachMs: 0, explicitDetachMs: 0, notifyDebounceMs: 5, shutdownGraceMs: 10 });

test('non-shell inputs survive handles, list/wait, completion and index recovery', async () => {
  const pi = new FakePi();
  const cases = [
    ['codemode', { code: 'const rows = await tools.lookup();\nreturn rows;' }],
    ['mcp__search', { query: 'first line\nsecond line' }],
    ['extension_tool', { path: '/fixture/source.ts' }],
    ['square', { square: 'fixture-square', actor: 'fixture-actor' }],
  ] as const;
  const work = cases.map(() => deferred<Result>());
  for (const [i, [name]] of cases.entries()) pi.registerTool(basicTool(name, () => work[i]!.promise,
    { parameters: { type: 'object', additionalProperties: true } }));
  const app = install(pi, { config, connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  try {
    const ids: string[] = [];
    for (const [name, args] of cases) {
      const handle = await pi.call(name, { ...args, __background__: 'yes' });
      const task = handle.result.details as Snapshot;
      assert.deepEqual(task.args, args);
      assert.deepEqual((handle.result.structuredContent as unknown as { task: Snapshot }).task.args, args);
      ids.push(task.id);
    }
    const list = await pi.call('meantime', { action: 'list', limit: 2 });
    const page = list.result.details as { total: number; remainingCount: number; tasks: Snapshot[] };
    assert.equal(page.total, 4);
    assert.equal(page.remainingCount, 2);
    for (const task of page.tasks) assert.deepEqual(task.args, cases.find(([name]) => name === task.tool)![1]);
    work.forEach(w => w.resolve(ok('finished').result));
    await until(() => pi.notifications.flatMap(n => (n.details as { tasks: Snapshot[] }).tasks).length === 4);
    for (const task of pi.notifications.flatMap(n => (n.details as { tasks: Snapshot[] }).tasks)) {
      assert.deepEqual(task.args, cases.find(([name]) => name === task.tool)![1]);
    }
    await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    await pi.emit('session_start', { type: 'session_start' });
    for (const [i, [, args]] of cases.entries()) {
      const waited = await pi.call('meantime', { action: 'wait', ids: [ids[i]], timeout: 0 });
      const recovered = (waited.result.details as { task: Snapshot }).task;
      assert.equal(recovered.recovered, true);
      assert.deepEqual(recovered.args, args);
    }
  } finally {
    work.forEach(w => w.resolve(ok().result));
    await app.dispose();
  }
});

test('wait-all publishes the observed pending count through streaming, timeout and empty results', async () => {
  const pi = new FakePi(), work = Array.from({ length: 3 }, () => deferred<Result>());
  let started = 0;
  pi.registerTool(basicTool('slow', () => work[started++]!.promise));
  const app = install(pi, { config, connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  try {
    for (let i = 0; i < work.length; i++) await pi.call('slow', { __background__: 'yes' });
    const waiting = pi.call('meantime', { action: 'wait', timeout: 0.05 });
    await until(() => pi.updates.some(u => (u.details as { pendingCount?: number })?.pendingCount === 3));
    const preview = pi.updates.find(u => (u.details as { pendingCount?: number })?.pendingCount === 3)!;
    assert.equal((preview.details as { waitAll: boolean }).waitAll, true);
    work[0]!.resolve(ok().result);
    const timed = await waiting;
    assert.equal((timed.result.details as { pendingCount: number }).pendingCount, 2);
    assert.equal((timed.result.structuredContent as { pendingCount: number }).pendingCount, 2);
    work.forEach(w => w.resolve(ok().result));
    await until(() => (app.inspect() as { tasks: Snapshot[] }).tasks.every(t => !t.localRunning));
    const empty = await pi.call('meantime', { action: 'wait' });
    assert.deepEqual(empty.result.details, { tasks: [], pending: [], waitAll: true, pendingCount: 0 });
  } finally {
    work.forEach(w => w.resolve(ok().result));
    await app.dispose();
  }
});
