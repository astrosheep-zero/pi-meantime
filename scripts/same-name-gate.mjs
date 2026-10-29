/** Integration gate for the proposed same-name execute mutation.
 * Run: node --experimental-strip-types scripts/same-name-gate.mjs
 * Real Pi SDK + production TaskRuntime; no network/model request or user settings.
 * Exit 1 means the proposal violates result-hook parity, not a broken harness.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { validateConfig } from '../src/config.ts';
import { TaskRuntime } from '../src/runtime.ts';
import { decorateSchema, splitControl } from '../src/schema.ts';

const root = mkdtempSync(join(tmpdir(), 'meantime-same-name-'));
const config = validateConfig({ autoDetachMs: 0, shutdownGraceMs: 100 });
const runtime = new TaskRuntime(config, { notify() {}, index() {} });
const observations = [];
const pending = new Map();
let session;
let source;
let before = 0;
let executions = 0;
let taskSequence = 0;
const patches = new WeakSet();
const taskIds = new Map();
const schema = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
const fixture = (version = 'v1', exposure = 'direct') => ({
  name: 'target', label: 'target', description: 'Result-hook parity fixture', parameters: schema, exposure,
  async execute(_id, args) {
    executions++;
    assert.equal(args.__background__, undefined, 'control must not reach original implementation');
    if (pending.has(args.key)) await pending.get(args.key).promise;
    return { content: [{ type: 'text', text: `${version}:${version === 'v1' ? 'RAW_FIXTURE' : 'RAW_V2'}` }], details: undefined };
  },
});
const sourceExtension = pi => {
  source = pi;
  pi.registerTool(fixture());
  pi.on('tool_call', e => {
    if (e.toolName !== 'target') return;
    before++;
    if (e.input.key === 'denied') return { block: true, reason: 'DENIED_FIXTURE' };
  });
  pi.on('tool_result', e => {
    if (e.toolName !== 'target') return;
    observations.push({ id: e.toolCallId, content: e.content, handle: e.structuredContent?.result_available === false });
    // A valid tool-specific hook: redact its actual text, leave task handles alone.
    if (e.content.some(b => b.type === 'text' && b.text.includes('RAW_FIXTURE'))) {
      return { content: [{ type: 'text', text: 'REDACTED_FIXTURE' }], isError: true };
    }
  });
};
const wrapperExtension = pi => {
  pi.registerTool({
    name: 'gate', label: 'gate', description: 'Integration probe', parameters: { type: 'object', properties: {} },
    prepareLoadout(loadout) {
      for (const tool of loadout.registered) {
        if (!['target', 'bash'].includes(tool.name) || patches.has(tool)) continue;
        const next = tool.execute;
        tool.parameters = decorateSchema(tool.parameters);
        tool.outputSchema = {};
        tool.execute = async (callId, params, signal, onUpdate) => {
          const split = splitControl(params);
          const view = await runtime.run({
            tool: tool.name, kind: tool.name === 'bash' ? 'bash' : 'tool', callId, mode: split.mode,
            canDetach: true, parentSignal: signal, onUpdate,
            async execute(jobSignal, update) {
              const result = await next(callId, split.args, jobSignal, update);
              return { result, isError: result.isError === true };
            },
          });
          taskIds.set(params.key ?? callId, view.task.id);
          if (view.kind === 'handle') return {
            content: [{ type: 'text', text: `Task ${view.task.id} is running` }], details: view.task,
            structuredContent: { task: view.task, result_available: false },
          };
          if (view.thrown) throw view.thrown.error;
          return view.result;
        };
        patches.add(tool);
      }
    },
    async execute(_id, args, signal, _update, ctx) {
      const outcome = await ctx.executeTool(args.tool ?? 'target', args.input ?? {}, { signal });
      return { ...outcome.result, isError: outcome.isError };
    },
  });
};
function deferred(key) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  pending.set(key, { promise, resolve });
  return resolve;
}
const text = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
async function waitForTask(id) {
  const deadline = Date.now() + 3000;
  while (runtime.get(id).localRunning) {
    if (Date.now() > deadline) throw new Error('producer did not settle');
    await new Promise(r => setTimeout(r, 5));
  }
  return runtime.result(id);
}
try {
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['target', 'gate', 'bash', 'codemode'] });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: join(root, 'agent'), settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [sourceExtension, wrapperExtension, sdk.createCodemodeExtension({ mode: 'on' })],
  });
  await loader.reload();
  const manager = sdk.SessionManager.inMemory(root);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'gate', name: 'gate', arguments: {} }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() });
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), resourceLoader: loader, settingsManager, sessionManager: manager }));
  await session.bindExtensions({ mode: 'rpc' });
  const call = (tool, input) => session.agent.state.tools.find(t => t.name === 'gate').execute(`gate-${++taskSequence}`, { tool, input }, new AbortController().signal);
  const fg = await call('target', { key: 'fg', __background__: 'no' });
  assert.equal(text(fg), 'REDACTED_FIXTURE');
  assert.equal(fg.isError, true);
  assert.equal(executions, 1);
  const fgStored = { result: fg, task: { isError: fg.isError } };
  const count = executions;
  assert.match(text(await call('target', { key: 'denied' })), /DENIED_FIXTURE/);
  assert.equal(executions, count, 'permission denial must prevent execution');

  const release = deferred('bg');
  const handle = await call('target', { key: 'bg', __background__: 'yes' });
  assert.equal(handle.structuredContent.result_available, false);
  const id = handle.structuredContent.task.id;
  const afterHandle = observations.length;
  release();
  const bgStored = await waitForTask(id);
  assert.equal(observations.length, afterHandle, 'late producer completion does not emit tool_result');

  // A real QuickJS codemode script reaches the patched original by its original name.
  const codeTool = session.agent.state.tools.find(t => t.name === 'codemode');
  assert.ok(codeTool, 'real codemode extension must be active');
  const code = await codeTool.execute('code-gate', { code: 'text(await tools.target({key:"code",__background__:"no"}));' }, new AbortController().signal);
  assert.match(text(code), /REDACTED_FIXTURE/);
  const bash = await call('bash', { command: 'printf SAME_NAME_BASH', __background__: 'no' });
  assert.match(text(bash), /SAME_NAME_BASH/);

  source.registerTool(fixture('v2'));
  await call('target', { key: 'v2', __background__: 'no' });
  assert.match(text(await call('target', { key: 'v2-check', __background__: 'no' })), /^v2:/);
  source.registerTool(fixture('v2', 'hidden'));
  assert.match(text(await call('target', { key: 'hidden' })), /not found|not available|not callable/i);
  source.registerTool(fixture('v2'));
  await call('target', { key: 'restored', __background__: 'no' });
  assert.match(text(await call('target', { key: 'restored-check', __background__: 'no' })), /^v2:/);

  const report = {
    passed: ['same name', 'strict input schema', 'control stripping', 'permission denial', 'background detach', 'real codemode', 'native bash', 'source update/withdrawal/restoration'],
    foreground: { returned: text(fg), stored: text(fgStored.result), hookIsError: fg.isError, storedIsError: fgStored.task.isError },
    background: { hookReceivedHandle: observations.some(o => o.handle), hookCalledOnCompletion: false,
      stored: text(bgStored.result), storedIsError: bgStored.task.isError },
    beforeHookCalls: before, originalExecutions: executions,
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(text(fgStored.result), 'REDACTED_FIXTURE', 'BLOCKER: same-name execute wrapper persists pre-hook output');
  assert.equal(text(bgStored.result), 'REDACTED_FIXTURE', 'BLOCKER: detached actual result never reaches original result hook');
} finally {
  for (const item of pending.values()) item.resolve();
  await runtime.close();
  if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
  rmSync(root, { recursive: true, force: true });
}
