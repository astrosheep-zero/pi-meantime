import assert from 'node:assert/strict';
import { test } from 'node:test';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Outcome, Update } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, basicTool } from './host.ts';
import { deferred, ok, until } from './helpers.ts';

async function setup(config: Partial<Config> = {}) {
  const pi = new FakePi('A', 'tui');
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, explicitDetachMs: 0, notifyDebounceMs: 5, shutdownGraceMs: 15, ...config }), connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  return { pi, instance, async close() { await instance.dispose(); } };
}
function snapshot(outcome: Outcome): Snapshot {
  return (outcome.result.structuredContent as unknown as { task: Snapshot }).task;
}
// Structured snapshots preserve exact commands for the detail UI. Receipt prose
// remains independently bounded by commandPreview in extension.ts.
const LONG_COMMAND = `echo first\necho second\necho ${'x'.repeat(200)}`;
const normalized = (command: string) => command.replace(/\s+/g, ' ').trim();
function assertFull(command: string | undefined, raw: string, what: string): void {
  assert.equal(command, raw, `${what}: exact command, including line breaks`);
}

test('background handles carry the complete command in details and structuredContent', async () => {
  const h = await setup();
  try {
    const handle = await h.pi.call('bash', { command: LONG_COMMAND, __background__: 'yes' });
    assert.equal(handle.isError, false);
    const task = snapshot(handle);
    assert.equal(task.delivery, 'background');
    const details = handle.result.details as Snapshot;
    assertFull(details.command, LONG_COMMAND, 'handle details.command');
    assert.ok(details.command!.includes('\n'), 'multi-line preview keeps its line breaks');
    const structured = handle.result.structuredContent as unknown as { task: { command?: string } };
    assert.equal(structured.task.command, details.command, 'structuredContent mirrors the same preview');
  } finally { await h.close(); }
});

test('meantime wait streams an immediate partial snapshot of its targets', async () => {
  const h = await setup();
  try {
    const command = `sleep 0.15\n${LONG_COMMAND.replace('echo second', 'sleep 0.4 && echo second')}`;
    const handle = await h.pi.call('bash', { command, __background__: 'yes' });
    const task = snapshot(handle);
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [task.id], timeout: 2 });
    await until(() => h.pi.updates.some(update => Array.isArray((update.details as { tasks?: unknown } | undefined)?.tasks)), 1000);
    const partial = h.pi.updates.map(update => update.details as { waitStartedAt?: number; tasks?: { id: string; tool: string; state: string; command?: string; createdAt?: number }[] } | undefined)
      .find(details => Array.isArray(details?.tasks))!;
    assert.ok(Array.isArray(partial.tasks), 'the partial update carries task snapshots');
    assert.equal(typeof partial.waitStartedAt, 'number');
    const preview = partial.tasks![0]!;
    assert.equal(preview.id, task.id);
    assert.equal(preview.tool, 'bash');
    assert.equal(preview.state, 'running', 'previews keep the task\'s real state, the wait is expressed by the call itself');
    assert.equal(typeof preview.createdAt, 'number');
    assertFull(preview.command, command, 'streamed details.tasks[0].command');
    await until(() => h.pi.updates.some(update => {
      const tasks = (update.details as { tasks?: { outputTail?: string }[] } | undefined)?.tasks;
      return tasks?.[0]?.outputTail === 'first\n';
    }));
    assert.equal((h.instance.inspect() as { tasks: Snapshot[] }).tasks.find(t => t.id === task.id)!.localRunning, true,
      'real shell stdout reaches wait partials before the producer finishes');
    const settled = await waiting;
    assert.equal(settled.isError, false);
    const final = settled.result.details as { task: Snapshot };
    assertFull(final.task.command, command, 'settled wait details.task.command');
  } finally { await h.close(); }
});

for (const ending of ['completion', 'timeout', 'abort', 'any', 'all', 'cancel', 'cancel-many'] as const) {
  test(`meantime streams changed live snapshots and stops after ${ending}`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = await setup({ shutdownGraceMs: 1000 });
    const works = [deferred<Outcome>(), deferred<Outcome>()];
    const producers: { update: Update; signal: AbortSignal }[] = [];
    h.pi.registerTool(basicTool('stream', async (_id, _args, signal, update) => {
      const index = producers.length;
      producers.push({ update: update!, signal: signal! });
      return (await works[index]!.promise).result;
    }));
    try {
      const first = snapshot(await h.pi.call('stream', { __background__: 'yes' }));
      const many = ending === 'any' || ending === 'all' || ending === 'cancel-many';
      const ids = [first.id];
      if (many) ids.push(snapshot(await h.pi.call('stream', { __background__: 'yes' })).id);
      const caller = new AbortController();
      const cancel = ending === 'cancel' || ending === 'cancel-many';
      const waiting = h.pi.call('meantime', { action: cancel ? 'cancel' : 'wait', ids,
        mode: ending === 'any' ? 'any' : 'all', timeout: ending === 'timeout' ? 0.05 : 5 }, caller.signal);
      const partials = () => h.pi.updates.flatMap(update => {
        const details = update.details as { tasks?: (Snapshot & { outputTail?: string })[] } | undefined;
        return details?.tasks ? [details.tasks] : [];
      });
      await until(() => partials().length === 1);
      assert.equal(partials()[0]![0]!.state, 'running', 'the first preview precedes any cancel request');
      assert.equal(producers[0]!.signal.aborted, cancel);
      producers[0]!.update(ok('stdout\nstderr').result);
      t.mock.timers.tick(119);
      assert.equal(partials().length, 1, 'updates are throttled');
      t.mock.timers.tick(1);
      assert.equal(partials().length, 2);
      assert.equal(partials().at(-1)![0]!.outputTail, 'stdout\nstderr');
      assert.equal(partials().at(-1)![0]!.progress, 'stdout\nstderr');
      t.mock.timers.tick(360);
      assert.equal(partials().length, 2, 'unchanged snapshots do not re-emit');
      if (many) {
        producers[1]!.update(ok('second task live').result);
        t.mock.timers.tick(120);
        assert.equal(partials().at(-1)![1]!.outputTail, 'second task live');
      }
      if (ending === 'abort') caller.abort(new Error('stop observing'));
      else if (ending !== 'timeout') works[0]!.resolve(ok('first final'));
      if (ending === 'all' || ending === 'cancel-many') {
        await until(() => !(h.instance.inspect() as { tasks: Snapshot[] }).tasks.find(task => task.id === first.id)!.localRunning);
        producers[1]!.update(ok('still streaming').result);
        t.mock.timers.tick(120);
        assert.equal(partials().at(-1)![1]!.outputTail, 'still streaming');
        works[1]!.resolve(ok('second final'));
      }
      const outcome = await waiting;
      assert.equal(outcome.isError, ending === 'abort');
      if (ending === 'any') {
        const page = outcome.result.details as { tasks: Snapshot[]; pending: Snapshot[] };
        assert.deepEqual(page.tasks.map(task => task.id), [first.id]);
        assert.deepEqual(page.pending.map(task => task.id), [ids[1]]);
        assert.equal(producers[1]!.signal.aborted, false);
      } else if (ending === 'timeout') {
        const details = outcome.result.details as Snapshot & { waitOutcome: string; waitedMs: number };
        assert.equal(details.state, 'running'); assert.equal(details.waitOutcome, 'timeout'); assert.ok(details.waitedMs >= 0);
      } else if (ending === 'abort') {
        const details = outcome.result.details as { waitOutcome: string; waitedMs: number; tasks: Snapshot[] };
        assert.equal(details.waitOutcome, 'interrupted'); assert.ok(details.waitedMs >= 0); assert.equal(details.tasks[0]!.id, first.id);
      }
      else assert.match(JSON.stringify(outcome.result.content), /first final/);
      const count = partials().length;
      // A still-running producer would expose a leaked interval after return/abort.
      for (const producer of producers) producer.update(ok('after observer left').result);
      t.mock.timers.tick(1000);
      assert.equal(partials().length, count);
    } finally {
      for (const work of works) work.resolve(ok());
      await h.close();
    }
  });
}

test('multi-task waits preview both settled and pending snapshots', async () => {
  const h = await setup();
  try {
    const quick = snapshot(await h.pi.call('bash', { command: `echo quick\necho ${'q'.repeat(160)}`, __background__: 'yes' }));
    const slowRaw = `sleep 5\necho ${'s'.repeat(160)}`;
    const slow = snapshot(await h.pi.call('bash', { command: slowRaw, __background__: 'yes' }));
    const outcome = await h.pi.call('meantime', { action: 'wait', ids: [quick.id, slow.id], timeout: 0.5 });
    const details = outcome.result.details as { tasks: Snapshot[]; pending: Snapshot[] };
    assert.ok(details.tasks.length >= 1, 'the quick task settled');
    assertFull(details.tasks[0]!.command, `echo quick\necho ${'q'.repeat(160)}`, 'page.tasks[0].command');
    assert.equal(details.pending.length, 1, 'the slow task is still pending');
    assertFull(details.pending[0]!.command, slowRaw, 'page.pending[0].command');
    assert.equal((outcome.result.structuredContent as unknown as { tasks: Snapshot[] }).tasks[0]!.command, details.tasks[0]!.command,
      'structuredContent mirrors the previews');
  } finally { await h.close(); }
});

test('detached handles state why the handoff happened', async () => {
  const h = await setup();
  try {
    const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.type === 'text' ? block.text : '').join('');
    const explicit = await h.pi.call('bash', { command: 'sleep 5', __background__: 'yes' });
    assert.equal(text(explicit.result), `Meantime ${snapshot(explicit).id} running in background.`);

    const pending = h.pi.call('bash', { command: 'sleep 5' });
    await until(() => (h.instance.inspect() as { tasks: Snapshot[] }).tasks.length === 2);
    h.pi.shortcuts.get('ctrl+shift+b')!(h.pi.ctx);
    const manual = await pending;
    assert.equal(text(manual.result), `Meantime ${snapshot(manual).id} running in background (detached).`);
    assert.equal(h.pi.uiMessages.at(-1), 'Detached 1 call(s) to background.');
  } finally { await h.close(); }
});

test('auto timeout handles name the configured window', async () => {
  const h = await setup({ autoDetachMs: 250 });
  try {
    const handle = await h.pi.call('bash', { command: 'sleep 5' });
    assert.equal((handle.result.content[0] as { text: string }).text,
      `Meantime ${snapshot(handle).id} running in background (0.25s auto-detach).`);
  } finally { await h.close(); }
});

test('completion notices carry the complete command in details.tasks', async () => {
  const h = await setup();
  try {
    const raw = `echo started\necho ${'c'.repeat(200)}`;
    const handle = await h.pi.call('bash', { command: raw, __background__: 'yes' });
    assert.equal(snapshot(handle).delivery, 'background');
    await until(() => h.pi.notifications.length === 1, 4000);
    const details = h.pi.notifications[0]!.details as { tasks: { id: string; command?: string }[] };
    assert.equal(details.tasks[0]!.id, snapshot(handle).id);
    assertFull(details.tasks[0]!.command, raw, 'completion details.tasks[0].command');
    assert.match(h.pi.notifications[0]!.content, /^<system-reminder>\n[\s\S]*\n<\/system-reminder>$/);
    assert.doesNotMatch(h.pi.notifications[0]!.content, /Use meantime\(action="wait"/, 'short untruncated output omits the full-output hint');
  } finally { await h.close(); }
});

test('waiting on failed tasks is a successful wait: failure stays in the observed snapshots', async () => {
  const h = await setup();
  const gate = deferred<void>();
  h.pi.registerTool(basicTool('release', async () => {
    await gate.promise;
    return { content: [{ type: 'text', text: 'boom' }], details: undefined, structuredContent: { exit_code: 7 }, isError: true };
  }));
  try {
    const first = snapshot(await h.pi.call('release', { __background__: 'yes' }));
    const second = snapshot(await h.pi.call('release', { __background__: 'yes' }));
    gate.resolve();
    const settled = await h.pi.call('meantime', { action: 'wait', ids: [first.id, second.id], timeout: 2 });
    assert.equal(settled.isError, false, 'the wait call itself did not fail');
    const tasks = (settled.result.details as unknown as { tasks: Snapshot[] }).tasks;
    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.equal(task.state, 'failed');
      assert.equal(task.isError, true, 'the observed task keeps its failure');
      assert.equal(task.exitCode, 7);
    }
    const single = await h.pi.call('meantime', { action: 'wait', ids: [first.id], timeout: 0 });
    assert.equal(single.isError, true, 'a single-id wait returns the task result itself, error included');
  } finally { gate.resolve(); await h.close(); }
});

test('list receipts name the exit code when present and put running tasks first', async () => {
  const h = await setup();
  const gate = deferred<void>();
  h.pi.registerTool(basicTool('release', async () => {
    await gate.promise;
    return { content: [{ type: 'text', text: 'boom' }], details: undefined, structuredContent: { exit_code: 7 }, isError: true };
  }));
  try {
    const failed = snapshot(await h.pi.call('release', { __background__: 'yes' }));
    gate.resolve();
    const tasks = () => (h.instance.inspect() as unknown as { tasks: Snapshot[] }).tasks;
    await until(() => tasks().find(task => task.id === failed.id)?.state === 'failed');
    const running = snapshot(await h.pi.call('bash', { command: 'sleep 5', __background__: 'yes' }));
    const listed = await h.pi.call('meantime', { action: 'list' });
    const lines = listed.result.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : []);
    assert.match(lines[0]!, new RegExp(running.id), 'a running task leads the list');
    assert.doesNotMatch(lines[0]!, /\(exit /, 'a task without an exit code omits the field');
    assert.match(lines.find(line => line.includes(failed.id))!, /failed · exit 7/, 'the receipt names the exit code');
  } finally { gate.resolve(); await h.close(); }
});

test('list page details snapshots preserve commands while the runtime keeps the raw command', async () => {
  const h = await setup();
  try {
    const handle = await h.pi.call('bash', { command: LONG_COMMAND, __background__: 'yes' });
    const listed = await h.pi.call('meantime', { action: 'list' });
    const tasks = (listed.result.details as unknown as { tasks: Snapshot[] }).tasks;
    const entry = tasks.find(task => task.id === snapshot(handle).id)!;
    assertFull(entry.command, LONG_COMMAND, 'list details.tasks[].command');
    const raw = (h.instance.inspect() as unknown as { tasks: Snapshot[] }).tasks.find(task => task.id === entry.id)!;
    assert.equal(raw.command, LONG_COMMAND, 'projection preserves the runtime command');
    const structured = (listed.result.structuredContent as unknown as { tasks: Snapshot[] }).tasks;
    assert.equal(structured.find(task => task.id === entry.id)!.command, entry.command, 'structuredContent mirrors the previews');
    const row = listed.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').split('\n').find(line => line.includes(entry.id))!;
    assert.match(row, /echo first echo second/, 'list receipts flatten the preview onto one line');
  } finally { await h.close(); }
});
