import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { TaskRuntime } from '../src/runtime.ts';
import type { Config } from '../src/config.ts';
import type { Content, Outcome, Result, Tool } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { FakePi, basicTool, fixtureBash } from './host.ts';
import { deferred, ok, sleep, until } from './helpers.ts';

export async function setup(tools: Tool[] = [], config: Partial<Config> = {}, mode: 'tui' | 'print' = 'tui') {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-adapter-')); const pi = new FakePi('A', mode);
  for (const tool of tools) pi.registerTool(tool);
  const instance = install(pi, { config: validateConfig({ storageRoot: root, autoDetachMs: 0, notifyDebounceMs: 5, shutdownGraceMs: 15, ...config }), makeBash: fixtureBash });
  await pi.emit('session_start', { type: 'session_start' }); await sleep(1); pi.refresh();
  return { pi, instance, root, async close() { await instance.dispose(); rmSync(root, { recursive: true, force: true }); } };
}
function snapshot(outcome: Outcome): Snapshot {
  const value = outcome.result.structuredContent as { task: unknown }; return value.task as Snapshot;
}

test('model sees schema-preserving proxies; originals stay internally callable and disappear from direct declarations', async () => {
  const original = basicTool('mcp__test__search', undefined, { parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } });
  const h = await setup([original]);
  try {
    assert.ok(h.pi.modelTools().includes('mcp__test__search_mt')); assert.ok(!h.pi.modelTools().includes(original.name));
    assert.ok(h.pi.callable().some(t => t.name === original.name));
    assert.ok(h.pi.definitions.get(original.name + '_mt')!.parameters);
    assert.equal(h.pi.registrations, 4); // original, bash, meantime, proxy
    for (let i = 0; i < 10; i++) { h.pi.refresh(); await sleep(0); }
    assert.equal(h.pi.registrations, 4); // no registration feedback loop
  } finally { await h.close(); }
});

test('codemode/deferred proxies inherit exposure and dispatch through the real original', async () => {
  const seen: string[] = [];
  const tool = (name: string, exposure: 'codemode' | 'deferred') => basicTool(name, async (_id, args) => {
    seen.push(`${name}:${String(args.query)}`);
    return ok(`RESULT:${String(args.query)}`).result;
  }, { exposure, parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } });
  const h = await setup([
    tool('mcp__private__search', 'codemode'),
    tool('mcp__private__deferred', 'deferred'),
    basicTool('mcp__private__direct'),
  ]);
  try {
    const visible = h.pi.modelTools();
    assert.ok(visible.includes('mcp__private__direct_mt'));
    for (const [name, exposure] of [['mcp__private__search', 'codemode'], ['mcp__private__deferred', 'deferred']] as const) {
      const proxy = h.pi.definitions.get(name + '_mt');
      assert.equal(proxy?.exposure, exposure);
      assert.ok(!visible.includes(name), 'original not promoted to direct');
      assert.ok(!visible.includes(name + '_mt'), 'proxy not promoted to direct');
      assert.ok(h.pi.callable().some(t => t.name === name), 'original still callable');
      assert.ok(h.pi.callable().some(t => t.name === name + '_mt'), 'proxy available to codemode/tool_search');
      assert.deepEqual(proxy?.parameters.required, ['query']);
      const output = await h.pi.call(name + '_mt', { query: exposure, __meantime__: 'no' });
      assert.equal(output.isError, false);
      assert.match(JSON.stringify(output.result), new RegExp(`RESULT:${exposure}`));
      const raw = await h.pi.call(name, { query: 'raw' });
      assert.equal(raw.isError, true, 'direct calls to original rejected when blocking enabled');
    }
    assert.deepEqual(seen, ['mcp__private__search:codemode', 'mcp__private__deferred:deferred']);
  } finally { await h.close(); }
});

test('codemode script can call codemode _mt proxy but not the unwrapped original', async () => {
  const original = basicTool('mcp__private__slow', async () => ok('CODERESULT').result, { exposure: 'codemode' });
  const caller = basicTool('codemode_fixture', async (_id, args, _s, _u, ctx) => {
    return (await ctx.executeTool(String(args.target), { __meantime__: 'no' })).result;
  }, { parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } });
  const h = await setup([original, caller]);
  try {
    const viaProxy = await h.pi.call('codemode_fixture', { target: original.name + '_mt' });
    assert.equal(viaProxy.isError, false);
    assert.match(JSON.stringify(viaProxy.result), /CODERESULT/);
    const bypass = await h.pi.call('codemode_fixture', { target: original.name });
    assert.equal(bypass.isError, true);
  } finally { await h.close(); }
});

test('exposure changes preserve visibility without reusing stale proxy definitions', async () => {
  const name = 'mcp__exposure__echo';
  const h = await setup([basicTool(name, undefined, { exposure: 'codemode' })]);
  try {
    assert.equal(h.pi.definitions.get(name + '_mt')?.exposure, 'codemode');
    h.pi.registerTool(basicTool(name, undefined, { exposure: 'deferred' })); await sleep(2);
    assert.equal(h.pi.definitions.get(name + '_mt')?.exposure, 'deferred');
    h.pi.registerTool(basicTool(name, undefined, { exposure: 'direct' })); await sleep(2);
    assert.equal(h.pi.definitions.get(name + '_mt')?.exposure, 'direct');
    assert.ok(h.pi.modelTools().includes(name + '_mt'));
    assert.ok(!h.pi.modelTools().includes(name));
    h.pi.registerTool(basicTool(name, undefined, { exposure: 'hidden' })); await sleep(2);
    assert.equal(h.pi.definitions.get(name + '_mt')?.exposure, 'hidden');
  } finally { await h.close(); }
});

test('business args are stripped correctly and the original permission hooks still execute', async () => {
  let seen: unknown; let allowedChecks = 0;
  const h = await setup([basicTool('mcp__t__echo', async (_id, args) => { seen = args; return ok('echo').result; }, { parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } })]);
  h.pi.on('tool_call', event => { if (event.toolName === 'mcp__t__echo') allowedChecks++; });
  try {
    const out = await h.pi.call('mcp__t__echo_mt', { text: 'hello', __meantime__: 'no' });
    assert.equal(out.isError, false); assert.deepEqual(seen, { text: 'hello' }); assert.equal(allowedChecks, 1);
    assert.ok(h.pi.trace.some(e => e.type === 'execute' && e.name === 'mcp__t__echo' && e.id!.includes('/')));
  } finally { await h.close(); }
});
test('original validation, permission rejection and result redaction are preserved', async () => {
  let executed = 0;
  const h = await setup([basicTool('mcp__t__secret', async () => { executed++; return ok('secret').result; })]);
  const dispose = h.pi.on('tool_call', e => e.toolName === 'mcp__t__secret' ? { block: true, reason: 'permission denied' } : undefined);
  try {
    assert.equal((await h.pi.call('mcp__t__secret_mt', { bad: 1 })).isError, true);
    const denied = await h.pi.call('mcp__t__secret_mt', {}); assert.equal(denied.isError, true); assert.equal(executed, 0);
    dispose();
    h.pi.after.push((name, result) => name === 'mcp__t__secret' ? { ...result, content: [{ type: 'text', text: 'REDACTED' }], structuredContent: null } : result);
    const out = await h.pi.call('mcp__t__secret_mt', {}); assert.equal(out.isError, false);
    assert.match(JSON.stringify(out.result), /REDACTED/); assert.equal(executed, 1);
  } finally { await h.close(); }
});
test('raw original and unrelated codemode-style nested bypasses are blocked', async () => {
  const target = basicTool('mcp__t__echo');
  const caller = basicTool('codemode_fixture', async (_id, _args, _s, _u, ctx) => (await ctx.executeTool(target.name, {})).result);
  const h = await setup([target, caller]);
  try {
    assert.equal((await h.pi.call(target.name, {})).isError, true);
    assert.equal((await h.pi.call(caller.name, {})).isError, true);
    assert.equal((await h.pi.call(target.name + '_mt', {})).isError, false);
  } finally { await h.close(); }
});
test('model explicit background continues in parallel with another tool and finishes once', async () => {
  const work = deferred<Result>();
  const h = await setup([basicTool('mcp__t__slow', () => work.promise), basicTool('local_fast')]);
  try {
    const out = await h.pi.call('mcp__t__slow_mt', { __meantime__: 'yes' }); const task = snapshot(out);
    assert.equal(task.delivery, 'background'); assert.equal(task.state, 'running');
    const fast = await h.pi.call('local_fast', {}); assert.equal(fast.isError, false);
    work.resolve(ok('slow result').result); await until(() => h.pi.notifications.length === 1);
    assert.match(h.pi.notifications[0]!.content, /<untrusted-output-tail>\nslow result\n<\/untrusted-output-tail>/);
    assert.match(task.id, /^mt_[a-f0-9]{8}$/);
    const byPrefix = await h.pi.call('meantime', { action: 'status', id: task.id.slice(3, 9) });
    assert.equal(byPrefix.isError, false); assert.match(JSON.stringify(byPrefix.result), new RegExp(task.id));
    const result = await h.pi.call('meantime', { action: 'result', id: task.id });
    assert.match(JSON.stringify(result.result), /slow result/); assert.equal(result.isError, false);
    assert.equal(h.pi.trace.filter(e => e.type === 'execute' && e.name === 'mcp__t__slow').length, 1);
  } finally { work.resolve(ok().result); await h.close(); }
});
test('steer releases foreground without abort or consuming text/images', async () => {
  const work = deferred<Result>(); let childSignal: AbortSignal | undefined;
  const h = await setup([basicTool('mcp__t__slow', (_id, _a, signal) => { childSignal = signal; return work.promise; })]);
  try {
    const running = h.pi.call('mcp__t__slow_mt', {}); await until(() => !!childSignal);
    const images: Content[] = [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }];
    const event = { type: 'input' as const, text: 'change direction', streamingBehavior: 'steer' as const, source: 'interactive' as const, images };
    const responses = await h.pi.emit('input', event); const out = await running;
    assert.equal(snapshot(out).detachReason, 'steer'); assert.equal(childSignal!.aborted, false);
    assert.ok(responses.some(r => JSON.stringify(r) === '{"action":"continue"}'));
    assert.deepEqual(event.images, images); assert.equal(h.pi.abortCalls, 0);
  } finally { work.resolve(ok().result); await h.close(); }
});
test('disabled steer detach keeps input intact; explicit detach still works', async () => {
  const work = deferred<Result>();
  const h = await setup([basicTool('mcp__t__slow', () => work.promise)], { detachOnSteer: false });
  try {
    let settled = false;
    const running = h.pi.call('mcp__t__slow_mt', {}).then(out => { settled = true; return out; });
    await until(() => h.pi.trace.some(t => t.type === 'execute' && t.name === 'mcp__t__slow'));
    const event = { type: 'input' as const, text: 'next', source: 'rpc' as const, streamingBehavior: 'steer' as const };
    assert.deepEqual(await h.pi.emit('input', event), [{ action: 'continue' }]);
    await sleep(5); assert.equal(settled, false);
    await h.pi.commands.get('bg')!('detach', h.pi.ctx);
    assert.equal(snapshot(await running).delivery, 'background');
    assert.throws(() => validateConfig({ detachOnSteer: 'false' }), /detachOnSteer/);
  } finally { work.resolve(ok().result); await h.close(); }
});
test('shortcut and auto timer both release managed waiters', async () => {
  for (const trigger of ['shortcut', 'timeout'] as const) {
    const work = deferred<Result>(); const h = await setup([basicTool('mcp__t__slow', () => work.promise)], { autoDetachMs: trigger === 'timeout' ? 10 : 0 });
    try {
      const running = h.pi.call('mcp__t__slow_mt', {});
      await until(() => h.pi.trace.some(t => t.type === 'execute' && t.name === 'mcp__t__slow'));
      if (trigger === 'shortcut') await h.pi.shortcuts.get('ctrl+shift+b')!(h.pi.ctx);
      assert.equal(snapshot(await running).detachReason, trigger);
    } finally { work.resolve(ok().result); await h.close(); }
  }
});
test('late registration, schema replacement, disappearance and reappearance are reconciled', async () => {
  const h = await setup();
  try {
    const name = 'mcp__late__echo'; h.pi.registerTool(basicTool(name)); await sleep(1); h.pi.refresh();
    assert.ok(h.pi.modelTools().includes(name + '_mt'));
    const changed = basicTool(name, undefined, { parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } });
    h.pi.registerTool(changed); await sleep(1);
    assert.deepEqual(h.pi.definitions.get(name + '_mt')!.parameters.required, ['message']);
    h.pi.registerTool({ ...changed, exposure: 'hidden' }); await sleep(1);
    assert.equal(h.pi.definitions.get(name + '_mt')!.exposure, 'hidden');
    h.pi.registerTool({ ...changed, exposure: 'direct' }); await sleep(1);
    assert.equal(h.pi.definitions.get(name + '_mt')!.exposure, 'direct');
  } finally { await h.close(); }
});
test('schema/name collisions leave originals visible, never overwrite unrelated tools', async () => {
  const name = 'mcp__t__collision'; const blocked = basicTool(name, undefined, { parameters: { type: 'object', properties: { __meantime__: { type: 'number' } } } });
  const claimed = basicTool('mcp__t__claimed_mt', undefined, { description: 'Owned by another extension' });
  const h = await setup([blocked, basicTool('mcp__t__claimed'), claimed]);
  try {
    assert.ok(h.pi.modelTools().includes(name)); assert.ok(h.pi.modelTools().includes('mcp__t__claimed'));
    assert.equal(h.pi.definitions.get(claimed.name)!.description, claimed.description);
  } finally { await h.close(); }
});
test('model-only, disabled, sequential and excluded file tools remain outside wrapper policy', async () => {
  const h = await setup([
    basicTool('mcp__t__seq', undefined, { executionMode: 'sequential' }),
    basicTool('mcp__t__ask', undefined, { exposure: 'model-only' }),
    basicTool('mcp__t__off', undefined, { exposure: 'hidden' }), basicTool('write'),
  ], { include: ['*'] });
  try {
    for (const name of ['mcp__t__seq', 'mcp__t__ask', 'mcp__t__off', 'write']) assert.ok(!h.pi.modelTools().includes(name + '_mt'));
  } finally { await h.close(); }
});
test('session switch suppresses callbacks and isolates task lookup', async () => {
  const work = deferred<Result>(); const h = await setup([basicTool('mcp__t__slow', () => work.promise)]);
  try {
    const out = await h.pi.call('mcp__t__slow_mt', { __meantime__: 'yes' }); const id = snapshot(out).id;
    await h.pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'switch' });
    h.pi.ctx = new FakePi('B').ctx; await h.pi.emit('session_start', { type: 'session_start' });
    work.resolve(ok().result); await until(() => TaskRuntime.liveProducerCount() === 0);
    assert.equal(h.pi.notifications.length, 0);
    assert.equal((await h.pi.call('meantime', { action: 'status', id })).isError, true);
  } finally { work.resolve(ok().result); await h.close(); }
});
test('real shell fixture runs, can detach without a second spawn, and result is retained', async () => {
  const h = await setup();
  try {
    const command = `node -e 'setTimeout(()=>console.log("SHELL_DONE"),80)'\n# ${'long comment '.repeat(20)}`;
    const out = await h.pi.call('bash', { command, __meantime__: 'yes' });
    const task = snapshot(out); assert.equal(task.state, 'running');
    assert.equal(task.command, command);
    const list = await h.pi.call('meantime', { action: 'list' });
    const preview = (list.result.details as { tasks: Snapshot[] }).tasks[0]!.command!;
    assert.ok(preview.endsWith('…')); assert.ok(!preview.includes('\n'));
    await until(() => h.pi.notifications.length === 1);
    assert.ok(h.pi.notifications[0]!.content.includes(preview));
    const status = await h.pi.call('meantime', { action: 'status', id: task.id });
    assert.equal((status.result.details as Snapshot).command, command);
    const result = await h.pi.call('meantime', { action: 'result', id: task.id });
    assert.match(JSON.stringify(result.result), /SHELL_DONE/);
  } finally { await h.close(); }
});
test('print mode auto waits and explicit background returns a truthful error', async () => {
  const h = await setup([basicTool('mcp__t__one')], {}, 'print');
  try {
    assert.equal((await h.pi.call('mcp__t__one_mt', { __meantime__: 'yes' })).isError, true);
    assert.equal((await h.pi.call('mcp__t__one_mt', {})).isError, false);
  } finally { await h.close(); }
});

test('initial loading does not touch runtime-only settings through the Bash factory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-load-')); const pi = new FakePi(); let bound = false; let calls = 0;
  const instance = install(pi, { config: validateConfig({ storageRoot: root }), baseBash: fixtureBash(root),
    makeBash(cwd) { assert.ok(bound, 'factory invoked before Pi runtime binding'); calls++; return fixtureBash(cwd); },
  });
  try {
    assert.equal(calls, 0); bound = true;
    await pi.emit('session_start', { type: 'session_start' });
    assert.equal((await pi.call('bash', { command: 'printf LOAD_OK' })).isError, false); assert.equal(calls, 1);
  } finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
});
test('a later extension claiming a proxy name is never overwritten by the tombstone path', async () => {
  const h = await setup([basicTool('mcp__t__one')]);
  try {
    h.pi.registerTool(basicTool('mcp__t__one_mt', undefined, { description: 'Foreign replacement' }));
    await sleep(1); h.pi.refresh();
    assert.equal(h.pi.definitions.get('mcp__t__one_mt')!.description, 'Foreign replacement');
    assert.ok(h.pi.modelTools().includes('mcp__t__one'));
  } finally { await h.close(); }
});
test('changing a supported schema to a composed schema withdraws only our proxy', async () => {
  const h = await setup([basicTool('mcp__t__one')]);
  try {
    h.pi.registerTool(basicTool('mcp__t__one', undefined, { parameters: { type: 'object', allOf: [] } }));
    await sleep(1); assert.equal(h.pi.definitions.get('mcp__t__one_mt')!.exposure, 'hidden');
    assert.ok(h.pi.modelTools().includes('mcp__t__one'));
  } finally { await h.close(); }
});
test('polling reconciles a tool that disappears without a public registry-change event', async () => {
  const h = await setup([basicTool('mcp__t__one')], { reconcileMs: 100 });
  try {
    h.pi.definitions.delete('mcp__t__one'); h.pi.active.delete('mcp__t__one');
    await until(() => h.pi.definitions.get('mcp__t__one_mt')!.exposure === 'hidden');
  } finally { await h.close(); }
});
test('global nested sequential queue is respected; a queued request cannot claim to be detached early', async () => {
  const a = deferred<Result>(); const b = deferred<Result>();
  const h = await setup([basicTool('mcp__t__a', () => a.promise), basicTool('mcp__t__b', () => b.promise)]);
  h.pi.sequentialNested = true;
  try {
    const first = await h.pi.call('mcp__t__a_mt', { __meantime__: 'yes' }); assert.equal(snapshot(first).state, 'running');
    let returned = false;
    const second = h.pi.call('mcp__t__b_mt', { __meantime__: 'yes' }).then(result => { returned = true; return result; });
    await sleep(15); assert.equal(returned, false);
    a.resolve(ok().result); const next = await second; assert.equal(snapshot(next).state, 'running');
  } finally { a.resolve(ok().result); b.resolve(ok().result); await h.close(); }
});
test('management results are paginated rather than dumping the full registry into model context', async () => {
  const h = await setup([basicTool('mcp__t__one', async () => { await sleep(10); return ok().result; })]);
  try {
    for (let i = 0; i < 12; i++) {
      await h.pi.call('mcp__t__one_mt', { __meantime__: 'yes' });
      await until(() => TaskRuntime.liveProducerCount() === 0);
    }
    const page = await h.pi.call('meantime', { action: 'list', limit: 5 });
    const value = page.result.structuredContent as { tasks: unknown[]; next_offset: number; total: number };
    assert.equal(value.tasks.length, 5); assert.equal(value.next_offset, 5); assert.equal(value.total, 12);
  } finally { await h.close(); }
});
test('multi-task wait exposes settled and pending tasks, validates ids, and shares one inline text budget', async () => {
  const a = deferred<Result>(), b = deferred<Result>();
  const h = await setup([basicTool('mcp__t__a', () => a.promise), basicTool('mcp__t__b', () => b.promise)]);
  try {
    const first = snapshot(await h.pi.call('mcp__t__a_mt', { __meantime__: 'yes' }));
    const second = snapshot(await h.pi.call('mcp__t__b_mt', { __meantime__: 'yes' }));
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [first.id.slice(3), second.id], mode: 'any' });
    a.resolve(ok('A'.repeat(20 * 1024)).result);
    const any = await waiting;
    assert.equal(any.isError, false);
    const value = any.result.structuredContent as { tasks: { id: string; result_available: boolean }[]; pending: { id: string }[] };
    assert.deepEqual(value.tasks.map(task => [task.id, task.result_available]), [[first.id, true]]);
    assert.deepEqual(value.pending.map(task => task.id), [second.id]);
    assert.match(JSON.stringify(any.result.content), new RegExp(`Pending: ${second.id}`));
    for (const args of [{}, { id: first.id, ids: [second.id] }, { ids: [] }, { ids: [first.id, 'missing'] }]) {
      const invalid = await h.pi.call('meantime', { action: 'wait', ...args });
      assert.equal(invalid.isError, true);
    }
    const timedOut = await h.pi.call('meantime', { action: 'wait', ids: [first.id, second.id], timeout_ms: 5 });
    assert.equal((timedOut.result.structuredContent as typeof value).pending[0]!.id, second.id);
    b.resolve(ok('B'.repeat(20 * 1024)).result);
    const all = await h.pi.call('meantime', { action: 'wait', ids: [second.id, first.id] });
    assert.deepEqual((all.result.structuredContent as typeof value).tasks.map(task => task.id), [second.id, first.id]);
    assert.deepEqual((all.result.structuredContent as typeof value).pending, []);
    const blocks = all.result.content.filter(block => block.type === 'text').map(block => block.text);
    assert.equal(blocks.filter(text => /^(A+|B+)$/.test(text)).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0), 32 * 1024);
    const text = blocks.join('\n');
    assert.ok(text.indexOf(`Task ${second.id}`) < text.indexOf(`Task ${first.id}`));
    const single = await h.pi.call('meantime', { action: 'wait', id: first.id });
    assert.equal(snapshot(single).id, first.id);
    assert.equal((single.result.structuredContent as { result_available: boolean }).result_available, true);
  } finally { a.resolve(ok().result); b.resolve(ok().result); await h.close(); }
});
