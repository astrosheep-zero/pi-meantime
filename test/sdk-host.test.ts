import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import type { ToolCall, AssistantMessage } from '@earendil-works/pi-ai';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { PiHost } from '../src/protocol.ts';
import type { HostSession } from '../src/host.ts';
import { deferred, until } from './helpers.ts';

const SECRET = 'RAW_PRIVATE_TOKEN';
const png = { type: 'image' as const, mimeType: 'IMAGE/PNG; charset=binary', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=' };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Real SDK/runner/agent, no model request. Only outgoing completion delivery is
 * captured: allowing triggerTurn to run here would require a network provider. */
async function sdk(managed: boolean, maxRunning = 8) {
  const root = mkdtempSync(join(tmpdir(), 'meantime-sdk-'));
  const trace: Array<{ kind: string; id: string; name?: string; parent?: string }> = [];
  const repairs: unknown[] = [], inputs = new Map<string, unknown>(), signals = new Map<string, AbortSignal | undefined>();
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const notices: unknown[] = [], errors: unknown[] = [];
  let owner!: ExtensionAPI, plugin: ReturnType<typeof install> | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  const definition = {
    name: 'victim', label: 'Native victim', description: 'Original description',
    namespace: { name: 'native', description: 'Original namespace' }, annotations: { readOnlyHint: true },
    parameters: { type: 'object', properties: { n: { type: 'number' }, mode: { type: 'string' } }, required: ['n', 'mode'], additionalProperties: false },
    outputSchema: { type: 'object' }, prepareLoadout: () => ({}),
    prepareArguments(raw: unknown) {
      repairs.push(raw);
      const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
      assert.equal('__background__' in args, false);
      return { ...args, n: Number(args.n) + 1 };
    },
    async execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: ((v: unknown) => void) | undefined, ctx: any) {
      trace.push({ kind: 'execute', id });
      assert.equal(args, inputs.get(id));
      assert.equal(args.n, 13);
      assert.equal(args.afterValidation, true, 'last permission mutation is not revalidated');
      assert.equal('__background__' in args, false);
      assert.equal(ctx.signal, signal);
      signals.set(id, signal);
      assert.equal(typeof ctx.executeTool, 'function');
      assert.ok(ctx.tools.some((t: any) => t.name === 'child'));
      update?.({ content: [{ type: 'text', text: 'partial' }], details: undefined });
      if (args.mode === 'nested') assert.equal((await ctx.executeTool('child', {})).isError, false);
      if (gates.has(id)) await gates.get(id)!.promise;
      if (args.mode === 'old' || args.mode === 'late-nested') await ctx.executeTool('child', {});
      if (args.mode === 'cancel') await new Promise((_, reject) => {
        if (signal?.aborted) reject(Error('native cancellation'));
        else signal?.addEventListener('abort', () => reject(Error('native cancellation')), { once: true });
      });
      if (args.mode === 'throw') throw Error('native throw');
      return { content: [{ type: 'text', text: SECRET }], details: { secret: SECRET }, structuredContent: { secret: SECRET }, isError: args.mode === 'clear', usage };
    },
  } as unknown as ToolDefinition;
  const settings = SettingsManager.inMemory({ images: { autoResize: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      owner = pi;
      pi.registerTool(definition);
      pi.registerTool({ name: 'child', label: 'Child', description: 'Native nested child', parameters: { type: 'object', properties: {} } as any,
        async execute(id, _args, signal, _update, ctx) {
          trace.push({ kind: 'child', id });
          assert.equal(signal, signals.get(id.slice(0, id.lastIndexOf('/'))));
          if (gates.has(id)) await gates.get(id)!.promise;
          trace.push({ kind: 'child-settled', id });
          return { content: [], details: undefined, usage };
        } });
      // Native details keep legal non-object shapes; no result hook touches this tool.
      const nativeDetails: Record<string, unknown> = { array: [1, 'two', { three: 3 }], string: 'NATIVE_DETAIL',
        object: { task: { nativeJob: 'job-7' }, other: 'kept' }, empty: '', false: false, zero: 0, none: undefined };
      pi.registerTool({ name: 'shapes', label: 'Native details shapes', description: 'Native details fixture',
        parameters: { type: 'object', properties: { shape: { type: 'string' } }, required: ['shape'], additionalProperties: false },
        async execute(id, args) {
          if (gates.has(id)) await gates.get(id)!.promise;
          const text = `SHAPE ${String(args.shape)}`;
          return { content: [{ type: 'text' as const, text }], details: nativeDetails[String(args.shape)] };
        } });
      for (const [name, parameters] of [
        ['unmanaged', { type: 'object', properties: { __background__: { type: 'string' } } }],
        ['primitive', { type: 'string' }], ['array', { type: 'array', items: { type: 'number' } }],
      ] as const) pi.registerTool({ name, label: name, description: 'Unmanaged input contract fixture', parameters: parameters as any,
        async execute(id) {
          trace.push({ kind: 'exotic', id });
          if (gates.has(id)) await gates.get(id)!.promise;
          return { content: [], details: undefined };
        } });
      pi.on('tool_call', event => {
        trace.push({ kind: 'pre', id: event.toolCallId, name: event.toolName, parent: event.parentToolCallId });
        if (event.toolName !== 'victim') return;
        assert.equal('__background__' in event.input, false);
        event.input.n = Number(event.input.n) + 10;
        inputs.set(event.toolCallId, event.input);
        if (event.input.mode === 'blocked') return { block: true, reason: 'native denial' };
      });
      pi.on('tool_result', event => {
        trace.push({ kind: 'post', id: event.toolCallId, name: event.toolName, parent: event.parentToolCallId });
        if (event.toolName === 'bash') return { content: [{ type: 'text', text: 'BASH REDACTED' }], details: { safe: true } };
        if (event.toolName !== 'victim') return;
        assert.equal(event.input, inputs.get(event.toolCallId));
        assert.equal(JSON.stringify(event.content).includes('running in background'), false, 'handles never enter native post hooks');
        return { content: [{ type: 'text', text: 'INTERMEDIATE' }, ...(event.input.mode === 'image' ? [png] : [])], details: { safe: true }, isError: event.input.mode !== 'clear', usage };
      });
      pi.on('tool_result', event => {
        if (event.toolName !== 'victim') return;
        trace.push({ kind: 'last-post', id: event.toolCallId });
        assert.equal((event.content[0] as any).text, 'INTERMEDIATE');
        assert.deepEqual(event.details, { safe: true });
        return { content: [{ type: 'text', text: 'FINAL REDACTED' }, ...event.content.slice(1)] };
      });
    }, ...(managed ? [(pi: ExtensionAPI) => {
      // Capture delivery, not native finalization. All registration and session
      // capture still use the actual factory API, without a test connect port.
      plugin = install(pi as unknown as PiHost,
        { config: validateConfig({ include: ['victim', 'shapes'], autoDetachMs: 0, maxRunning, shutdownGraceMs: 1, notifyDebounceMs: 1 }) });
    }] : []), (pi: ExtensionAPI) => {
      // Registered AFTER meantime: admission must wait for this whole chain,
      // including late denial and mutations forbidden by the original schema.
      pi.on('tool_call', event => {
        if (event.toolName !== 'victim') return;
        trace.push({ kind: 'last-pre', id: event.toolCallId });
        event.input.afterValidation = true;
        if (event.input.mode === 'late-blocked') return { block: true, reason: 'late native denial' };
      });
    }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), tools: ['bash', 'victim', 'child', 'shapes', 'unmanaged', 'primitive', 'array', ...(managed ? ['meantime'] : [])] }));
  if (managed) {
    const persist = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async message => {
      notices.push(message);
      await persist(message, { triggerTurn: false });
    };
  }
  await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error); } });
  assert.equal(errors.length, 0);
  if (managed) assert.ok((plugin!.inspect() as any).managed.includes('victim'), 'ordinary session_start captured genuine session');
  const taskIds = new Map<string, string>();
  let serial = 0;
  async function call(name: string, args: unknown, id = `call-${++serial}`, signal = new AbortController().signal, emitLifecycle = true) {
    const toolCall = { type: 'toolCall', name, id, arguments: args } as ToolCall;
    const assistant = { role: 'assistant', content: [toolCall], stopReason: 'toolUse', timestamp: 0 } as AssistantMessage;
    session.agent.state.messages.push(assistant);
    if (emitLifecycle) await session.extensionRunner.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
    const outcome = await runToolCall(toolCall, { tools: session.agent.state.tools, assistantMessage: assistant,
      context: { messages: session.agent.state.messages, tools: session.agent.state.tools }, signal,
      beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
    if (emitLifecycle) await session.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: outcome.result, isError: outcome.isError });
    const taskId = (outcome.result.structuredContent as any)?.task?.id;
    if (taskId) taskIds.set(id, taskId);
    return outcome;
  }
  const tasks = () => (plugin?.inspect() as any)?.tasks as any[] ?? [];
  async function retained(id: string) {
    await until(() => tasks().some(t => t.id === taskIds.get(id) && !t.localRunning));
    const task = tasks().find(t => t.id === taskIds.get(id));
    return { task, outcome: await call('meantime', { action: 'wait', ids: [task.id], timeout: 0 }) };
  }
  return { session, loader, owner, plugin, definition, root, trace, repairs, signals, gates, notices, errors, call, tasks, retained,
    async close() { await plugin?.dispose(); session.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('real SDK: reload drains stale approved/blocked native prehooks behind one permanent result fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'meantime-reload-'));
  const settings = SettingsManager.inMemory();
  const approvals = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>; block: boolean }>();
  const posts: Array<{ generation: number; id: string }> = [];
  const ends = new Map<string, { isError: boolean; result: unknown }>();
  const errors: unknown[] = [];
  let generation = 0, effects = 0, denials = 0;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      const ownGeneration = ++generation;
      pi.registerTool({ name: 'victim', label: 'Parent', description: 'Managed parent', parameters: { type: 'object', properties: {} } as any,
        async execute(_id, _args, _signal, _update, ctx) {
          await ctx.executeTool('child', {});
          return { content: [], details: undefined };
        } });
      pi.registerTool({ name: 'child', label: 'Child', description: 'Unmanaged child', parameters: { type: 'object', properties: {} } as any,
        async execute() { effects++; return { content: [], details: undefined }; } });
      pi.on('tool_call', async event => {
        if (event.toolName !== 'child') return;
        const approval = approvals.get(event.toolCallId)!;
        approval.entered.resolve();
        await approval.release.promise;
        if (approval.block) { denials++; return { block: true, reason: 'old approval denied' }; }
      });
      pi.on('tool_result', event => { posts.push({ generation: ownGeneration, id: event.toolCallId }); });
    }, pi => {
      install(pi as unknown as PiHost, { config: validateConfig({ include: ['victim'], autoDetachMs: 0, shutdownGraceMs: 1 }) });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), tools: ['victim', 'child', 'meantime'] });
  const host = session as unknown as HostSession;
  // Native nested dispatch emits these through the public session subscription,
  // including immediate abort/block outcomes which have no afterToolCall phase.
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_end' && event.toolName === 'child') {
      assert.equal(ends.has(event.toolCallId), false, 'one native end per child');
      ends.set(event.toolCallId, { isError: event.isError, result: event.result });
    }
  });
  try {
    await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error); } });
    const fence = host._afterToolCall;
    async function startHeld(id: string, block: boolean) {
      const approval = { entered: deferred<void>(), release: deferred<void>(), block };
      approvals.set(`${id}/1`, approval);
      const call = { type: 'toolCall', name: 'victim', id, arguments: { __background__: 'yes' } } as ToolCall;
      const assistant = { role: 'assistant', content: [call], stopReason: 'toolUse', timestamp: 0 } as AssistantMessage;
      session.agent.state.messages.push(assistant);
      await session.extensionRunner.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'victim', args: call.arguments });
      const out = await runToolCall(call, { tools: session.agent.state.tools, assistantMessage: assistant,
        context: { messages: session.agent.state.messages, tools: session.agent.state.tools }, signal: new AbortController().signal,
        beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
      await session.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'victim', result: out.result, isError: out.isError });
      assert.equal((out.result.structuredContent as any).result_available, false);
      await approval.entered.promise;
      return approval;
    }
    for (let round = 0; round < 3; round++) {
      const ids = [`approved-${round}`, `blocked-${round}`];
      for (const [index, id] of ids.entries()) await startHeld(id, index === 1);
      await session.reload();
      assert.equal(host._afterToolCall, fence, 'pending reloads reuse one per-session result fence');
      assert.equal(generation, round + 2, 'genuine reload recreated extension factories/runner');
      for (const id of ids) approvals.get(`${id}/1`)!.release.resolve();
      await until(() => ids.every(id => ends.has(`${id}/1`)));
      for (const id of ids) {
        assert.equal(ends.get(`${id}/1`)!.isError, true);
        assert.equal(posts.some(post => post.id === id || post.id === `${id}/1`), false, 'stale parent/child never reaches successor result hooks');
      }
      assert.match(JSON.stringify(ends.get(`${ids[0]}/1`)!.result), /Operation aborted/i);
      // Native abort takes precedence even when the old handler returns block.
      assert.match(JSON.stringify(ends.get(`${ids[1]}/1`)!.result), /Operation aborted/i);
      assert.equal(denials, round + 1, 'blocked old prehook also drained');
      assert.equal(effects, 0, 'retired approvals cannot execute native child');
    }
    const finalApproval = await startHeld('final-blocked', true);
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
    finalApproval.release.resolve();
    await until(() => ends.has('final-blocked/1'));
    assert.equal(denials, 4);
    assert.equal(effects, 0);
    assert.equal(posts.some(post => post.id.startsWith('final-blocked')), false);
    assert.equal(host._afterToolCall, fence, 'the session keeps one pass-through fence after shutdown');
    assert.equal(ends.size, 7);
    assert.deepEqual(errors, []);
  } finally {
    for (const approval of approvals.values()) approval.release.resolve();
    unsubscribe(); session.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

function clean(result: unknown) { assert.equal(JSON.stringify(result).includes(SECRET), false); }
function count(h: Awaited<ReturnType<typeof sdk>>, kind: string, id: string) { return h.trace.filter(t => t.kind === kind && t.id === id).length; }

test('real SDK: native baseline = managed foreground = finalized detached output', async () => {
  const baseline = await sdk(false), managed = await sdk(true);
  try {
    for (const mode of ['normal', 'clear', 'throw', 'image', 'nested']) {
      const id = mode;
      const raw = { n: '2', mode };
      const native = await baseline.call('victim', raw, id);
      const foreground = await managed.call('victim', { ...raw, __background__: 'no' }, id);
      assert.deepEqual(foreground.result, { ...native.result, isError: native.isError }, mode);
      assert.equal(foreground.isError, native.isError);
      clean(foreground.result);
      assert.equal(foreground.result.structuredContent, undefined, 'native content replacement invalidates stale structured data');
      assert.equal(foreground.isError, mode !== 'clear');
      if (mode === 'image') {
        assert.equal(foreground.result.content[1]?.type, 'image');
        assert.equal((foreground.result.content[1] as any).mimeType, 'image/png', 'genuine session image normalization follows result hooks');
      }
      assert.equal(foreground.result.usage?.totalTokens, 3, 'outer finalization does not double usage');
      for (const kind of ['pre', 'last-pre', 'execute', 'post', 'last-post']) assert.equal(count(managed, kind, id), 1, `${mode}/${kind}`);
      const detachedId = `bg-${mode}`;
      const backgroundGate = deferred<void>(); managed.gates.set(detachedId, backgroundGate);
      const detached = await managed.call('victim', { ...raw, __background__: 'yes' }, detachedId);
      assert.equal((detached.result.structuredContent as any).result_available, false);
      backgroundGate.resolve();
      const stored = await managed.retained(detachedId);
      assert.equal(stored.task.isError, native.isError);
      assert.equal(stored.outcome.isError, native.isError);
      assert.match(JSON.stringify(stored.outcome.result.content), /FINAL REDACTED/);
      assert.deepEqual((stored.outcome.result.details as any).nativeDetails.safe, true);
      clean(stored.outcome.result);
      for (const kind of ['pre', 'last-pre', 'execute', 'post', 'last-post']) assert.equal(count(managed, kind, detachedId), 1, `${detachedId}/${kind}`);
    }
    // Genuine native unknown-root repair: do not object-spread a JSON string.
    const raw = JSON.stringify({ n: '2', mode: 'normal' });
    const nativeJson = await baseline.call('victim', raw, 'json');
    assert.deepEqual((await managed.call('victim', raw, 'json')).result, { ...nativeJson.result, isError: nativeJson.isError });
    assert.ok(managed.repairs.includes(raw));
    assert.equal(count(managed, 'child', 'nested/1'), 1);
    assert.equal(managed.trace.find(t => t.kind === 'pre' && t.id === 'nested/1')?.parent, 'nested');

    const gate = deferred<void>(); managed.gates.set('detached', gate);
    const outer = new AbortController();
    const handle = await managed.call('victim', { n: '2', mode: 'late-nested', __background__: 'yes' }, 'detached', outer.signal);
    assert.equal((handle.result.structuredContent as any).result_available, false);
    assert.equal(count(managed, 'post', 'detached'), 0);
    assert.notEqual(managed.signals.get('detached'), outer.signal);
    outer.abort(); assert.equal(managed.signals.get('detached')?.aborted, false);
    gate.resolve();
    const { task, outcome } = await managed.retained('detached');
    clean(outcome); assert.equal(task.isError, true);
    assert.match(JSON.stringify(outcome.result.content), /FINAL REDACTED/);
    assert.equal(count(managed, 'post', 'detached'), 1);
    assert.equal(count(managed, 'child', 'detached/1'), 1, 'default nested dispatch survives original parent abort');
    assert.equal(count(managed, 'post', 'detached/1'), 1);

    const nativeBash = await baseline.call('bash', { command: "printf 'RAW_'\"PRIVATE_TOKEN\"" }, 'bash-native');
    const bash = await managed.call('bash', { command: "printf 'RAW_'\"PRIVATE_TOKEN\"", __background__: 'yes' }, 'bash-detached');
    clean(bash);
    await until(() => managed.notices.length > 0);
    const saved = await managed.retained('bash-detached');
    clean(saved.outcome);
    assert.match(JSON.stringify(saved.outcome.result.content), /BASH REDACTED/);
    assert.equal((nativeBash.result.content[0] as any).text, 'BASH REDACTED');
    assert.equal(count(managed, 'post', 'bash-detached'), 1);
    // The helper emits model-order lifecycle events through the actual runner;
    // native nested calls emit their own events without fixture intervention.
    clean(managed.notices);
    clean(managed.tasks());
    clean(managed.session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'meantime-index'));
    assert.match(JSON.stringify(managed.notices), /REDACTED/);
    assert.equal(managed.repairs.length, 12, 'one native preparation per managed call');
    assert.equal(baseline.repairs.length, 6, 'identical native preparation count without plugin');
    assert.deepEqual(managed.errors, []);
  } finally { await baseline.close(); await managed.close(); }
});

test('real SDK: wait keeps array, string, primitive and task-bearing native details behind one control envelope', async () => {
  const h = await sdk(true);
  try {
    const cases: [shape: string, native: unknown][] = [['array', [1, 'two', { three: 3 }]], ['string', 'NATIVE_DETAIL'],
      ['object', { task: { nativeJob: 'job-7' }, other: 'kept' }], ['empty', ''],
      ['false', false], ['zero', 0], ['none', undefined]];
    for (const [shape, native] of cases) {
      const foreground = await h.call('shapes', { shape }, `fg-${shape}`);
      assert.deepEqual(foreground.result.details, native, `${shape}: native details are legal JSON`);
      const gate = deferred<void>(); h.gates.set(`bg-${shape}`, gate);
      const handle = await h.call('shapes', { shape, __background__: 'yes' }, `bg-${shape}`);
      assert.equal(handle.isError, false);
      assert.equal((handle.result.structuredContent as { result_available: boolean }).result_available, false);
      gate.resolve();
      const { task, outcome } = await h.retained(`bg-${shape}`);
      const details = outcome.result.details as Record<string, unknown>;
      assert.equal(Object.hasOwn(details, 'nativeDetails'), native !== undefined, `${shape}: undefined stays distinguishable`);
      if (native !== undefined) assert.deepEqual(details.nativeDetails, foreground.result.details, `${shape}: foreground/background parity`);
      assert.equal((details.task as { id: string }).id, task.id, `${shape}: control task survives`);
      assert.equal((details.task as { state: string }).state, 'completed');
      assert.equal(Object.hasOwn(details, 'usage'), false);
      assert.deepEqual(outcome.result.content.slice(1), foreground.result.content, `${shape}: content parity`);
      assert.equal((outcome.result.structuredContent as { task: { id: string } }).task.id, task.id);
      assert.equal((outcome.result.structuredContent as { result_available: boolean }).result_available, true);
      if (shape === 'object') assert.deepEqual((details.nativeDetails as { task: unknown }).task, { nativeJob: 'job-7' },
        'a native task field is no longer overwritten');
    }
    assert.deepEqual(h.errors, []);
  } finally { for (const gate of h.gates.values()) gate.resolve(); await h.close(); }
});

test('real SDK: direct runToolCall needs no start event; before bridge restores prototype lookup', async () => {
  const h = await sdk(true);
  const host = h.session as unknown as HostSession;
  const nativeBefore = Object.getPrototypeOf(h.session)._beforeToolCall;
  const gate = deferred<void>(); h.gates.set('without-start', gate);
  try {
    const foreground = await h.call('victim', JSON.stringify({ n: '2', mode: 'normal' }), 'direct-json', undefined, false);
    assert.match(JSON.stringify(foreground.result), /FINAL REDACTED/);
    const handle = await h.call('victim', { n: '2', mode: 'normal', __background__: 'yes' }, 'without-start', undefined, false);
    assert.equal((handle.result.structuredContent as any).result_available, false, 'raw background intent survives validation without a start event');
    assert.equal(count(h, 'post', 'without-start'), 0);
    gate.resolve();
    const saved = await h.retained('without-start');
    clean(saved.outcome);
    for (const id of ['direct-json', 'without-start']) {
      for (const kind of ['pre', 'last-pre', 'execute', 'post', 'last-post']) assert.equal(count(h, kind, id), 1);
    }
    await h.plugin!.dispose();
    assert.equal(Object.hasOwn(host, '_beforeToolCall'), false, 'dispose removes only the owned instance bridge');
    assert.equal(host._beforeToolCall, nativeBefore);
    assert.deepEqual(h.errors, []);
  } finally { gate.resolve(); await h.close(); }
});

test('real SDK core loop: public starts precede repair; foreground/detached hooks and nested job signals stay native', async () => {
  const h = await sdk(true);
  const events: Array<{ type: string; id: string }> = [];
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') events.push({ type: event.type, id: event.toolCallId });
  });
  // Drive Agent's real core event path, not the manually emitted call helper.
  // No provider request, credentials or session/prototype patches.
  let plan: ToolCall | undefined;
  h.session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: plan ? [plan] : [],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', usage,
      stopReason: plan ? 'toolUse' : 'stop', timestamp: 0 };
    plan = undefined;
    stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return stream;
  };
  try {
    const before = (h.session as unknown as { _beforeToolCall: unknown })._beforeToolCall;
    assert.equal(Object.hasOwn(h.session, '_beforeToolCall'), true, 'one generation-local before bridge');
    for (const [id, raw] of [
      ['core-json', JSON.stringify({ n: '2', mode: 'normal' })],
      ['core-fg', { n: '2', mode: 'nested', __background__: 'no' }],
      ['core-bg', { n: '2', mode: 'nested', __background__: 'yes' }],
      ['core-denied', { n: '2', mode: 'late-blocked', __background__: 'yes' }],
    ] as const) {
      const gate = id === 'core-bg' ? deferred<void>() : undefined;
      if (gate) h.gates.set(`${id}/1`, gate);
      plan = { type: 'toolCall', id, name: 'victim', arguments: raw } as ToolCall;
      await h.session.agent.prompt('offline lifecycle fixture');
      const result = [...h.session.messages].reverse().find(m => m.role === 'toolResult' && m.toolCallId === id);
      assert.ok(result && result.role === 'toolResult');
      if (gate) {
        assert.equal(count(h, 'post', id), 0, 'outer handle cannot finalize producer');
        assert.equal((result.details as any).delivery, 'background');
        assert.equal(h.signals.get(id)?.aborted, false);
        gate.resolve();
        await until(() => count(h, 'post', id) === 1);
      } else if (id === 'core-denied') {
        assert.equal(result.isError, true);
        assert.equal(count(h, 'execute', id), 0);
      } else assert.match(JSON.stringify(result.content), /FINAL REDACTED/);
      for (const type of ['tool_execution_start', 'tool_execution_end']) assert.equal(events.filter(e => e.type === type && e.id === id).length, 1);
      for (const kind of ['pre', 'last-pre']) assert.equal(count(h, kind, id), 1);
      for (const kind of ['execute', 'post', 'last-post']) assert.equal(count(h, kind, id), id === 'core-denied' ? 0 : 1);
    }
    assert.equal(count(h, 'post', 'core-fg/1'), 1);
    assert.equal(count(h, 'post', 'core-bg/1'), 1);
    assert.equal((h.session as unknown as { _beforeToolCall: unknown })._beforeToolCall, before);
    assert.deepEqual(h.errors, []);
  } finally { unsubscribe(); await h.close(); }
});

test('real SDK: native denial, invalid arguments, admission failure and cooperative cancellation', async () => {
  const h = await sdk(true, 1);
  try {
    const blocked = await h.call('victim', { n: '2', mode: 'blocked', __background__: 'yes' }, 'blocked');
    assert.equal(blocked.isError, true); assert.equal(count(h, 'execute', 'blocked'), 0); assert.equal(count(h, 'post', 'blocked'), 0);
    assert.equal(h.tasks().length, 0);
    const lateBlocked = await h.call('victim', { n: '2', mode: 'late-blocked', __background__: 'yes' }, 'late-blocked');
    assert.match(JSON.stringify(lateBlocked.result), /late native denial/);
    assert.equal(lateBlocked.isError, true);
    for (const kind of ['execute', 'post']) assert.equal(count(h, kind, 'late-blocked'), 0);
    assert.equal(count(h, 'last-pre', 'late-blocked'), 1);
    const invalid = await h.call('victim', { n: '2', mode: 'normal', extra: true }, 'invalid');
    assert.equal(invalid.isError, true); assert.equal(count(h, 'pre', 'invalid'), 0); assert.equal(h.tasks().length, 0);
    const handle = await h.call('victim', { n: '2', mode: 'cancel', __background__: 'yes' }, 'cancel');
    assert.equal((handle.result.structuredContent as any).result_available, false);
    const rejected = await h.call('victim', { n: '2', mode: 'normal', __background__: 'yes' }, 'capacity');
    assert.equal(rejected.isError, true); assert.equal(count(h, 'execute', 'capacity'), 0);
    assert.equal(count(h, 'post', 'capacity'), 1, 'failed admission retains native outer finalization');
    assert.match(JSON.stringify(rejected.result), /FINAL REDACTED/);
    const task = h.tasks()[0];
    await h.call('meantime', { action: 'cancel', ids: [task.id ]});
    const saved = await h.retained('cancel');
    assert.equal(h.signals.get('cancel')?.aborted, true);
    assert.equal(saved.task.isError, true); clean(saved.outcome);
    assert.equal(count(h, 'execute', 'cancel'), 1); assert.equal(count(h, 'post', 'cancel'), 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('real SDK: same-owner replacement, hidden/restored spread, metadata and owned restoration', async () => {
  const h = await sdk(true);
  try {
    const raw = h.session.getToolDefinition('victim')!;
    const metadata = h.session.getAllTools().find(t => t.name === 'victim')!;
    const prepareLoadout = raw.prepareLoadout;
    assert.equal(raw, h.definition);
    assert.equal(raw.namespace, h.definition.namespace);
    assert.equal(raw.annotations, h.definition.annotations);
    assert.equal(raw.prepareLoadout, prepareLoadout);
    let replacements = 0;
    const replacement = { ...raw,
      parameters: { type: 'object', properties: { replacement: { type: 'boolean' } }, required: ['replacement'], additionalProperties: false },
      prepareArguments: (args: unknown) => args,
      execute: async () => { replacements++; return { content: [{ type: 'text' as const, text: 'NEW IMPLEMENTATION' }], details: undefined }; },
    } as unknown as ToolDefinition;
    const replacementSchema = replacement.parameters;
    h.owner.registerTool(replacement);
    assert.equal(h.session.getToolDefinition('victim'), replacement);
    assert.deepEqual(h.session.getAllTools().find(t => t.name === 'victim')!.sourceInfo, metadata.sourceInfo);
    // The copied AgentTool schema must refresh with the owner's registration.
    const obsolete = await h.call('victim', { n: '2', mode: 'normal' }, 'obsolete');
    assert.equal(obsolete.isError, true);
    assert.equal(count(h, 'pre', 'obsolete'), 0);
    // The old permission handlers mutate n but are intentionally not rerun by
    // the carrier; the replacement schema is validated before that mutation.
    await h.call('victim', { replacement: true, __background__: 'no' }, 'replacement');
    assert.equal(replacements, 1);
    const hidden = { ...replacement, exposure: 'hidden' as const };
    h.owner.registerTool(hidden);
    assert.equal((h.plugin!.inspect() as any).managed.includes('victim'), false);
    h.owner.registerTool({ ...hidden, exposure: 'direct' });
    assert.equal((h.plugin!.inspect() as any).managed.includes('victim'), true);
    await h.call('victim', { replacement: true, __background__: 'no' }, 'restored');
    assert.equal(replacements, 2, 'spread decorated definitions do not recurse');
    const current = h.session.getToolDefinition('victim')!;
    assert.equal(current.prepareLoadout, prepareLoadout);
    assert.equal(current.description, raw.description);
    assert.equal(current.namespace, raw.namespace);
    const foreign = async () => ({ content: [], details: undefined });
    current.execute = foreign;
    await h.plugin!.dispose();
    assert.equal(current.execute, foreign, 'dispose restores only properties still owned by plugin');
    assert.deepEqual(current.parameters, replacementSchema);
  } finally { await h.close(); }
});

test('real SDK: weak result fence isolates overlapping reused object IDs; unmanaged primitive/array inputs pass through', async () => {
  const h = await sdk(true);
  try {
    for (const [name, args] of [['primitive', 'valid string'], ['array', [1, 2]], ['unmanaged', { __background__: 'business-value' }]] as const) {
      assert.equal((await h.call(name, args, name)).isError, false);
      assert.equal(count(h, 'exotic', name), 1);
      assert.equal(count(h, 'post', name), 1);
    }
    const oldGate = deferred<void>(); h.gates.set('reused', oldGate);
    const old = h.call('unmanaged', {}, 'reused');
    const primitiveGate = deferred<void>(); h.gates.set('old-primitive', primitiveGate);
    const primitive = h.call('primitive', 'old string', 'old-primitive');
    await until(() => count(h, 'exotic', 'reused') === 1 && count(h, 'exotic', 'old-primitive') === 1);
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
    await h.session.bindExtensions({ mode: 'rpc', onError: error => h.errors.push(error) });
    const freshGate = deferred<void>(); h.gates.set('reused', freshGate);
    const fresh = h.call('unmanaged', {}, 'reused');
    await until(() => count(h, 'exotic', 'reused') === 2);
    oldGate.resolve(); primitiveGate.resolve(); await old; await primitive;
    assert.equal(count(h, 'post', 'reused'), 0, 'old args cannot reach successor hooks');
    assert.equal(count(h, 'post', 'old-primitive'), 0, 'primitive fallback also fences retired results');
    freshGate.resolve(); await fresh;
    assert.equal(count(h, 'post', 'reused'), 1, 'old end cannot erase fresh object marker');
    assert.deepEqual(h.errors, []);
  } finally { for (const gate of h.gates.values()) gate.resolve(); await h.close(); }
});

test('real SDK: noncooperative retired job cannot enter successor hooks or nested dispatcher', async () => {
  const h = await sdk(true);
  try {
    const gate = deferred<void>(); h.gates.set('old', gate);
    await h.call('victim', { n: '2', mode: 'old', __background__: 'yes' }, 'old');
    // Unlike old's deferred dispatch, this unmanaged child enters the native
    // pipeline while its managed producer still belongs to the live generation.
    const childGate = deferred<void>(); h.gates.set('active-old/1', childGate);
    await h.call('victim', { n: '2', mode: 'nested', __background__: 'yes' }, 'active-old');
    assert.equal(count(h, 'child', 'active-old/1'), 1);
    assert.equal(count(h, 'pre', 'active-old/1'), 1);
    assert.equal(count(h, 'post', 'active-old/1'), 0);
    await h.session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' });
    await h.session.bindExtensions({ mode: 'rpc', onError: error => { h.errors.push(error); } });
    assert.equal((h.plugin!.inspect() as any).managed.includes('victim'), true);
    gate.resolve(); childGate.resolve();
    await until(() => count(h, 'child-settled', 'active-old/1') === 1);
    // Resolving old resumes a nested call; active-old's already-running child
    // settles. Neither path may dispatch finalizers into the successor runtime.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(count(h, 'child', 'old/1'), 0);
    assert.equal(count(h, 'pre', 'old/1'), 0);
    assert.equal(count(h, 'post', 'old'), 0);
    assert.equal(count(h, 'post', 'active-old/1'), 0, 'late unmanaged child cannot enter successor result hooks');
    assert.equal(count(h, 'post', 'active-old'), 0);
    assert.equal(count(h, 'child', 'active-old/1'), 1, 'no duplicate child effect');
    assert.equal(h.notices.length, 0);
    const fresh = await h.call('victim', { n: '2', mode: 'normal', __background__: 'no' }, 'fresh');
    assert.match(JSON.stringify(fresh.result), /FINAL REDACTED/);
    assert.equal(count(h, 'execute', 'fresh'), 1);
    assert.equal(count(h, 'post', 'fresh'), 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
