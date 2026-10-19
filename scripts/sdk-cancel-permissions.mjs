/** Real pinned Pi 1.3.0 hook/permission regression. No provider or credentials.
 * Run: node --experimental-strip-types scripts/sdk-cancel-permissions.mjs
 * Optional: --evidence=./evidence/sdk-cancel-permissions
 * Uses only public SDK entrypoints, extension APIs and UI bindings. The UI
 * adapter supplies test choices; this is not a human terminal UI acceptance.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { TaskRuntime } from '../src/runtime.ts';

const sdkVersion = sdk.VERSION;
assert.equal(sdkVersion, '1.3.0', 'Run against the exact SDK under review');
const evidenceArg = process.argv.find(arg => arg.startsWith('--evidence='));
const evidenceDir = evidenceArg ? resolve(evidenceArg.slice('--evidence='.length)) : undefined;
const root = mkdtempSync(join(tmpdir(), 'pi-bg-sdk-hooks-'));
const mcpCallLog = join(root, 'mcp-call-receipts.jsonl');
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const events = []; const checks = []; const errors = []; const calls = new Map();
const original = 'sdk_fixture_judgment';
const proxy = `${original}_mt`;
const mcpOriginal = 'mcp__sdk_permissions__stubborn';
const mcpProxy = `${mcpOriginal}_mt`;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let session; let extension; let pendingChoice; let gate;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const turn = () => new Promise(resolveTurn => setImmediate(resolveTurn));
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await delay(5); }
}
function makeResult(rawError, tag) {
  return { content: [{ type: 'text', text: `RAW:${tag}` }], details: { tag, retained: true },
    structuredContent: { tag, nested: { value: 7 }, rawError }, isError: rawError };
}
function bodyCount() { return [...calls.values()].reduce((sum, value) => sum + value, 0); }
function mcpCallCount() { return existsSync(mcpCallLog) ? readFileSync(mcpCallLog, 'utf8').trim().split('\n').filter(Boolean).length : 0; }
function tasks() { return extension.inspect().tasks; }
async function check(name, fn) {
  try { const detail = await fn(); checks.push({ name, pass: true, ...detail }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, pass: false, error: String(error), stack: error.stack }); console.error(`FAIL ${name}: ${error}`); }
}
async function invoke(name, args, { id = `call-${events.length}-${Date.now()}`, signal } = {}) {
  const toolCall = { type: 'toolCall', id, name, arguments: args };
  const assistantMessage = { role: 'assistant', content: [toolCall], api: 'openai-completions', provider: 'fixture',
    model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() };
  session.sessionManager.appendMessage(assistantMessage);
  session.refreshContext();
  const outcome = await runToolCall(toolCall, {
    tools: session.agent.state.tools, assistantMessage,
    context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
    beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall, signal,
  });
  events.push({ type: 'finalized_outcome', id, name, isError: outcome.isError,
    payloadIsError: outcome.result.isError, task: outcome.result.structuredContent?.task,
    resultAvailable: outcome.result.structuredContent?.result_available });
  return outcome;
}
function assertReleased() {
  assert.equal(TaskRuntime.liveProducerCount(), 0, 'producer admission/controller lease must be released');
  assert.equal(tasks().filter(t => t.localRunning).length, 0, 'no task left running');
}

try {
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'meantime', original] });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager,
    extensionFactories: [sdk.createMcpExtension(), pi => {
      pi.registerMcpServer('sdk_permissions', { command: process.execPath,
        args: [fileURLToPath(new URL('../test/fixtures/sdk-permissions-mcp.mjs', import.meta.url)), mcpCallLog], exposure: 'direct', timeout: 10 });
      pi.registerTool({ name: original, label: original, description: 'Synthetic real-SDK hook fixture',
        executionMode: 'parallel', parameters: { type: 'object', properties: {
          rawError: { type: 'boolean' }, finalError: { type: 'boolean' }, tag: { type: 'string' }, waitForAbort: { type: 'boolean' },
        }, required: ['rawError', 'tag'], additionalProperties: false },
        outputSchema: { type: 'object' },
        async execute(_id, args, signal) {
          calls.set(args.tag, (calls.get(args.tag) ?? 0) + 1);
          events.push({ type: 'fixture_body_start', tag: args.tag });
          if (args.waitForAbort) {
            if (!signal?.aborted) await new Promise(resolveAbort => signal.addEventListener('abort', resolveAbort, { once: true }));
            return { ...makeResult(true, args.tag), content: [{ type: 'text', text: `NATIVE_CANCEL:${args.tag}` }] };
          }
          return makeResult(args.rawError, args.tag);
        },
      });
      extension = install(pi, { config: validateConfig({ autoDetachMs: 15,
        include: ['sdk_fixture_*', 'mcp__sdk_permissions__*'], blockOriginalCalls: false, shutdownGraceMs: 100, maxRunning: 1 }),
        makeBash: cwd => sdk.createBashToolDefinition(cwd) });
      pi.on('tool_result', event => {
        events.push({ type: event.type, name: event.toolName, id: event.toolCallId,
          parentId: event.parentToolCallId, isError: event.isError });
        if (event.toolName === original && typeof event.input.finalError === 'boolean') return { isError: event.input.finalError };
      });
      // Same public extension permission mechanism as the SDK's shipped
      // examples/extensions/permission-gate.ts, registered AFTER our wrapper.
      pi.on('tool_call', async (event, ctx) => {
        events.push({ type: event.type, name: event.toolName, id: event.toolCallId, parentId: event.parentToolCallId });
        if (!gate || event.toolName !== gate.name) return;
        if (gate.plainBlock) return { block: true, reason: 'FIXTURE_HOOK_BLOCK' };
        if (!ctx.hasUI) return { block: true, reason: 'FIXTURE_NO_UI_DENY' };
        const choice = await ctx.ui.select('Fixture permission request', ['Yes', 'No']);
        if (choice !== 'Yes') return { block: true, reason: 'FIXTURE_PERMISSION_DENIED' };
      });
      for (const type of ['ui_prompt_start', 'ui_prompt_end', 'tool_execution_end']) pi.on(type, event => {
        events.push({ type, name: event.toolName, parentId: event.parentToolCallId, id: event.toolCallId,
          isError: event.isError, kind: event.kind });
      });
    }],
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager,
    sessionManager: sdk.SessionManager.inMemory(root) }));
  const uiContext = { ...session.extensionRunner.getUIContext(), select: async (title, options) => {
    assert.equal(pendingChoice, undefined, 'only one synthetic UI request may be pending');
    events.push({ type: 'ui_adapter_select', title, options });
    return new Promise(resolveChoice => { pendingChoice = choice => { pendingChoice = undefined; resolveChoice(choice); }; });
  } };
  await session.bindExtensions({ mode: 'rpc', uiContext, onError: error => errors.push({ event: error.event, error: error.error }) });
  await until(() => session.getAllTools().some(tool => tool.name === mcpProxy), 'MCP proxy registration timed out', 10000);
  session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), original, proxy, mcpOriginal, mcpProxy, 'meantime'])]);
  await turn();

  for (const [rawError, finalError] of [[true, false], [false, true]]) {
    await check(`official_hook_${rawError}_to_${finalError}`, async () => {
      gate = undefined;
      const native = await invoke(original, { rawError, finalError, tag: 'hook-native' });
      assert.equal(native.result.isError, rawError, 'SDK preserves pre-hook result flag');
      assert.equal(native.isError, finalError, 'SDK final outcome is authoritative');
      assert.deepEqual(native.result.content, makeResult(rawError, 'hook-native').content);
      assert.deepEqual(native.result.structuredContent, makeResult(rawError, 'hook-native').structuredContent);
      const wrapped = await invoke(proxy, { rawError, finalError, tag: 'hook-wrapped', __background__: 'no' });
      assert.equal(wrapped.isError, finalError);
      assert.equal(wrapped.result.isError, finalError);
      assert.deepEqual(wrapped.result.content, makeResult(rawError, 'hook-wrapped').content);
      assert.deepEqual(wrapped.result.details, makeResult(rawError, 'hook-wrapped').details);
      assert.deepEqual(wrapped.result.structuredContent, makeResult(rawError, 'hook-wrapped').structuredContent);
      assert.equal(tasks().length, 0, 'foreground result needs no retained task');
      await turn(); assertReleased();
      return { nativeResultFlag: native.result.isError, nativeFinalFlag: native.isError,
        wrappedFinalFlag: wrapped.isError };
    });
  }

  for (const finalError of [undefined, false]) await check(finalError === undefined
    ? 'sdk_native_cancel_error_and_wrapped_failed' : 'sdk_native_cancel_hook_success_and_wrapped_completed', async () => {
    gate = undefined;
    const nativeController = new AbortController();
    const tag = finalError === false ? 'cancel-hook' : 'cancel';
    const nativePending = invoke(original, { rawError: true, tag: `${tag}-native`, waitForAbort: true,
      ...(finalError === undefined ? {} : { finalError }) }, { signal: nativeController.signal });
    await until(() => calls.has(`${tag}-native`), 'native body did not start');
    nativeController.abort();
    const native = await nativePending;
    const wrappedController = new AbortController();
    const wrappedPending = invoke(proxy, { rawError: true, tag: `${tag}-wrapped`, waitForAbort: true, __background__: 'no',
      ...(finalError === undefined ? {} : { finalError }) }, { signal: wrappedController.signal });
    await until(() => calls.has(`${tag}-wrapped`), 'wrapped body did not start');
    wrappedController.abort();
    const wrapped = await wrappedPending;
    const expectedError = finalError ?? true;
    assert.equal(native.isError, expectedError); assert.equal(wrapped.isError, expectedError);
    assert.equal(wrapped.result.isError, expectedError);
    assert.deepEqual(wrapped.result.content, [{ type: 'text', text: `NATIVE_CANCEL:${tag}-wrapped` }]);
    assert.deepEqual(wrapped.result.structuredContent, makeResult(true, `${tag}-wrapped`).structuredContent);
    assert.equal(tasks().length, 0);
    await turn(); assertReleased();
    return { nativeFinalFlag: native.isError, wrappedFinalFlag: wrapped.isError };
  });

  await check('outer_permission_denial_prevents_task_admission', async () => {
    gate = { name: proxy };
    const beforeTasks = tasks().length; const beforeCalls = bodyCount(); const beforeEvents = events.length;
    let settled = false;
    const pending = invoke(proxy, { rawError: false, tag: 'outer-denied', __background__: 'yes' }).then(value => { settled = true; return value; });
    await until(() => pendingChoice, 'outer permission selector did not open');
    await delay(50);
    assert.equal(settled, false); assert.equal(tasks().length, beforeTasks); assert.equal(bodyCount(), beforeCalls);
    pendingChoice('No'); const outcome = await pending; await turn();
    assert.equal(outcome.isError, true); assert.match(outcome.result.content[0].text, /FIXTURE_PERMISSION_DENIED/);
    assert.equal(tasks().length, beforeTasks); assert.equal(bodyCount(), beforeCalls); assertReleased();
    const promptEvents = events.slice(beforeEvents).filter(event => event.type.startsWith('ui_prompt_'));
    assert.deepEqual(promptEvents.map(event => event.type), ['ui_prompt_start', 'ui_prompt_end']);
    return { newTasks: 0, bodyStarts: 0, promptEvents, liveProducers: TaskRuntime.liveProducerCount() };
  });

  await check('nested_permission_denial_never_starts_business_or_leaks_running_task', async () => {
    gate = { name: original };
    const beforeCalls = bodyCount(); const beforeEvents = events.length;
    let settled = false;
    const pending = invoke(proxy, { rawError: false, tag: 'inner-denied', __background__: 'yes' }).then(value => { settled = true; return value; });
    await until(() => pendingChoice, 'nested permission selector did not open');
    await delay(50);
    assert.equal(settled, false, 'explicit background must not resolve while approval is pending');
    assert.equal(bodyCount(), beforeCalls);
    const pendingTask = tasks().find(task => task.localRunning);
    assert.ok(pendingTask); assert.equal(pendingTask.delivery, 'foreground');
    pendingChoice('No'); const outcome = await pending;
    await until(() => TaskRuntime.liveProducerCount() === 0, 'denial retained a live producer');
    assert.equal(bodyCount(), beforeCalls);
    assert.equal(tasks().find(item => item.id === pendingTask.id), undefined);
    assert.match(outcome.result.content[0].text, /FIXTURE_PERMISSION_DENIED/);
    const promptEvents = events.slice(beforeEvents).filter(event => event.type.startsWith('ui_prompt_'));
    assert.deepEqual(promptEvents.map(event => event.type), ['ui_prompt_start', 'ui_prompt_end']);
    assertReleased();
    // A denial must be returned directly, not transformed into a successful
    // background handle by the ui_prompt_end / detach microtask race.
    assert.equal(outcome.isError, true, 'denial must be surfaced as the finalized error');
    assert.equal(outcome.result.structuredContent?.task, undefined);
    return { bodyStarts: 0, promptEvents, liveProducers: TaskRuntime.liveProducerCount() };
  });

  await check('nested_mcp_permission_denial_prevents_side_effect', async () => {
    gate = { name: mcpOriginal };
    const marker = join(root, 'mcp-forbidden-side-effect');
    const beforeMcpCalls = mcpCallCount();
    let settled = false;
    const pending = invoke(mcpProxy, { ms: 1, marker, __background__: 'yes' }).then(value => { settled = true; return value; });
    await until(() => pendingChoice, 'MCP permission selector did not open');
    await delay(50); assert.equal(settled, false); assert.equal(existsSync(marker), false);
    pendingChoice('No'); const outcome = await pending;
    await until(() => TaskRuntime.liveProducerCount() === 0, 'MCP denial retained producer');
    await delay(30); assert.equal(existsSync(marker), false); assert.equal(mcpCallCount(), beforeMcpCalls); assertReleased();
    assert.equal(outcome.result.structuredContent?.task, undefined);
    assert.match(outcome.result.content[0].text, /FIXTURE_PERMISSION_DENIED/);
    assert.equal(outcome.isError, true, 'MCP denial must be surfaced as finalized error');
    return { mcpRequestsReceived: mcpCallCount() - beforeMcpCalls, sideEffectCreated: false,
      liveProducers: TaskRuntime.liveProducerCount() };
  });

  await check('approved_mcp_request_reuses_capacity_and_runs_once', async () => {
    gate = { name: mcpOriginal };
    const marker = join(root, 'mcp-approved-side-effect'); const beforeMcpCalls = mcpCallCount();
    const pending = invoke(mcpProxy, { ms: 60, marker, __background__: 'yes' });
    await until(() => pendingChoice, 'MCP approval selector did not open');
    assert.equal(mcpCallCount(), beforeMcpCalls);
    pendingChoice('Yes'); const outcome = await pending;
    assert.equal(outcome.isError, false); assert.equal(outcome.result.structuredContent.result_available, false);
    const id = outcome.result.structuredContent.task.id;
    await until(() => TaskRuntime.liveProducerCount() === 0, 'approved MCP call did not settle');
    assert.equal(mcpCallCount() - beforeMcpCalls, 1); assert.equal(existsSync(marker), true);
    const task = tasks().find(item => item.id === id);
    assert.equal(task.state, 'completed'); assert.equal(task.isError, false); assertReleased();
    return { mcpRequestsReceived: 1, state: task.state, maxRunning: 1, liveProducers: TaskRuntime.liveProducerCount() };
  });

  await check('no_ui_permission_gate_fails_closed', async () => {
    gate = { name: original }; const beforeCalls = bodyCount(); const beforeEvents = events.length;
    session.extensionRunner.setUIContext(undefined, 'print');
    try {
      const outcome = await invoke(proxy, { rawError: false, tag: 'no-ui-denied', __background__: 'no' });
      await turn();
      assert.equal(outcome.isError, true); assert.equal(bodyCount(), beforeCalls); assertReleased();
      assert.ok(outcome.result.content.some(block => block.text?.includes('FIXTURE_NO_UI_DENY')));
      assert.equal(events.slice(beforeEvents).filter(event => event.type.startsWith('ui_prompt_')).length, 0);
      return { bodyStarts: 0, promptEvents: 0, kind: 'permission extension no-UI fail-closed path' };
    } finally { session.extensionRunner.setUIContext(uiContext, 'rpc'); }
  });

  await check('plain_tool_call_block_is_not_claimed_as_permission_ui', async () => {
    gate = { name: original, plainBlock: true };
    const beforeEvents = events.length; const beforeCalls = bodyCount();
    const outcome = await invoke(proxy, { rawError: false, tag: 'hook-block', __background__: 'no' });
    await turn();
    assert.equal(outcome.isError, true); assert.equal(bodyCount(), beforeCalls); assertReleased();
    assert.equal(events.slice(beforeEvents).filter(event => event.type.startsWith('ui_prompt_')).length, 0);
    assert.ok(outcome.result.content.some(block => block.text?.includes('FIXTURE_HOOK_BLOCK')));
    return { bodyStarts: 0, promptEvents: 0, kind: 'tool_call hook block only' };
  });
} finally {
  pendingChoice?.('No');
  try { if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
  finally {
    try { await extension?.dispose(); }
    finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  }
}
const report = { sdkVersion, nodeVersion: process.version, checkedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(['../src/runtime.ts', '../src/extension.ts', './sdk-cancel-permissions.mjs']
    .map(file => [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')])),
  scope: 'Real SDK runToolCall, public session hooks, ctx.executeTool, official MCP stdio, synthetic permission UI adapter',
  limitations: ['No real provider or credentials', 'UI choices supplied by test adapter, not human TUI acceptance',
    'MCP transport is local stdio; remote transport belongs to separate acceptance'],
  checks, errors, finalLiveProducers: TaskRuntime.liveProducerCount(), events };
if (evidenceDir) { mkdirSync(evidenceDir, { recursive: true }); writeFileSync(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const failed = checks.filter(check => !check.pass);
if (failed.length || errors.length || report.finalLiveProducers) process.exitCode = 1;
console.log(`REAL_SDK_CANCEL_PERMISSIONS_${process.exitCode ? 'FAIL' : 'PASS'}: ${checks.length - failed.length}/${checks.length} checks; ${errors.length} extension errors; ${report.finalLiveProducers} live producers.`);
