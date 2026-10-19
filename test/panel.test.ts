import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Context, Outcome } from '../src/protocol.ts';
import { TaskRuntime } from '../src/runtime.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, fixtureBash } from './host.ts';
import { deferred, ok, sleep, until } from './helpers.ts';

test('TUI panel selects, expands, cancels, refreshes and releases resources on close and session shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = mkdtempSync(join(tmpdir(), 'meantime-panel-'));
  const pi = new FakePi();
  const work = deferred<Outcome>();
  let aborts = 0, update: ((text: string) => void) | undefined;
  const instance = install(pi, { config: validateConfig({ storageRoot: root, autoDetachMs: 0, shutdownGraceMs: 1 }),
    makeBash: () => ({ ...fixtureBash(root), async execute(_id, _args, signal, onUpdate) {
      signal?.addEventListener('abort', () => { aborts++; });
      update = text => onUpdate?.(ok(text).result);
      return (await work.promise).result;
    } }),
  });
  type Factory = Parameters<Context['ui']['custom']>[0];
  type Component = Awaited<ReturnType<Factory>>;
  let panel: Component | undefined, renders = 0, closed = 0;
  pi.ctx.ui.custom = async factory => new Promise(resolve => {
    panel = factory({ requestRender() { renders++; } } as Parameters<Factory>[0],
      { fg: (_color: string, text: string) => text } as Parameters<Factory>[1],
      {} as Parameters<Factory>[2], result => { closed++; panel?.dispose?.(); resolve(result); }) as Component;
  });
  const text = () => panel!.render(1000).join('\n');
  const command = (args = '') => pi.commands.get('bg')!(args, pi.ctx);
  try {
    await pi.emit('session_start', { type: 'session_start' });
    // Start times differ so newest-first ordering is deterministic.
    const a = await pi.call('bash', { command: 'first command', __meantime__: 'yes' });
    await sleep(2);
    const longCommand = 'npm run integration-tests -- --verbose --timeout=120000';
    const b = await pi.call('bash', { command: longCommand, __meantime__: 'yes' });
    const idA = (a.result.details as Snapshot).id, idB = (b.result.details as Snapshot).id;
    const opening = command();
    assert.match(text(), /Current session tasks/);
    assert.ok(text().indexOf(idB) < text().indexOf(idA));
    const assertElapsedVisible = () => {
      const lines = panel!.render(80);
      const rows = lines.filter(line => line.includes(idA) || line.includes(idB));
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.match(row, / \| \d+s$/);
        assert.ok(visibleWidth(row) <= 80);
      }
    };
    assertElapsedVisible();
    panel!.handleInput!('\r');
    assert.ok(text().includes(`Command: ${longCommand}`));
    assertElapsedVisible();
    const changedBefore = renders, updateSecond = update!;
    await sleep(2);
    await pi.call('bash', { command: 'third command', __meantime__: 'yes' });
    assert.ok(renders > changedBefore, 'runtime changed sink refreshes without a timer tick');
    assert.match(text(), /third command/);
    updateSecond('live progress');
    t.mock.timers.tick(1000);
    assertElapsedVisible();
    assert.match(text(), /Progress: live progress/);
    assert.ok(panel!.render(20).every(line => visibleWidth(line) <= 20));
    panel!.handleInput!('\u001b[B');
    panel!.handleInput!('\r');
    assert.match(text(), /Command: first command/);
    panel!.handleInput!('\u001b[A');
    panel!.handleInput!('c');
    assert.equal(aborts, 1);
    assert.match(text(), /cancel_requested/);
    const cancel = t.mock.method(TaskRuntime.prototype, 'cancel', () => { throw new Error('Recovered task has no live local controller'); });
    panel!.handleInput!('c');
    assert.match(text(), /Recovered task has no live local controller/);
    cancel.mock.restore();
    panel!.handleInput!('q'); await opening;
    assert.equal(closed, 1);
    let before = renders;
    t.mock.timers.tick(2000); assert.equal(renders, before, 'closed panel has no timer');
    work.resolve(ok('recent output'));
    await until(() => (instance.inspect() as { tasks: Snapshot[] }).tasks.every(task => !task.localRunning));
    assert.equal(renders, before, 'closed panel has no changed sink listener');

    const reopened = command('status');
    panel!.handleInput!('\r');
    assert.match(text(), /recent output/); assert.doesNotMatch(text(), /Output:/);
    panel!.handleInput!('\u001b'); await reopened;
    assert.equal(closed, 2);

    const stopped = command();
    await pi.emit('session_shutdown', { type: 'session_shutdown' }); await stopped;
    assert.equal(closed, 3);
    before = renders; t.mock.timers.tick(2000);
    assert.equal(renders, before, 'session stop closes the open panel and its timer');
  } finally {
    work.resolve(ok()); await instance.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['print', 'json'] as const) test(`${mode} status keeps the text snapshot, never opens custom UI`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'meantime-text-'));
  const pi = new FakePi('A', mode);
  const instance = install(pi, { config: validateConfig({ storageRoot: root }), makeBash: fixtureBash });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    await pi.commands.get('meantime')!('status', pi.ctx);
    assert.equal(pi.uiMessages.at(-1), 'Latest background control:\nCurrent session tasks (none):\n\nCancel: /meantime cancel <id>; output: ask meantime(action="result", id=...).\nActive proxies: 0; warnings: 0.');
  } finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
});
