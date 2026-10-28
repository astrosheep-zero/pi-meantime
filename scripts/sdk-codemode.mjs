/** Actual Pi 1.3 + in-place builtin execution wrapper + native QuickJS workers.
 * Offline synthetic provider only. No paid API, install, CLI/TUI or worker patch.
 * Uses the pinned SDK by default; PI_TEST_SDK_MODULES can select installed Pi's
 * node_modules to exercise the bundled host identity as well.
 * Run: node --experimental-strip-types scripts/sdk-codemode.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { captureCodemodeExecute } from '../src/codemode.ts';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
const base = process.env.PI_TEST_SDK_MODULES;
const sdk = base ? await import(base + '/@earendil-works/pi-coding-agent/dist/bundle/index.js') : await import('@earendil-works/pi-coding-agent');
const { createAssistantMessageEventStream } = base ? await import(base + '/@earendil-works/pi-ai/dist/utils/event-stream.js') : await import('@earendil-works/pi-ai/compat');
const root = fs.mkdtempSync('/tmp/meantime-native-codemode-');
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const config = { autoDetachMs: 50, notifyDebounceMs: 5, shutdownGraceMs: 10 };
fs.writeFileSync(root + '/settings.json', JSON.stringify({ meantime: config }));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const toolUsage = { input: 3, output: 2, cacheRead: 4, cacheWrite: 6, cacheWrite1h: 1, reasoning: 1, totalTokens: 15,
  cost: { input: 0.03125, output: 0.0625, cacheRead: 0.125, cacheWrite: 0.25, total: 0.46875 } };
const model = { id: 'probe', name: 'probe', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'http://invalid', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 100000, maxTokens: 1000 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const gates = new Map(), starts = new Map(), signals = new Map();
const hooks = [], events = [], contexts = [], plans = [], bodies = [];
const notices = new Map(), originalDetails = new Map();
let session, generation = 0;
function gate(key) { gates.set(key, deferred()); starts.set(key, deferred()); }
function aborted(key) {
  const signal = signals.get(key);
  return signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}
// Native script results/close() precede actual thread exit. Observe Node's public
// worker lifecycle without patching the executor, worker or two-worker admission.
const workerExits = new Set();
const workerChannel = channel('worker_threads');
const observeWorker = ({ worker }) => {
  const exited = deferred();
  workerExits.add(exited.promise);
  worker.once('exit', () => { workerExits.delete(exited.promise); exited.resolve(); });
};
workerChannel.subscribe(observeWorker);
const workersExited = label => bounded(Promise.all([...workerExits]), label);
const settings = sdk.SettingsManager.inMemory({ defaultTools: ['codemode', 'meantime', 'hold', 'second', 'child'], codemode: { mode: 'only' }, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  // The bundled installed host supplies Jiti's virtual modules. The development
  // SDK's unbundled imports instead use its official inline factory API.
  additionalExtensionPaths: base ? [fileURLToPath(new URL('../index.mjs', import.meta.url))] : [],
  extensionFactories: [{ name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension() }, ...(!base ? [pi => {
    install(pi, { config: validateConfig(config), codemodeExecute: captureCodemodeExecute(pi, sdk.createCodemodeExtension) });
  }] : []), pi => {
    const ownGeneration = ++generation;
    pi.registerTool({ name: 'hold', label: 'hold', description: 'Held fixture', parameters: { type: 'object', properties: { key: { type: 'string' }, uncooperative: { type: 'boolean' } }, required: ['key'] }, outputSchema: { type: 'object' },
      async execute(id, args, signal) {
        bodies.push({ id, key: args.key }); signals.set(args.key, signal); starts.get(args.key)?.resolve();
        await (args.uncooperative ? gates.get(args.key).promise : Promise.race([gates.get(args.key).promise, new Promise((_, reject) => {
          if (signal.aborted) reject(Error('cancelled'));
          else signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
        })]));
        return { content: [{ type: 'text', text: 'hold' }], details: {}, structuredContent: { value: 40 }, usage: toolUsage };
      } });
    pi.registerTool({ name: 'second', label: 'second', description: 'Second fixture', parameters: { type: 'object', properties: { value: { type: 'number' }, tag: { type: 'string' } } }, outputSchema: { type: 'object' },
      async execute(id, args) { bodies.push({ id, ...args }); return { content: [{ type: 'text', text: 'second' }], details: {}, structuredContent: { value: args.value }, usage: toolUsage }; } });
    pi.registerTool({ name: 'child', label: 'child', description: 'Explicit detached child with late grandchildren', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }, outputSchema: { type: 'object' },
      async execute(id, args, signal, _update, ctx) {
        bodies.push({ id, key: args.key }); signals.set(args.key, signal); starts.get(args.key)?.resolve();
        await gates.get(args.key).promise;
        const first = await ctx.executeTool('second', { value: 1 });
        const second = await ctx.executeTool('second', { value: first.result.structuredContent.value + 1 });
        const details = args.key === 'bigint' ? { nonJson: 1n } : {};
        if (args.key === 'cycle') details.self = details;
        originalDetails.set(args.key, details);
        return { content: [{ type: 'text', text: 'child' }], details, structuredContent: second.result.structuredContent, usage: toolUsage };
      } });
    pi.on('tool_call', async e => {
      hooks.push({ kind: 'call', id: e.toolCallId, parent: e.parentToolCallId, generation: ownGeneration });
      // Trigger while the root is still in the permission pipeline. This also
      // checks inherited user intent without racing QuickJS worker startup.
      if (e.toolCallId === 'manual-steer') await session.steer('redirect without abort', undefined, { source: 'rpc' });
      if (e.toolCallId === 'manual-command' || e.toolCallId.startsWith('unsafe-root-')) await session.prompt('/meantime detach');
    });
    pi.on('tool_result', e => {
      hooks.push({ kind: 'result', id: e.toolCallId, parent: e.parentToolCallId, generation: ownGeneration });
      if (e.toolName === 'second') return { structuredContent: { value: e.structuredContent.value + 1 } };
      if (e.toolCallId.startsWith('unsafe-root-')) return { details: originalDetails.get(e.toolCallId.slice('unsafe-root-'.length)) ?? { nonJson: 1n }, usage: toolUsage };
    });
  }],
});
// Keep watchdogs real while the focused steer scenario advances runtime timers.
const watchdog = { setTimeout, clearTimeout };
async function bounded(promise, label) {
  assert(label, 'every bounded wait needs a diagnostic label');
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = watchdog.setTimeout(() => reject(Error('Timed out: ' + label)), 10000); })]); }
  finally { watchdog.clearTimeout(timer); }
}
// Late metadata has no SDK event; yield until its actual persisted/drained state,
// rather than assuming one event-loop turn is sufficient.
async function until(predicate, label) {
  let stopped = false;
  try {
    await bounded((async () => { while (!stopped && !predicate()) await new Promise(resolve => setImmediate(resolve)); })(), label);
  } finally { stopped = true; }
}
async function prompt(name, args, id, { overlap = false } = {}) {
  await bounded(session.waitForIdle(), 'idle before ' + id);
  if (name === 'codemode' && !overlap) await workersExited('native workers exited before ' + id);
  plans.push({ type: 'toolCall', name, arguments: args, id });
  await bounded(session.prompt('offline fixture ' + id), id);
  return session.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === id);
}
async function control(args, signal = new AbortController().signal) {
  const toolCall = { type: 'toolCall', id: 'control-' + Math.random(), name: 'meantime', arguments: args };
  return runToolCall(toolCall, { tools: session.agent.state.tools, assistantMessage: session.messages.findLast(m => m.role === 'assistant'),
    context: { messages: session.messages, tools: session.agent.state.tools }, signal,
    beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
}
const taskId = message => message.details.id;
const completions = () => session.sessionManager.getEntries().filter(e => e.customType === 'meantime-index' && e.data.change.completion).map(e => e.data.change.completion);
function scriptResult(c) { return c.result.content.filter(b => b.type === 'text').map(b => b.text).join(''); }
function bindStream() {
  assert.deepEqual(loader.getExtensions().warnings ?? [], [], 'no replacement warning, including reload/reopen');
  assert.equal(loader.getExtensions().extensions.filter(e => e.tools.has('codemode')).length, 1, 'only builtin registers codemode');
  assert.equal(session.getAllTools().find(t => t.name === 'codemode').sourceInfo.path, 'builtin:codemode');
  session.agent.streamFunction = (_model, context) => {
    contexts.push(structuredClone(context));
    const stream = createAssistantMessageEventStream(), plan = plans.shift();
    const message = { role: 'assistant', content: plan ? [plan] : [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: plan ? 'toolUse' : 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
  };
}
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert(loader.getExtensions().extensions.some(e => e.path === 'builtin:codemode'), 'builtin remains loaded');
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  const runtime = await sdk.ModelRuntime.create({ authPath: root + '/auth.json', modelsPath: root + '/models.json', offline: true });
  await runtime.setRuntimeApiKey('anthropic', 'offline-dummy');
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.create(root, root + '/sessions') }));
  const errors = [];
  const originalDefinition = session.getToolDefinition('codemode');
  const originalDescriptors = Object.getOwnPropertyDescriptors(originalDefinition);
  await session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e) });
  session.subscribe(e => {
    if (e.type.startsWith('tool_execution') || e.type === 'agent_end') events.push(e);
    if (e.type === 'message_end' && e.message.customType === 'meantime-completion') {
      for (const id of e.message.details.taskIds) notices.get(id)?.resolve(e.message);
    }
  });
  bindStream();
  const native = session.getToolDefinition('codemode');
  assert.equal(native, originalDefinition, 'builtin definition object stays intact');
  const { execute: managedExecute, ...unchanged } = Object.getOwnPropertyDescriptors(native);
  const { execute: originalExecute, ...originalMetadata } = originalDescriptors;
  assert.notEqual(managedExecute.value, originalExecute.value, 'only execute is wrapped');
  assert.deepEqual(unchanged, originalMetadata, 'loadout, schema, grammar and renderers stay native');
  assert.equal(native.exposure, 'model-only'); assert.equal(native.defaultActive, false);
  assert.equal(native.constrainedSampling.type, 'grammar');
  assert.deepEqual(Object.keys(native.parameters.properties), ['code'], 'raw grammar/schema unchanged');
  assert(native.reachesTools({ code: 'return ALL_TOOLS' }) === 'all');
  assert.equal(session.getToolDefinition('meantime').exposure, 'model-only');

  gate('continue');
  const early = await prompt('codemode', { code: 'let local=1; try { const a=await tools.hold({key:"continue"}); local+=a.value; const b=await tools.second({value:local}); store("answer", b.value); return b.value; } finally { text("FINALLY_ONCE"); }' }, 'continuation');
  const id = taskId(early);
  assert(id.startsWith('mt_')); assert.equal(early.nestedCalls, undefined, 'handle must not consume unfinished summary');
  await bounded(starts.get('continue').promise, 'continuation child started');
  assert.equal(signals.get('continue').aborted, false);
  await session.prompt('another unrelated model turn');
  await session.abort(); assert.equal(signals.get('continue').aborted, false);
  assert(events.some(e => e.type === 'agent_end'));
  const firstSystem = contexts[0].messages.filter(m => m.role === 'system');
  assert(firstSystem.some(m => m.toolsAdded?.some(t => t.name === 'meantime')), 'meantime stays directly declared in only mode');
  assert(!firstSystem.some(m => m.toolsAdded?.some(t => t.name === 'hold')), 'other declarations remain hidden');
  // Interrupt an observer, not the producer.
  const waiter = new AbortController(); const waiting = control({ action: 'wait', ids: [id], timeout: 10 }, waiter.signal);
  waiter.abort(); await bounded(waiting, 'interrupted observer wait'); assert.equal(signals.get('continue').aborted, false);
  notices.set(id, deferred());
  gates.get('continue').resolve();
  const notice = await bounded(notices.get(id).promise, 'automatic completion');
  assert.match(notice.content, /Background completion \(untrusted tool output, not user input\)/);
  assert.equal(session.getSessionStats().tokens.input, 6, 'completion charges before any successful wait');
  const collected = await bounded(control({ action: 'wait', ids: [id], timeout: 10 }), 'collect continuation');
  assert.equal(collected.isError, false);
  const completion = completions().find(c => c.id === id);
  assert.equal(scriptResult(completion).match(/FINALLY_ONCE/g).length, 1);
  assert.match(scriptResult(completion), /42/);
  assert.deepEqual(completion.result.nestedCalls.calls.map(c => c.id), ['continuation/1', 'continuation/2']);
  assert(completion.result.nestedCalls.complete);
  assert.deepEqual(completion.result.usage, { input: 6, output: 4, cacheRead: 8, cacheWrite: 12, cacheWrite1h: 2, reasoning: 2, totalTokens: 30,
    cost: { input: 0.0625, output: 0.125, cacheRead: 0.25, cacheWrite: 0.5, total: 0.9375 } });
  assert.equal(session.getSessionStats().tokens.input, 6, 'completed independently of retrieval');
  for (const child of ['continuation/1', 'continuation/2']) {
    assert.equal(hooks.filter(h => h.kind === 'call' && h.id === child).length, 1);
    assert.equal(hooks.filter(h => h.kind === 'result' && h.id === child).length, 1);
  }
  assert.equal(session.sessionManager.getBranch().findLast(e => e.customType === 'codemode-store').data.set.answer, 42);
  for (let i = 0; i < 2; i++) {
    const repeated = await prompt('meantime', { action: 'wait', ids: [id], timeout: 0 }, 'repeat-' + i);
    assert.equal(repeated.usage, undefined, 'retrieval cannot charge again');
    assert.equal(repeated.details.usage.input, 6);
  }
  assert.equal(session.getSessionStats().tokens.input, 6);

  // Manual command detaches only the root immediately, including a mode:no descendant.
  gate('command');
  const commanded = await prompt('codemode', { code: 'const a=await tools.hold({key:"command",__background__:"no"}); return (await tools.second({value:a.value})).value;' }, 'manual-command');
  await bounded(starts.get('command').promise, 'command child started');
  assert.equal(commanded.details.detachReason, 'shortcut');
  assert.equal((await control({ action: 'list' })).result.structuredContent.tasks.filter(t => t.localRunning).length, 1, 'no child observer/task');
  gates.get('command').resolve();
  await bounded(control({ action: 'wait', ids: [taskId(commanded)], timeout: 10 }), 'command root completed');
  assert.match(scriptResult(completions().find(c => c.id === taskId(commanded))), /41/);

  // A foreground producer still uses native message_start for summary/charge.
  // Disable detachment via Pi's native sequential mode, not a timing guess about
  // worker startup on loaded machines.
  session.agent.toolExecution = 'sequential';
  const foreground = await prompt('codemode', { code: 'const x=await tools.second({value:6}); return {value:x.value, models:typeof models.getModelsOfType, found:(await describeTool("second"))!==undefined, stored:load("answer"), control:"meantime" in tools, controlListed:ALL_TOOLS.some(t=>t.name==="meantime"), controlDescribed:(await describeTool("meantime"))!==undefined};' }, 'foreground');
  session.agent.toolExecution = 'parallel';
  assert.equal(foreground.isError, false, JSON.stringify(foreground));
  assert.equal(foreground.usage.input, 3);
  assert.deepEqual(foreground.nestedCalls.calls.map(c => c.id), ['foreground/1']);
  assert.match(JSON.stringify(foreground.content), /models.*function/);
  assert.match(JSON.stringify(foreground.content), /stored.*42/);
  const output = foreground.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const visibility = JSON.parse(output.slice(output.indexOf('Output:\n') + 'Output:\n'.length));
  assert.equal(visibility.control, false, 'control is not callable inside scripts');
  assert.equal(visibility.controlListed, false);
  assert.equal(visibility.controlDescribed, false);
  assert(!completions().some(c => c.toolCallId === 'foreground'), 'foreground has no linked completion or extra accounting');
  // Explicit child yes is independent even when automatic root detach is OFF.
  // Both unknown-details cases exercise real append-only JSONL and real waits.
  config.autoDetachMs = 0;
  fs.writeFileSync(root + '/settings.json', JSON.stringify({ meantime: config }));
  await bounded(session.reload(), 'reload with automatic detach off'); bindStream();
  assert.deepEqual(Object.getOwnPropertyDescriptors(originalDefinition), originalDescriptors, 'retired builtin fully restored');

  // Exercise the real native root with inherited steer, but advance its common
  // runtime clock/timer deterministically. Worker startup is still a real barrier.
  await workersExited('native workers exited before steer clock');
  gate('steer');
  let now = 1000, steerReturned = false, steered;
  const monotonic = mock.method(performance, 'now', () => now);
  mock.timers.enable({ apis: ['setTimeout'] });
  const tick = ms => { now += ms; mock.timers.tick(ms); };
  try {
    const pending = prompt('codemode', { code: 'let local=1; try { const a=await tools.hold({key:"steer",__background__:"no"}); local+=a.value; const b=await tools.second({value:local}); return b.value; } finally { text("STEER_FINALLY_ONCE"); }' }, 'manual-steer').then(value => { steerReturned = true; return value; });
    await bounded(starts.get('steer').promise, 'steer child started before deadline');
    await new Promise(resolve => setImmediate(resolve));
    tick(1000); await session.steer('repeated redirect', undefined, { source: 'rpc' });
    tick(1999);
    assert.equal(steerReturned, false, 'native root must remain foreground until 3s, even after repeated steer');
    const live = (await control({ action: 'list' })).result.structuredContent.tasks.filter(t => t.localRunning);
    assert.deepEqual(live.map(t => [t.tool, t.delivery]), [['codemode', 'foreground']], 'no independent ordinary child observer');
    assert.equal(signals.get('steer').aborted, false);
    tick(1); steered = await bounded(pending, 'steer root detached at startup deadline');
    assert.equal(steered.details.detachReason, 'steer');
  } finally { mock.timers.reset(); monotonic.mock.restore(); }
  await session.prompt('unrelated after guarded steer');
  await session.abort(); assert.equal(signals.get('steer').aborted, false);
  gates.get('steer').resolve();
  await bounded(control({ action: 'wait', ids: [taskId(steered)], timeout: 10 }), 'steered root continued');
  const steerCompletion = completions().find(c => c.id === taskId(steered));
  assert.match(scriptResult(steerCompletion), /42/);
  assert.equal(scriptResult(steerCompletion).match(/STEER_FINALLY_ONCE/g).length, 1);
  assert.deepEqual(steerCompletion.result.nestedCalls.calls.map(c => c.id), ['manual-steer/1', 'manual-steer/2']);
  for (const child of ['manual-steer/1', 'manual-steer/2']) {
    assert.equal(hooks.filter(h => h.kind === 'call' && h.id === child).length, 1);
    assert.equal(hooks.filter(h => h.kind === 'result' && h.id === child).length, 1);
  }
  assert.equal(bodies.filter(b => b.key === 'steer').length, 1, 'no cancellation/replay of the held producer');

  for (const key of ['child', 'bigint', 'cycle']) {
    const before = session.getSessionStats().tokens.input;
    const rootId = key === 'child' ? 'explicit' : 'unsafe-root-' + key;
    gate(key);
    const observed = await prompt('codemode', { code: `const h=await tools.child({key:"${key}",__background__:"yes"}); return {child:h.task.id};` }, rootId);
    await bounded(starts.get(key).promise, key + ' child started');
    const rootResult = key === 'child' ? observed : (await control({ action: 'wait', ids: [taskId(observed)], timeout: 10 })).result;
    const output = rootResult.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const childId = JSON.parse(output.slice(output.indexOf('Output:\n') + 'Output:\n'.length).split('Non-JSON')[0]).child;
    assert(childId.startsWith('mt_'), 'native script returns child handle BEFORE child gate opens');
    assert.equal(signals.get(key).aborted, false);
    const live = (await control({ action: 'list' })).result.structuredContent.tasks.filter(t => t.localRunning);
    assert.deepEqual(live.map(t => t.tool), ['child'], 'no root observer/admission left waiting on independent child');
    assert(!completions().some(c => c.toolCallId === rootId && c.lateScope));
    await session.prompt('unrelated while child is detached');
    gates.get(key).resolve();
    await bounded(control({ action: 'wait', ids: [childId], timeout: 10 }), key + ' child completed');
    await until(() => completions().some(c => c.toolCallId === rootId && c.lateScope)
      && session._nestedToolCalls.scopes.size === 0, key + ' late scope indexed and drained');
    const explicit = completions().findLast(c => c.toolCallId === rootId && c.lateScope);
    assert(explicit, 'late root metadata is linked, not a blocked frontend return');
    assert.deepEqual(explicit.result.nestedCalls.calls.map(c => c.id), [rootId + '/1', rootId + '/1/1', rootId + '/1/2']);
    assert(explicit.result.nestedCalls.complete);
    const nestedUsage = { input: 9, output: 6, cacheRead: 12, cacheWrite: 18, cacheWrite1h: 3, reasoning: 3, totalTokens: 45,
      cost: { input: 0.09375, output: 0.1875, cacheRead: 0.375, cacheWrite: 0.75, total: 1.40625 } };
    assert.deepEqual(explicit.nestedUsage, nestedUsage, 'late nested delta excludes already-charged root usage');
    assert.deepEqual(explicit.result.usage, key === 'child' ? nestedUsage : {
      input: 12, output: 8, cacheRead: 16, cacheWrite: 24, cacheWrite1h: 4, reasoning: 4, totalTokens: 60,
      cost: { input: 0.125, output: 0.25, cacheRead: 0.5, cacheWrite: 1, total: 1.875 },
    }, 'full result includes root-own usage without mutating the nested delta');
    assert.equal(session.getSessionStats().tokens.input, before + (key === 'child' ? 9 : 12));
    const retrieved = await prompt('meantime', { action: 'wait', ids: [childId], timeout: 0 }, 'safe-wait-' + key);
    assert.equal(retrieved.usage, undefined);
    if (key !== 'child') {
      assert.deepEqual(retrieved.details.persistenceOmissions, ['details']);
      const childCompletion = completions().findLast(c => c.id === childId);
      assert.deepEqual(childCompletion.result.persistenceOmissions, ['details']);
      assert.equal(childCompletion.result.structuredContent.value, 4);
      assert.deepEqual(explicit.result.persistenceOmissions, ['details'], 'root unknown details also cannot prevent accounting');
      if (key === 'bigint') assert.equal(originalDetails.get(key).nonJson, 1n);
      else assert.equal(originalDetails.get(key).self, originalDetails.get(key));
    }
    const file = session.sessionManager.getSessionFile();
    const disk = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert(disk.every(e => !e.parentId || disk.some(parent => parent.id === e.parentId)), 'no references to unwritten parent');
    const reopened = sdk.SessionManager.open(file);
    assert.deepEqual(reopened.getBranch().map(e => e.id), session.sessionManager.getBranch().map(e => e.id), 'JSONL reopens the complete active branch');
    assert.equal(session.getSessionStats().tokens.input, before + (key === 'child' ? 9 : 12), 'wait did not charge again');
    assert.equal(session._nestedToolCalls.scopes.size, 0);
  }
  // A finished foreground root is absent from tasks, but shutdown must still
  // cancel/drain its retained child scope before creating the successor runner.
  gate('shutdown-child');
  const independent = await prompt('codemode', { code: 'return await tools.child({key:"shutdown-child",__background__:"yes"});' }, 'finished-root');
  assert.match(JSON.stringify(independent.content), /mt_/);
  await bounded(starts.get('shutdown-child').promise, 'finished-root child started');
  let reloaded = false;
  const replacing = session.reload().then(() => { reloaded = true; });
  await bounded(aborted('shutdown-child'), 'finished-root child aborted by reload');
  assert.equal(signals.get('shutdown-child').aborted, true);
  assert.equal(reloaded, false, 'finished root still owns its late scope drain');
  gates.get('shutdown-child').resolve();
  await bounded(replacing, 'finished-root reload drained'); bindStream();
  assert.equal(session._nestedToolCalls.scopes.size, 0);

  config.autoDetachMs = 50;
  fs.writeFileSync(root + '/settings.json', JSON.stringify({ meantime: config }));
  await bounded(session.reload(), 'reload with automatic detach on'); bindStream();

  // Only this scenario overlaps workers: A/B must both enter their held child
  // before the third call tests native fail-fast admission (no queue or retry).
  for (const key of ['A', 'B']) {
    gate(key);
    const held = await prompt('codemode', { code: `await tools.hold({key:"${key}"}); store("${key}", true); return 42;` }, 'capacity-' + key, { overlap: key === 'B' });
    assert.equal(held.isError, false);
    await bounded(starts.get(key).promise, 'capacity-' + key + ' child started');
  }
  assert.equal(workerExits.size, 2, 'both native threads observed before testing fail-fast admission');
  const third = await prompt('codemode', { code: 'return 6*7;' }, 'capacity-third', { overlap: true });
  assert.equal(third.isError, true); assert.match(JSON.stringify(third.content), /worker limit reached \(2/);
  const list = await prompt('meantime', { action: 'list' }, 'capacity-list');
  const a = list.details.tasks.find(t => t.tool === 'codemode' && t.localRunning && t.id === taskId(session.messages.find(m => m.toolCallId === 'capacity-A' && m.role === 'toolResult')));
  const cancelled = await prompt('meantime', { action: 'cancel', ids: [a.id ]}, 'capacity-cancel');
  assert.equal(cancelled.details.task.state, 'cancelled'); assert.equal(signals.get('A').aborted, true);
  gates.get('B').resolve();
  const bId = taskId(session.messages.find(m => m.toolCallId === 'capacity-B' && m.role === 'toolResult'));
  await bounded(control({ action: 'wait', ids: [bId], timeout: 10 }), 'capacity-B completed');
  assert(!session.sessionManager.getBranch().some(e => e.customType === 'codemode-store' && e.data.set.A));

  // A native abort can settle before its non-cooperative nested pipeline. The
  // task/transition must not call that drained or lose its late result/usage.
  gate('late');
  const late = await prompt('codemode', { code: 'await tools.hold({key:"late",uncooperative:true}); store("wrongBranch",true); return 1;' }, 'late-root');
  await bounded(starts.get('late').promise, 'late child started');
  const beforeLeaf = session.sessionManager.getBranch().find(e => e.type === 'message' && e.message.role === 'user').id;
  let treeFinished = false;
  const tree = session.navigateTree(beforeLeaf).then(r => { treeFinished = true; return r; });
  await bounded(aborted('late'), 'late child aborted by tree navigation');
  await workersExited('native abort exited before late child drain');
  assert.equal(signals.get('late').aborted, true); assert.equal(treeFinished, false, 'tree waits actual nested pipeline drain');
  assert(!completions().some(c => c.id === taskId(late) && c.lateScope));
  gates.get('late').resolve(); await bounded(tree, 'tree drain');
  assert(!session.sessionManager.getEntries().some(e => e.customType === 'codemode-store' && e.data.set.wrongBranch));
  assert.equal(session._nestedToolCalls.scopes.size, 0);

  gate('reload');
  await prompt('codemode', { code: 'await tools.hold({key:"reload"}); store("afterReload",true);' }, 'reload-root');
  await bounded(starts.get('reload').promise, 'reload child started');
  const oldGeneration = generation;
  await bounded(session.reload(), 'reload'); bindStream();
  assert.equal(signals.get('reload').aborted, true); assert(generation > oldGeneration);
  assert.equal(Object.hasOwn(session, '_executeNestedToolCall'), false, 'instance bridge restores prototype lookup');
  assert.equal(Object.hasOwn(session._nestedToolCalls, 'takeRecord'), false);
  assert.equal(Object.hasOwn(session._nestedToolCalls, 'clear'), false);
  assert.equal(Object.hasOwn(session._nestedToolCalls.scopes, 'delete'), false);
  gates.get('reload').resolve();
  assert(!session.sessionManager.getEntries().some(e => e.customType === 'codemode-store' && e.data.set.afterReload));
  assert(!hooks.some(h => h.id.startsWith('reload-root') && h.generation > oldGeneration));

  await bounded(session.waitForIdle(), 'idle before final persistence checks');
  const file = session.sessionManager.getSessionFile();
  const jsonl = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const linked = jsonl.find(e => e.customType === 'meantime-index' && e.data.change.completion?.id === id).data.change.completion;
  assert.deepEqual(linked, JSON.parse(JSON.stringify(completion)));
  assert.equal(jsonl.filter(e => e.type === 'usage' && e.note?.includes(':' + id + ':')).length, 1);
  assert.equal(jsonl.find(e => e.message?.toolCallId === 'continuation' && e.message.role === 'toolResult').message.nestedCalls, undefined, 'append-only handle was not retroactively patched');
  const reopened = sdk.SessionManager.open(file);
  const reopenedUsage = reopened.getEntries().reduce((n, e) => n + (e.type === 'usage' ? e.usage.input : e.type === 'message' && e.message.role === 'toolResult' ? e.message.usage?.input ?? 0 : 0), 0);
  assert.equal(reopenedUsage, session.getSessionStats().tokens.input);
  assert.deepEqual(reopened.getEntries().find(e => e.customType === 'meantime-index' && e.data.change.completion?.id === id).data.change.completion, JSON.parse(JSON.stringify(completion)));
  await bounded(session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }), 'shutdown before reopening');
  await workersExited('native workers exited before reopening');
  session.dispose();
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: reopened }));
  await session.bindExtensions({ mode: 'rpc', onError: e => errors.push(e) }); bindStream();
  assert.equal(session.getSessionStats().tokens.input, reopenedUsage, 'real reopened SDK session accounting');
  const recovered = await prompt('meantime', { action: 'wait', ids: [id], timeout: 0 }, 'reopened-wait');
  assert.equal(recovered.details.task.recovered, true);
  assert.deepEqual(recovered.details.nestedCalls, JSON.parse(JSON.stringify(completion.result.nestedCalls)));
  assert.equal(recovered.details.usage.input, 6);
  assert.equal(session.getSessionStats().tokens.input, reopenedUsage, 'reopened retrieval does not recharge');
  assert.deepEqual(errors, []);
  console.log('NATIVE_CODEMODE_PASS', JSON.stringify({ sessionFile: file, linkedCompletion: id, usageInput: reopenedUsage,
    verified: ['in-place builtin/zero replacement warnings/metadata and restoration', 'normal continuation/local/finally/post-hook values', 'nested IDs/events/records', 'independent child yes with timer off', 'late grandchildren/scope delta accounting', 'BigInt/cycle preflight/JSONL parent integrity', 'wait interruption', '3s inherited steer/repeated steer/native continuation', 'native two-worker capacity/direct controls/only mode', 'cancel/tree drain/reload including finished roots', 'JSONL/reopened usage/repeated waits'] }));
} finally {
  for (const pending of gates.values()) pending.resolve();
  try {
    if (session) await bounded(session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }), 'final shutdown');
    session?.dispose();
    await workersExited('final native worker exits');
  } finally { workerChannel.unsubscribe(observeWorker); }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  // Evidence JSONL deliberately remains in /tmp; no user session/config was used.
}
