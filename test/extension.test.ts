import assert from 'node:assert/strict';
import { test } from 'node:test';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Outcome } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi } from './host.ts';
import { until } from './helpers.ts';

async function setup(config: Partial<Config> = {}) {
  const pi = new FakePi('A', 'tui');
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, notifyDebounceMs: 5, shutdownGraceMs: 15, ...config }), connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  return { pi, instance, async close() { await instance.dispose(); } };
}
function snapshot(outcome: Outcome): Snapshot {
  return (outcome.result.structuredContent as unknown as { task: Snapshot }).task;
}
// A multi-line command long enough to require the 120-byte ellipsis.
const LONG_COMMAND = `echo first\necho second\necho ${'x'.repeat(200)}`;
const normalized = (command: string) => command.replace(/\s+/g, ' ').trim();
function assertPreview(command: string | undefined, raw: string, what: string): void {
  assert.ok(command, `${what}: command is present`);
  assert.ok(Buffer.byteLength(command!) <= 123, `${what}: preview stays within 120 UTF-8 bytes plus ellipsis`);
  assert.notEqual(command, raw, `${what}: the raw command is not leaked wholesale`);
  assert.ok(command!.endsWith('…'), `${what}: truncation is visible`);
  const kept = command!.slice(0, -1);
  assert.ok(raw.startsWith(kept), `${what}: preview is the raw command prefix, line breaks intact`);
  if (kept.includes('\n')) assert.notEqual(normalized(kept), kept, `${what}: multi-line preview is not flattened`);
}

test('background handles carry the truncated command in details and structuredContent', async () => {
  const h = await setup();
  try {
    const handle = await h.pi.call('bash', { command: LONG_COMMAND, __background__: 'yes' });
    assert.equal(handle.isError, false);
    const task = snapshot(handle);
    assert.equal(task.delivery, 'background');
    const details = handle.result.details as Snapshot;
    assertPreview(details.command, LONG_COMMAND, 'handle details.command');
    assert.ok(details.command!.includes('\n'), 'multi-line preview keeps its line breaks');
    const structured = handle.result.structuredContent as unknown as { task: { command?: string } };
    assert.equal(structured.task.command, details.command, 'structuredContent mirrors the same preview');
  } finally { await h.close(); }
});

test('meantime wait streams an immediate partial snapshot of its targets', async () => {
  const h = await setup();
  try {
    const handle = await h.pi.call('bash', { command: LONG_COMMAND.replace('echo second', 'sleep 0.4 && echo second'), __background__: 'yes' });
    const task = snapshot(handle);
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [task.id], timeout: 2 });
    await until(() => h.pi.updates.some(update => Array.isArray((update.details as { tasks?: unknown } | undefined)?.tasks)), 1000);
    const partial = h.pi.updates.map(update => update.details as { tasks?: { id: string; tool: string; state: string; command?: string; createdAt?: number }[] } | undefined)
      .find(details => Array.isArray(details?.tasks))!;
    assert.ok(Array.isArray(partial.tasks), 'the partial update carries task snapshots');
    const preview = partial.tasks![0]!;
    assert.equal(preview.id, task.id);
    assert.equal(preview.tool, 'bash');
    assert.equal(preview.state, 'waiting', 'the target is named before the wait resolves');
    assert.equal(typeof preview.createdAt, 'number');
    assertPreview(preview.command, LONG_COMMAND.replace('echo second', 'sleep 0.4 && echo second'), 'streamed details.tasks[0].command');
    const settled = await waiting;
    assert.equal(settled.isError, false);
    const final = settled.result.details as { task: Snapshot };
    assertPreview(final.task.command, LONG_COMMAND.replace('echo second', 'sleep 0.4 && echo second'), 'settled wait details.task.command');
  } finally { await h.close(); }
});

test('multi-task waits preview both settled and pending snapshots', async () => {
  const h = await setup();
  try {
    const quick = snapshot(await h.pi.call('bash', { command: `echo quick\necho ${'q'.repeat(160)}`, __background__: 'yes' }));
    const slowRaw = `sleep 5\necho ${'s'.repeat(160)}`;
    const slow = snapshot(await h.pi.call('bash', { command: slowRaw, __background__: 'yes' }));
    const outcome = await h.pi.call('meantime', { action: 'wait', ids: [quick.id, slow.id], timeout: 0.5 });
    const details = outcome.result.details as { tasks: Snapshot[]; pending: Snapshot[] };
    assert.ok(details.tasks.length >= 1, 'the quick task settled');
    assertPreview(details.tasks[0]!.command, `echo quick\necho ${'q'.repeat(160)}`, 'page.tasks[0].command');
    assert.equal(details.pending.length, 1, 'the slow task is still pending');
    assertPreview(details.pending[0]!.command, slowRaw, 'page.pending[0].command');
    assert.equal((outcome.result.structuredContent as unknown as { tasks: Snapshot[] }).tasks[0]!.command, details.tasks[0]!.command,
      'structuredContent mirrors the previews');
  } finally { await h.close(); }
});

test('completion notices carry the truncated command in details.tasks', async () => {
  const h = await setup();
  try {
    const raw = `echo started\necho ${'c'.repeat(200)}`;
    const handle = await h.pi.call('bash', { command: raw, __background__: 'yes' });
    assert.equal(snapshot(handle).delivery, 'background');
    await until(() => h.pi.notifications.length === 1, 4000);
    const details = h.pi.notifications[0]!.details as { tasks: { id: string; command?: string }[] };
    assert.equal(details.tasks[0]!.id, snapshot(handle).id);
    assertPreview(details.tasks[0]!.command, raw, 'completion details.tasks[0].command');
  } finally { await h.close(); }
});

test('list page details previews keep line breaks while the runtime keeps the raw command', async () => {
  const h = await setup();
  try {
    const handle = await h.pi.call('bash', { command: LONG_COMMAND, __background__: 'yes' });
    const listed = await h.pi.call('meantime', { action: 'list' });
    const tasks = (listed.result.details as unknown as { tasks: Snapshot[] }).tasks;
    const entry = tasks.find(task => task.id === snapshot(handle).id)!;
    assertPreview(entry.command, LONG_COMMAND, 'list details.tasks[].command');
    const raw = (h.instance.inspect() as unknown as { tasks: Snapshot[] }).tasks.find(task => task.id === entry.id)!;
    assert.equal(raw.command, LONG_COMMAND, 'truncation is a projection, not a runtime mutation');
    const structured = (listed.result.structuredContent as unknown as { tasks: Snapshot[] }).tasks;
    assert.equal(structured.find(task => task.id === entry.id)!.command, entry.command, 'structuredContent mirrors the previews');
    const row = listed.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').split('\n').find(line => line.includes(entry.id))!;
    assert.match(row, /echo first echo second/, 'list receipts flatten the preview onto one line');
  } finally { await h.close(); }
});
