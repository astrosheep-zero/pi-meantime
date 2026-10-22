import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, basicTool } from './host.ts';
import { FixtureMcpClient } from './mcp-client.ts';
import { sleep, until } from './helpers.ts';

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-mcp-')); const client = new FixtureMcpClient(); const pi = new FakePi();
  const tools = await client.connect();
  for (const tool of tools) pi.registerTool(basicTool(`mcp__fixture__${tool.name}`,
    (_id, args, signal) => client.call(tool.name, args, signal), { parameters: tool.inputSchema }));
  const extension = install(pi, { config: validateConfig({ autoDetachMs: 0, notifyDebounceMs: 2, shutdownGraceMs: 30 }), connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  return { root, client, pi, async close() { await extension.dispose(); await client.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('real JSON-RPC stdio MCP call is dispatched once, detached, and collected with clean business args', async () => {
  const h = await harness();
  try {
    const outcome = await h.pi.call('mcp__fixture__slow', { ms: 70, text: 'WIRE_DONE', __background__: 'yes' });
    assert.equal(outcome.isError, false);
    const task = (outcome.result.structuredContent as { task: unknown }).task as Snapshot;
    assert.equal(task.state, 'running');
    await until(() => h.pi.notifications.length === 1);
    const result = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [task.id ]});
    assert.match(JSON.stringify(result.result), /WIRE_DONE/);
    const requests = h.client.sent.filter(m => m.method === 'tools/call'); assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(requests[0]).includes('__background__'));
  } finally { await h.close(); }
});
test('cancelled MCP request keeps its native error without classifying remote execution', async () => {
  const h = await harness(); const marker = join(h.root, 'side-effect.txt');
  try {
    const outcome = await h.pi.call('mcp__fixture__stubborn', { ms: 150, marker, __background__: 'yes' });
    const task = (outcome.result.structuredContent as { task: unknown }).task as Snapshot;
    const cancelled = await h.pi.call('meantime', { action: 'cancel', ids: [task.id ]});
    assert.equal(cancelled.isError, true);
    assert.match(JSON.stringify(cancelled.result.content), /MCP request cancelled locally/);
    assert.equal((cancelled.result.details as { task: Snapshot }).task.notification, 'observed');
    await sleep(20);
    assert.equal(h.pi.notifications.length, 0);
    const status = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [task.id ]});
    assert.equal(((status.result.structuredContent as { task: unknown }).task as Snapshot).state, 'cancelled');
    await until(() => existsSync(marker)); assert.equal(readFileSync(marker, 'utf8'), 'REMOTE_SIDE_EFFECT_COMPLETED');
    assert.equal(h.client.sent.filter(m => m.method === 'tools/call').length, 1);
    assert.equal(h.client.sent.filter(m => m.method === 'notifications/cancelled').length, 1);
  } finally { await h.close(); }
});
test('foreground server failure preserves its native error without a retained task', async () => {
  const h = await harness();
  try {
    const outcome = await h.pi.call('mcp__fixture__fail', { ms: 1 });
    assert.equal(outcome.isError, true);
    assert.ok(!(outcome.result.structuredContent as { task?: unknown } | undefined)?.task);
    const list = await h.pi.call('meantime', { action: 'list' });
    assert.equal((list.result.structuredContent as unknown as { tasks: Snapshot[] }).tasks.length, 0);
    assert.equal(h.pi.entries.length, 0);
  } finally { await h.close(); }
});
