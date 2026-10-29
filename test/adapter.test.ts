import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { ToolRenderers } from '@earendil-works/pi-coding-agent';
import { Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../src/extension.ts';
import { renderTaskResult } from '../src/render.ts';
import { validateConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Content, Outcome, Result, Tool } from '../src/protocol.ts';
import type { Snapshot } from '../src/runtime.ts';
import { TaskRuntime } from '../src/runtime.ts';
import { FakePi, basicTool } from './host.ts';
import { deferred, ok, sleep, until } from './helpers.ts';

async function setup(tools: Tool[] = [], config: Partial<Config> = {}, mode: 'tui' | 'print' = 'tui') {
  const pi = new FakePi('A', mode);
  for (const tool of tools) pi.registerTool(tool);
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, explicitDetachMs: 0, notifyDebounceMs: 5, shutdownGraceMs: 15, ...config }), connect: () => pi });
  await pi.emit('session_start', { type: 'session_start' });
  return { pi, instance, async close() { await instance.dispose(); } };
}
function snapshot(outcome: Outcome): Snapshot {
  return (outcome.result.structuredContent as { task: unknown }).task as Snapshot;
}

test('one original name, schema-preserving control and a single shared execution policy', async () => {
  const original = basicTool('mcp__fixture', undefined, { parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } });
  const nativeParameters = original.parameters, nativeExecute = original.execute;
  const h = await setup([original], { autoDetachMs: 1750 });
  try {
    assert.deepEqual(h.pi.modelTools().sort(), ['bash', 'mcp__fixture', 'meantime']);
    assert.equal(h.pi.definitions.get(original.name), original);
    assert.equal(original.description, 'Fixture mcp__fixture');
    assert.deepEqual(original.parameters.required, ['q']);
    assert.equal(original.parameters.additionalProperties, false);
    assert.deepEqual((original.parameters.properties as Record<string, unknown>).__background__, { type: 'string', enum: ['auto', 'yes', 'no'] });
    const registrations = h.pi.registrations;
    for (let i = 0; i < 10; i++) h.pi.refresh();
    assert.equal(h.pi.registrations, registrations, 'no registration or reconciliation feedback loop');
    const event = { type: 'before_agent_start' as const, systemPromptOptions: { sections: {} as Record<string, string> } };
    await h.pi.emit('before_agent_start', event);
    assert.match(event.systemPromptOptions.sections.meantime!, /"auto" \(default; moves to background if not finished in time\)/);
    assert.match(event.systemPromptOptions.sections.meantime!, /"yes" \(run in background\)/);
    assert.match(event.systemPromptOptions.sections.meantime!, /"no" \(stay in foreground\)/);
    assert.match(event.systemPromptOptions.sections.meantime!, /Background tasks notify automatically when done/);
    assert.doesNotMatch(JSON.stringify(h.pi.getAllTools()) + JSON.stringify(event), /_mt/);
  } finally { await h.close(); }
  assert.equal(original.parameters, nativeParameters); assert.equal(original.execute, nativeExecute);
  assert.equal(Object.hasOwn(original, 'prepareArguments'), false);
});

test('codemode/deferred original definitions retain exposure, source, metadata and native preparation', async () => {
  let prepares = 0, checks = 0, effects = 0;
  const seen: unknown[] = [];
  const tools = (['codemode', 'deferred'] as const).map(exposure => basicTool(`mcp__${exposure}`, async (_id, args) => {
    effects++; seen.push(args); return ok(exposure).result;
  }, { exposure, namespace: { name: 'fixture' }, sourceInfo: { path: '/owner' }, annotations: { readOnlyHint: true },
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
    prepareArguments(raw) { prepares++; assert.ok(typeof raw === 'object'); assert.equal('__background__' in raw!, false); return { ...raw as object, n: 2 }; },
  }));
  const h = await setup(tools);
  h.pi.on('tool_call', event => { if (event.toolName.startsWith('mcp__')) { checks++; event.input.extra = 'permission mutation'; } });
  try {
    for (const tool of tools) {
      assert.ok(!h.pi.modelTools().includes(tool.name));
      assert.ok(h.pi.callable().includes(tool));
      assert.equal(tool.namespace?.name, 'fixture'); assert.equal(tool.sourceInfo?.path, '/owner');
      const result = await h.pi.call(tool.name, { n: 'repaired', __background__: 'no' });
      assert.equal(result.isError, false);
    }
    assert.equal(prepares, 2); assert.equal(checks, 2); assert.equal(effects, 2);
    assert.deepEqual(seen, [{ n: 2, extra: 'permission mutation' }, { n: 2, extra: 'permission mutation' }]);
  } finally { await h.close(); }
});

test('owner replacement, hidden/restored spreads and incompatible schemas reconcile synchronously', async () => {
  const name = 'mcp__changing'; const first = basicTool(name, async () => ok('old').result);
  const h = await setup([first]);
  try {
    const replacement = basicTool(name, async () => ok('new').result, { parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } });
    h.pi.registerTool(replacement);
    assert.deepEqual(h.pi.definitions.get(name)!.parameters.required, ['q']);
    assert.match(JSON.stringify((await h.pi.call(name, { q: 'x' })).result), /new/);
    h.pi.registerTool({ ...replacement, exposure: 'hidden' });
    assert.equal((await h.pi.call(name, {})).isError, true);
    h.pi.registerTool({ ...h.pi.definitions.get(name)!, exposure: 'direct' });
    assert.equal((await h.pi.call(name, { q: 'x' })).isError, false, 'copied execute unwraps rather than recurring');
    h.pi.registerTool(basicTool(name, undefined, { parameters: { type: 'object', allOf: [] } }));
    assert.deepEqual(h.pi.definitions.get(name)!.parameters, { type: 'object', allOf: [] });
    assert.match(h.pi.uiMessages.at(-1)!, /Unsupported/);
    const late = basicTool('mcp__late'); h.pi.registerTool(late);
    assert.ok((late.parameters.properties as Record<string, unknown>).__background__);
    assert.equal((await h.pi.call(late.name, {})).isError, false);
  } finally { await h.close(); }
});

test('model-only, hidden, sequential, excluded and conflicting tools stay native', async () => {
  const tools = [basicTool('mcp__seq', undefined, { executionMode: 'sequential' }),
    basicTool('mcp__ask', undefined, { exposure: 'model-only' }), basicTool('mcp__hidden', undefined, { exposure: 'hidden' }),
    basicTool('write'), basicTool('mcp__collision', undefined, { parameters: { type: 'object', properties: { __background__: { type: 'number' } } } })];
  const executes = tools.map(t => t.execute), schemas = tools.map(t => t.parameters);
  const h = await setup(tools, { exclude: ['write'] });
  try { tools.forEach((tool, i) => { assert.equal(tool.execute, executes[i]); assert.equal(tool.parameters, schemas[i]); }); }
  finally { await h.close(); }
});

test('defaults manage external tools by source, including Square, MCP and native-name overrides', async () => {
  const native = ['read', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode', 'tool_search']
    .map(name => basicTool(name, undefined, { sourceInfo: { path: `builtin:${name}` } }));
  const external = [basicTool('square_catch', async () => { await sleep(20); return ok('square').result; }, { sourceInfo: { path: '/square/index.ts' } }),
    basicTool('mcp__ide__query', undefined, { sourceInfo: { path: 'builtin:mcp' } }), basicTool('custom_tool')];
  const h = await setup([...native, ...external]);
  try {
    const managed = (tool: Tool) => Object.hasOwn(tool.parameters.properties ?? {}, '__background__');
    for (const tool of native) assert.equal(managed(tool), false, tool.name);
    for (const tool of external) assert.ok(managed(tool), tool.name);
    assert.ok(managed(h.pi.getToolDefinition('bash')!));
    const handle = await h.pi.call('square_catch', { __background__: 'yes' });
    assert.equal(snapshot(handle).tool, 'square_catch');
    const replacement = basicTool('read', undefined, { sourceInfo: { path: '/custom/read.ts' } });
    h.pi.registerTool(replacement);
    assert.ok(managed(replacement), 'external read override is managed');
    h.pi.registerTool(native[0]!);
    assert.equal(managed(native[0]!), false, 'restored native read stays native');
  } finally { await h.close(); }
});

test('all permissions finish before admission; denied and invalid calls start no producer', async () => {
  const approval = deferred<void>(), entered = deferred<void>(); let effects = 0;
  const h = await setup([basicTool('mcp__guarded', async () => { effects++; return ok().result; })]);
  h.pi.on('tool_call', async event => { if (event.toolName === 'mcp__guarded') { entered.resolve(); await approval.promise; return { block: true, reason: 'denied' }; } });
  try {
    const call = h.pi.call('mcp__guarded', { __background__: 'yes' }); await entered.promise;
    await h.pi.commands.get('meantime')!('detach', h.pi.ctx);
    assert.deepEqual((h.instance.inspect() as { tasks: unknown[] }).tasks, []);
    assert.equal(effects, 0); approval.resolve();
    assert.equal((await call).isError, true);
    assert.equal((await h.pi.call('mcp__guarded', { invalid: true })).isError, true);
    assert.equal(effects, 0); assert.deepEqual((h.instance.inspect() as { tasks: unknown[] }).tasks, []);
  } finally { approval.resolve(); await h.close(); }
});

test('detached finalized results feed wait, completion tail and native renderer only once', async () => {
  const work = deferred<Result>(); let effects = 0, posts = 0;
  const h = await setup([basicTool('mcp__slow', () => { effects++; return work.promise; }), basicTool('local_fast')]);
  h.pi.after.push((name, result) => { if (name !== 'mcp__slow') return result; posts++; return { ...result, content: [{ type: 'text', text: 'FINAL' }], details: { safe: true }, structuredContent: { safe: true } }; });
  try {
    const handle = await h.pi.call('mcp__slow', { __background__: 'yes' }); const task = snapshot(handle);
    assert.equal(task.delivery, 'background'); assert.equal(posts, 0, 'handle bypasses original result hooks');
    assert.equal((await h.pi.call('local_fast', {})).isError, false);
    work.resolve(ok('SECRET').result); await until(() => h.pi.notifications.length === 1);
    assert.match(h.pi.notifications[0]!.content, /<untrusted-output>\nFINAL\n/);
    assert.doesNotMatch(JSON.stringify(h.pi.entries) + JSON.stringify(h.pi.notifications), /SECRET/);
    const collected = await h.pi.call('meantime', { action: 'wait', ids: [task.id.slice(3, 9)], timeout: 0 });
    assert.equal(collected.isError, false); assert.match(JSON.stringify(collected.result), /FINAL/);
    assert.equal(posts, 1); assert.equal(effects, 1);
  } finally { work.resolve(ok().result); await h.close(); }
});

for (const trigger of ['timeout', 'steer', 'shortcut', 'command'] as const) test(`${trigger} detaches once without aborting, no-mode only disables timer`, async t => {
  let now = 1000;
  if (trigger === 'steer') t.mock.method(performance, 'now', () => now);
  const work = deferred<Result>(); let signal: AbortSignal | undefined;
  const h = await setup([basicTool('mcp__slow', (_id, _args, s) => { signal = s; return work.promise; })], { autoDetachMs: 10 });
  try {
    const running = h.pi.call('mcp__slow', trigger === 'timeout' ? {} : { __background__: 'no' }); await until(() => !!signal);
    if (trigger !== 'timeout') {
      await sleep(20); assert.equal((h.instance.inspect() as { tasks: Snapshot[] }).tasks[0]!.delivery, 'foreground');
      if (trigger === 'steer') {
        now += 3000; // This legacy transition test steers an already-aged producer.
        const images: Content[] = [{ type: 'image', data: 'eA==', mimeType: 'image/png' }];
        const event = { type: 'input' as const, text: 'next', source: 'rpc' as const, streamingBehavior: 'steer' as const, images };
        assert.deepEqual(await h.pi.emit('input', event), [{ action: 'continue' }]); assert.equal(event.images, images);
      } else if (trigger === 'shortcut') await h.pi.shortcuts.get('ctrl+shift+b')!(h.pi.ctx);
      else await h.pi.commands.get('bg')!('detach', h.pi.ctx);
    }
    assert.equal(snapshot(await running).detachReason, trigger === 'command' ? 'shortcut' : trigger);
    assert.equal(signal!.aborted, false); assert.equal(h.pi.abortCalls, 0);
  } finally { work.resolve(ok().result); await h.close(); }
});

test('early manual detach survives later steer and follows the live call, not a later sibling', async () => {
  const approval = deferred<void>(), entered = deferred<void>(), work = deferred<Result>(); let bodies = 0, first = true;
  const h = await setup([basicTool('mcp__held', () => { bodies++; return work.promise; })]);
  h.pi.on('tool_call', async event => { if (event.toolName === 'mcp__held' && first) { first = false; entered.resolve(); await approval.promise; } });
  try {
    const original = h.pi.call('mcp__held', {}); await entered.promise;
    await h.pi.commands.get('meantime')!('detach', h.pi.ctx);
    await h.pi.emit('input', { type: 'input', text: 'next', source: 'rpc', streamingBehavior: 'steer' });
    const sibling = h.pi.call('mcp__held', {}); await until(() => bodies === 1);
    approval.resolve(); assert.equal(snapshot(await original).detachReason, 'shortcut');
    assert.equal((h.instance.inspect() as { tasks: Snapshot[] }).tasks.filter(t => t.delivery === 'foreground').length, 1);
    work.resolve(ok().result); assert.equal(((await sibling).result.structuredContent as { task?: unknown } | undefined)?.task, undefined);
  } finally { approval.resolve(); work.resolve(ok().result); await h.close(); }
});

test('steer inherited before permission admission gets the full startup window after approval', async t => {
  const approval = deferred<void>(), entered = deferred<void>(), work = deferred<Result>(), started = deferred<void>();
  let now = 1000, effects = 0; let signal: AbortSignal | undefined;
  t.mock.method(performance, 'now', () => now);
  const h = await setup([basicTool('mcp__held', (_id, _args, s) => { effects++; signal = s; started.resolve(); return work.promise; })]);
  h.pi.on('tool_call', async event => { if (event.toolName === 'mcp__held') { entered.resolve(); await approval.promise; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tick = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  try {
    const original = h.pi.call('mcp__held', {}); await entered.promise;
    await h.pi.emit('input', { type: 'input', text: 'next', source: 'rpc', streamingBehavior: 'steer' });
    tick(3000);
    assert.equal(effects, 0); assert.deepEqual((h.instance.inspect() as { tasks: Snapshot[] }).tasks, []);
    approval.resolve(); await started.promise; await new Promise<void>(resolve => setImmediate(resolve));
    tick(2999);
    assert.equal((h.instance.inspect() as { tasks: Snapshot[] }).tasks[0]!.delivery, 'foreground');
    tick(1); assert.equal(snapshot(await original).detachReason, 'steer');
    assert.equal(effects, 1); assert.equal(signal!.aborted, false); assert.equal(h.pi.abortCalls, 0);
  } finally { approval.resolve(); work.resolve(ok().result); await h.close(); }
});

for (const trigger of ['steer', 'shortcut', 'command'] as const) test(`${trigger} releases pending waits without cancelling or observing unfinished work`, async () => {
  const work = deferred<Result>(); let signal: AbortSignal | undefined;
  const h = await setup([basicTool('mcp__slow', (_id, _args, s) => { signal = s; return work.promise; })]);
  try {
    const { id } = snapshot(await h.pi.call('mcp__slow', { __background__: 'yes' }));
    const baseline = await h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 0 });
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 600 });
    await until(() => h.pi.trace.filter(t => t.type === 'execute' && t.name === 'meantime').length === 2);
    if (trigger === 'steer') await h.pi.emit('input', { type: 'input', text: 'next', source: 'rpc', streamingBehavior: 'steer' });
    else if (trigger === 'shortcut') await h.pi.shortcuts.get('ctrl+shift+b')!(h.pi.ctx);
    else await h.pi.commands.get('meantime')!('detach', h.pi.ctx);
    const released = await Promise.race([waiting, sleep(1000).then(() => { throw new Error('detach did not release wait'); })]);
    assert.deepEqual(released.result, baseline.result); assert.equal(signal!.aborted, false);
    work.resolve(ok('later').result); await until(() => h.pi.notifications.length === 1);
  } finally { work.resolve(ok().result); await h.close(); }
});

test('disabled steer is non-sticky for existing calls and new waits', async () => {
  const work = deferred<Result>(); const h = await setup([basicTool('mcp__slow', () => work.promise)], { detachOnSteer: false });
  try {
    let returned = false;
    const running = h.pi.call('mcp__slow', {}).then(out => { returned = true; return out; });
    await until(() => h.pi.trace.some(t => t.type === 'execute' && t.name === 'mcp__slow'));
    await h.pi.emit('input', { type: 'input', text: 'next', source: 'rpc', streamingBehavior: 'steer' });
    await sleep(5); assert.equal(returned, false);
    await h.pi.commands.get('bg')!('detach', h.pi.ctx); const { id } = snapshot(await running);
    let waited = false;
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 600 }).then(out => { waited = true; return out; });
    await sleep(5); assert.equal(waited, false, 'earlier detach is not sticky');
    work.resolve(ok('done').result); assert.equal(((await waiting).result.structuredContent as { result_available: boolean }).result_available, true);
    assert.equal(h.pi.notifications.length, 0);
  } finally { work.resolve(ok().result); await h.close(); }
});

test('global sequential and print modes never detach; explicit yes fails before effects', async () => {
  let effects = 0;
  const h = await setup([basicTool('mcp__one', async () => { effects++; return ok().result; })]);
  try {
    h.pi.sequentialNested = true;
    assert.equal((await h.pi.call('mcp__one', { __background__: 'yes' })).isError, true); assert.equal(effects, 0);
    assert.equal((await h.pi.call('mcp__one', {})).isError, false);
    h.pi.sequentialNested = false; h.pi.ctx = { ...h.pi.ctx, mode: 'print' };
    assert.equal((await h.pi.call('mcp__one', { __background__: 'yes' })).isError, true); assert.equal(effects, 1);
    assert.equal((await h.pi.call('mcp__one', {})).isError, false);
  } finally { await h.close(); }
});

test('wait previews show native single and batch bodies, while handle cards retain task details', async () => {
  const body = Array.from({ length: 25 }, (_, i) => `BODY_${i + 1}`).join('\n');
  const h = await setup([basicTool('mcp__preview', async () => { await sleep(10); return ok(body).result; })]);
  type Render = NonNullable<ToolRenderers['renderResult']>;
  const theme = { fg: (_color: string, value: string) => value } as Parameters<Render>[2];
  try {
    const resolve = h.pi.renderers[0]!;
    const native = new Text('NATIVE', 0, 0);
    const managed = resolve('mcp__preview', () => ({ renderResult: () => native }))!;
    assert.equal(managed.renderResult!(ok().result, { expanded: false, isPartial: false }, theme, {} as Parameters<Render>[3]), native);
    assert.equal(resolve('read', () => undefined), undefined);
    const handles = [];
    for (let i = 0; i < 2; i++) handles.push(await h.pi.call('mcp__preview', { __background__: 'yes' }));
    const ids = handles.map(out => snapshot(out).id);
    assert.match(managed.renderResult!(handles[0]!.result, { expanded: false, isPartial: false }, theme, {} as Parameters<Render>[3]).render(200).map(line => line.trimEnd()).join('\n'), /● background · mt_[a-f0-9]{8}$/,
      'the call header already carries the command, so the handle line stays compact');
    initTheme('dark', false);
    const ui = { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5];
    for (const args of [{ action: 'wait', ids: [ids[0] ]}, { action: 'wait', ids }]) {
      const outcome = await h.pi.call('meantime', args);
      const make = (renderers: ToolRenderers) => new ToolExecutionComponent('meantime', 'preview', args, { showImages: false }, renderers, ui, process.cwd());
      const preview = make(resolve('meantime', () => undefined)!);
      preview.updateResult({ ...outcome.result, isError: outcome.isError });
      const collapsed = stripTerminalSequences(preview.render(200).map(line => line.trimEnd()).join('\n'));
      assert.match(collapsed, /✓ mcp__preview · \d+s · mt_[a-f0-9]{8}/, 'wait results open with a glyph header');
      assert.doesNotMatch(collapsed, /Meantime mt_/, 'the machine receipt line is not duplicated under the header');
      assert.match(collapsed, /BODY_1\b/);
      assert.doesNotMatch(collapsed, /BODY_25\b/);
      preview.setExpanded(true);
      assert.match(stripTerminalSequences(preview.render(200).join('\n')), /BODY_25\b/);
    }
    assert.equal(TaskRuntime.liveProducerCount(), 0);
  } finally { await h.close(); }
});

test('wait keeps every JSON-valid native details value behind one control envelope', async () => {
  const shapes: [shape: string, native: unknown][] = [['array', ['a', { b: 1 }]], ['string', 'NATIVE_DETAIL'],
    ['object', { task: { nativeJob: 'job-7' }, other: 'kept' }], ['empty', ''], ['false', false], ['none', undefined]];
  const gates = new Map<string, ReturnType<typeof deferred<Result>>>();
  const h = await setup([basicTool('mcp__t__shape', (_id, args) => gates.get(String(args.shape))!.promise,
    { parameters: { type: 'object', properties: { shape: { type: 'string' } }, required: ['shape'], additionalProperties: false } })]);
  const theme = { fg: (_color: string, value: string) => value } as Parameters<typeof renderTaskResult>[2];
  try {
    for (const [shape, native] of shapes) {
      const gate = deferred<Result>(); gates.set(shape, gate);
      const task = snapshot(await h.pi.call('mcp__t__shape', { shape, __background__: 'yes' }));
      gate.resolve({ content: [{ type: 'text', text: `SHAPE ${shape}` }], details: native });
      const wait = await h.pi.call('meantime', { action: 'wait', ids: [task.id], timeout: 1000 });
      const details = wait.result.details as Record<string, unknown>;
      assert.equal(Object.hasOwn(details, 'nativeDetails'), native !== undefined, `${shape}: undefined stays distinguishable`);
      if (native !== undefined) assert.deepEqual(details.nativeDetails, native, `${shape}: native details survive whole`);
      assert.equal((details.task as Snapshot).id, task.id, `${shape}: control task is not replaced`);
      assert.equal((details.task as Snapshot).state, 'completed');
      assert.equal(Object.hasOwn(details, 'usage'), false);
      const card = renderTaskResult(wait.result, { expanded: false }, theme, { args: { action: 'wait' } }, false)
        .render(200).map(line => line.trimEnd()).join('\n');
      assert.match(card, new RegExp(`✓ mcp__t__shape · \\d+s · ${task.id}`), `${shape}: the renderer reads control details`);
      assert.doesNotMatch(card, /job-7|NATIVE_DETAIL|kept/, `${shape}: native details are not control metadata`);
    }
  } finally { for (const gate of gates.values()) gate.resolve(ok().result); await h.close(); }
});

test('one user detach releases simultaneous batch and cancel grace waits with timeout-shaped results', async () => {
  const a = deferred<Result>(), b = deferred<Result>(), c = deferred<Result>();
  const caller = new AbortController(); let cancelled: AbortSignal | undefined;
  const h = await setup([
    basicTool('mcp__t__a', () => a.promise), basicTool('mcp__t__b', () => b.promise),
    basicTool('mcp__t__c', (_id, _args, signal) => { cancelled = signal; return c.promise; }),
  ], { shutdownGraceMs: 10_000 });
  h.pi.ctx.isIdle = () => false;
  try {
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) ids.push(snapshot(await h.pi.call(`mcp__t__${name}`, { __background__: 'yes' })).id);
    a.resolve(ok('A settled').result);
    await until(() => (h.instance.inspect() as { tasks: Snapshot[] }).tasks.some(t => t.id === ids[0] && !t.localRunning));
    const batch = h.pi.call('meantime', { action: 'wait', ids: ids.slice(0, 2), mode: 'all', timeout: 600 }, caller.signal);
    const cancel = h.pi.call('meantime', { action: 'cancel', ids: [ids[2] ]}, caller.signal);
    await until(() => cancelled!.aborted);
    await h.pi.shortcuts.get('ctrl+shift+b')!(h.pi.ctx);
    const [partial, pendingCancel] = await Promise.race([
      Promise.all([batch, cancel]), sleep(1000).then(() => { throw new Error('detach did not release batch/cancel waits'); }),
    ]);
    const page = partial.result.structuredContent as unknown as { tasks: { id: string; result_available: boolean; result: unknown }[]; pending: Snapshot[] };
    assert.deepEqual(page.tasks.map(t => [t.id, t.result_available, t.result]), [[ids[0], true, { value: 'A settled' }]]);
    assert.deepEqual(page.pending.map(t => [t.id, t.state, t.localRunning]), [[ids[1], 'running', true]]);
    assert.match(JSON.stringify(partial.result.content), /A settled/);
    assert.equal(pendingCancel.isError, false);
    assert.equal(snapshot(pendingCancel).state, 'cancel_requested');
    assert.equal(snapshot(pendingCancel).localRunning, true);
    assert.equal((pendingCancel.result.structuredContent as { result_available: boolean }).result_available, false);
    assert.notEqual(snapshot(pendingCancel).notification, 'observed');
    b.resolve(ok('B later').result); c.resolve(ok('C later').result);
    h.pi.ctx.isIdle = () => true;
    await until(() => h.pi.notifications.flatMap(n => (n.details as { taskIds: string[] }).taskIds).length === 2);
    await h.pi.emit('agent_settled', { type: 'agent_settled' });
    assert.deepEqual(h.pi.notifications.flatMap(n => (n.details as { taskIds: string[] }).taskIds).sort(), ids.slice(1).sort());
  } finally { caller.abort(); a.resolve(ok().result); b.resolve(ok().result); c.resolve(ok().result); await h.close(); }
});

test('management results are paginated rather than dumping the full registry into model context', async () => {
  const h = await setup([basicTool('mcp__t__one', async () => { await sleep(10); return ok().result; })]);
  try {
    for (let i = 0; i < 12; i++) {
      await h.pi.call('mcp__t__one', { __background__: 'yes' });
      await until(() => TaskRuntime.liveProducerCount() === 0);
    }
    const page = await h.pi.call('meantime', { action: 'list', limit: 5 });
    const value = page.result.structuredContent as { tasks: unknown[]; next_offset: number; total: number };
    assert.equal(value.tasks.length, 5); assert.equal(value.next_offset, 5); assert.equal(value.total, 12);
    assert.match(page.result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), /\nMore: offset=5$/);
  } finally { await h.close(); }
});

test('wait is the single result path, with immediate reads and fractional seconds', async () => {
  const work = deferred<Result>();
  const h = await setup([basicTool('mcp__t__slow', () => work.promise)]);
  try {
    const schema = h.pi.definitions.get('meantime')!.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
    assert.deepEqual(schema.properties.action, { type: 'string', enum: ['list', 'wait', 'cancel'] });
    assert.equal((h.pi.definitions.get('meantime')!.parameters.properties as Record<string, Record<string, unknown>>).timeout!.minimum, 0);
    assert.equal('timeout_ms' in schema.properties, false);
    assert.equal('id' in schema.properties, false);
    assert.equal(schema.additionalProperties, false);
    const { id } = snapshot(await h.pi.call('mcp__t__slow', { __background__: 'yes' }));
    for (const action of ['status', 'result', 'unknown']) {
      assert.equal((await h.pi.call('meantime', { action, ids: [id] })).isError, true);
    }
    assert.equal((await h.pi.call('meantime', { action: 'wait', ids: [id], timeout_ms: 0 })).isError, true);
    const immediate = h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 0 });
    // An immediate read must finish before the next timer turn, not start a wait timer.
    const read = await Promise.race([immediate, sleep(0).then(() => { throw new Error('immediate read blocked'); })]);
    assert.equal(snapshot(read).state, 'running');
    assert.equal((read.result.structuredContent as { result_available: boolean }).result_available, false);
    const started = performance.now();
    const timedOut = await h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 0.05 });
    assert.ok(performance.now() - started >= 35 && performance.now() - started < 1000, 'single-task timeout is in seconds');
    assert.equal((timedOut.result.structuredContent as { result_available: boolean }).result_available, false);
    work.resolve(ok('SETTLED').result); await until(() => TaskRuntime.liveProducerCount() === 0);
    const settled = await h.pi.call('meantime', { action: 'wait', ids: [id], timeout: 0 });
    assert.equal((settled.result.structuredContent as { result_available: boolean }).result_available, true);
    assert.match(JSON.stringify(settled.result.content), /SETTLED/);
  } finally { work.resolve(ok().result); await h.close(); }
});

test('multi-task wait exposes settled and pending tasks, validates ids, and shares one inline text budget', async () => {
  const a = deferred<Result>(), b = deferred<Result>();
  const h = await setup([basicTool('mcp__t__a', () => a.promise), basicTool('mcp__t__b', () => b.promise)]);
  try {
    const first = snapshot(await h.pi.call('mcp__t__a', { __background__: 'yes' }));
    const second = snapshot(await h.pi.call('mcp__t__b', { __background__: 'yes' }));
    const immediate = await Promise.race([
      h.pi.call('meantime', { action: 'wait', ids: [first.id, second.id], timeout: 0 }),
      sleep(0).then(() => { throw new Error('immediate multi-task read blocked'); }),
    ]);
    assert.deepEqual((immediate.result.structuredContent as unknown as { pending: Snapshot[] }).pending.map(t => t.id), [first.id, second.id]);
    const waiting = h.pi.call('meantime', { action: 'wait', ids: [first.id.slice(3), second.id], mode: 'any' });
    a.resolve(ok('A'.repeat(20 * 1024)).result);
    const any = await waiting;
    assert.equal(any.isError, false);
    const value = any.result.structuredContent as { tasks: { id: string; result_available: boolean }[]; pending: { id: string }[] };
    assert.deepEqual(value.tasks.map(task => [task.id, task.result_available]), [[first.id, true]]);
    assert.deepEqual(value.pending.map(task => task.id), [second.id]);
    assert.match(JSON.stringify(any.result.content), new RegExp(`Pending: ${second.id}`));
    for (const args of [{ id: first.id }, { ids: [] }, { ids: [first.id, 'missing'] }]) {
      const invalid = await h.pi.call('meantime', { action: 'wait', ...args });
      assert.equal(invalid.isError, true);
    }
    const bare = await h.pi.call('meantime', { action: 'wait', timeout: 0 });
    assert.equal(snapshot(bare).id, second.id);
    assert.equal((bare.result.structuredContent as { result_available: boolean }).result_available, false);
    const started = performance.now();
    const timedOut = await h.pi.call('meantime', { action: 'wait', ids: [first.id, second.id], timeout: 0.05 });
    assert.ok(performance.now() - started >= 35 && performance.now() - started < 1000, 'multi-task timeout is in seconds');
    assert.equal((timedOut.result.structuredContent as typeof value).pending[0]!.id, second.id);
    b.resolve(ok('B'.repeat(20 * 1024)).result);
    const all = await h.pi.call('meantime', { action: 'wait', ids: [second.id, first.id] });
    assert.deepEqual((all.result.structuredContent as typeof value).tasks.map(task => task.id), [second.id, first.id]);
    assert.deepEqual((all.result.structuredContent as typeof value).pending, []);
    const blocks = all.result.content.filter(block => block.type === 'text').map(block => block.text);
    assert.equal(blocks.filter(text => /^(A+|B+)$/.test(text)).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0), 32 * 1024);
    const text = blocks.join('\n');
    assert.ok(text.indexOf(`${second.id} · `) < text.indexOf(`${first.id} · `));
    const single = await h.pi.call('meantime', { action: 'wait', ids: [first.id ]});
    assert.equal(snapshot(single).id, first.id);
    assert.equal((single.result.structuredContent as { result_available: boolean }).result_available, true);
  } finally { a.resolve(ok().result); b.resolve(ok().result); await h.close(); }
});

test('multi-task wait shares its text budget for Bash and MCP, reports omission, and preserves single retrieval', async () => {
  for (const tool of ['bash', 'mcp__t__text']) {
    const work = deferred<Result>();
    const h = await setup([basicTool('mcp__t__text', () => work.promise)]);
    try {
      const handles = [];
      for (const letter of ['A', 'B']) {
        const args = tool === 'bash'
          ? { command: `sleep 0.1; node -e 'process.stdout.write("${letter}".repeat(24000))'` }
          : {};
        handles.push(snapshot(await h.pi.call(tool, { ...args, __background__: 'yes' })));
      }
      work.resolve(ok('M'.repeat(24000)).result);
      const all = await h.pi.call('meantime', { action: 'wait', ids: handles.map(t => t.id), mode: 'all' });
      assert.equal(all.isError, false);
      const blocks = all.result.content.filter(b => b.type === 'text').map(b => b.text);
      assert.equal(blocks.filter(text => /^(A+|B+|M+)$/.test(text)).reduce((n, text) => n + Buffer.byteLength(text), 0), 32768);
      const notices = blocks.filter(text => text.startsWith('Truncated; use meantime'));
      assert.equal(notices.length, 1); assert.ok(notices[0]!.includes(handles[1]!.id));
      assert.match(notices[0]!, /use meantime\(action="wait", ids=\["[^"]+"\], timeout=0\) for full output/);
      assert.doesNotMatch(blocks.join('\n'), /Output:|retention limit/);
      for (const handle of handles) {
        const single = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [handle.id ]});
        const singleWait = await h.pi.call('meantime', { action: 'wait', ids: [handle.id ]});
        for (const view of [single, singleWait]) {
          const text = view.result.content.filter(b => b.type === 'text').map(b => b.text);
          assert.equal(text.filter(t => /^(A+|B+|M+)$/.test(t)).join('').length, 24000);
          assert.doesNotMatch(text.join('\n'), /Truncated; use meantime/);
        }
      }
    } finally { work.resolve(ok().result); await h.close(); }
  }
});

test('real shell fixture runs, can detach without a second spawn, and result is retained', async () => {
  const h = await setup();
  try {
    const command = `node -e 'setTimeout(()=>console.log("SHELL_DONE"),80)'\n# ${'long comment '.repeat(20)}`;
    const out = await h.pi.call('bash', { command, __background__: 'yes' });
    const task = snapshot(out); assert.equal(task.state, 'running');
    // Structured UI data preserves the exact command; prose stays bounded.
    assert.equal(task.command, command);
    assert.equal((h.instance.inspect() as { tasks: Snapshot[] }).tasks.find(t => t.id === task.id)!.command, command);
    const list = await h.pi.call('meantime', { action: 'list' });
    const preview = (list.result.details as { tasks: Snapshot[] }).tasks[0]!.command!;
    assert.equal(preview, task.command);
    await until(() => h.pi.notifications.length === 1);
    assert.match(h.pi.notifications[0]!.content, new RegExp(`${task.id} · completed`));
    assert.match(h.pi.notifications[0]!.content, /<untrusted-output>\nSHELL_DONE/);
    const result = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [task.id ]});
    assert.equal((result.result.details as { task: Snapshot }).task.command, preview);
    assert.match(JSON.stringify(result.result), /SHELL_DONE/);
  } finally { await h.close(); }
});

test('a detached producer cannot pass old steer to descendants in a later model turn', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const launch = deferred<void>(), entered = deferred<void>(), child = deferred<Result>();
  let innerResult: Result | undefined;
  const h = await setup([
    basicTool('mcp__t__outer', async (_id, _args, _signal, _update, ctx) => {
      entered.resolve(); await launch.promise;
      innerResult = (await ctx.executeTool('mcp__t__inner', {})).result;
      return innerResult;
    }),
    basicTool('mcp__t__inner', () => child.promise),
  ]);
  try {
    const outer = h.pi.call('mcp__t__outer', {}); await entered.promise;
    now += 3000; // Detach the outer at its startup deadline, then test intent isolation.
    await h.pi.emit('input', { type: 'input', text: 'next', source: 'rpc', streamingBehavior: 'steer' });
    assert.equal(snapshot(await outer).detachReason, 'steer');
    await h.pi.emit('turn_end', { type: 'turn_end' });
    launch.resolve();
    await until(() => h.pi.trace.some(e => e.type === 'execute' && e.name === 'mcp__t__inner'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(innerResult, undefined, 'new descendant must remain foreground');
    child.resolve(ok('inner').result);
    await until(() => innerResult !== undefined);
    assert.equal((innerResult!.structuredContent as { task?: unknown }).task, undefined);
  } finally { launch.resolve(); child.resolve(ok().result); await h.close(); }
});

test('short management receipts retain structured data and cancellation semantics', async () => {
  const pending = deferred<Result>();
  const h = await setup([basicTool('mcp__t__receipt', () => pending.promise)]);
  const text = (result: Result) => result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  try {
    const handle = await h.pi.call('mcp__t__receipt', { __background__: 'yes' });
    const task = snapshot(handle);
    assert.equal(text(handle.result), `Meantime ${task.id} running in background.`);
    assert.ok(!text(handle.result).includes('status/result/cancel'));
    const page = await h.pi.call('meantime', { action: 'list', limit: 1 });
    const data = page.result.structuredContent as unknown as { tasks: Snapshot[]; next_offset: null; total: number };
    assert.equal(data.tasks[0]!.id, task.id);
    assert.deepEqual(data, JSON.parse(JSON.stringify(page.result.details)));
    assert.match(text(page.result), new RegExp(`^${task.id} · running · \\d+s — mcp__t__receipt$`));
    const status = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: [task.id ]});
    assert.deepEqual(status.result.structuredContent, { task: JSON.parse(JSON.stringify(status.result.details)), result_available: false });
    assert.ok(!text(status.result).includes('{'));
    const cancelled = await h.pi.call('meantime', { action: 'cancel', ids: [task.id ]});
    assert.match(text(cancelled.result), /cancel_requested/);
    assert.deepEqual(cancelled.result.structuredContent, { task: JSON.parse(JSON.stringify(cancelled.result.details)), result_available: false });
    const missing = await h.pi.call('meantime', { action: 'wait', timeout: 0, ids: ['missing' ]});
    assert.equal(missing.isError, true);
    assert.match(text(missing.result), /No task with that id in this session/);
  } finally { pending.resolve(ok().result); await h.close(); }
});
