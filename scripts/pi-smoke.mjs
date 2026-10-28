/** Optional REAL SDK smoke: no external model request, credentials or user configuration.
 * Uses the pinned development dependency @earendil-works/pi-coding-agent@1.3.0.
 * Scripted provider exercises real model-request/tool/follow-up orchestration.
 * No external provider calls.
 * This exercises official registration, schema processing, native Bash and nested
 * MCP dispatch in a headless SDK session. Human TUI steering is a separate gate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
let sdk;
try { sdk = await import('@earendil-works/pi-coding-agent'); }
catch (error) {
  console.error('REAL_PI_SMOKE_NOT_RUN: install @earendil-works/pi-coding-agent@1.3.0 with Node >=22.19.0.');
  console.error(String(error)); process.exitCode = 2;
}
if (sdk) {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-real-sdk-'));
  let session; let extension;
  const outputs = [];
  const largeMcpText = '\x1b[31m\x00HEAD' + 'M'.repeat(60000) + 'TAIL\x1b[0m';
  const nativeMcpResults = new Map();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    await batchCodemodeParity(sdk, root);
    for (const scenario of ['outer-approval', 'outer-denial', 'codemode-startup', 'body', 'disabled', 'execution-start']) {
      await earlySteerRace(sdk, root, scenario);
    }
    for (const scenario of ['active-tool', 'batch-boundary', 'in-flight', 'before-wait', 'unobserved', 'partial', 'timeout', 'compact', 'compact-cancel', 'tree', 'tree-cancel']) {
      await completionRace(sdk, root, scenario);
    }
    await controlGuidance(sdk, root);
    const baseline = await nativeMcpBaseline(sdk, root, largeMcpText);
    outputs.push({ path: baseline.details.fullOutputPath });
    const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'meantime'] });
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: join(root, 'agent'), settingsManager,
      extensionFactories: [sdk.createMcpExtension(), pi => {
        pi.registerMcpServer('meantime_fixture', {
          command: process.execPath,
          args: [fileURLToPath(new URL('../test/fixtures/mcp-server.mjs', import.meta.url))],
          exposure: 'direct', timeout: 10,
        });
        pi.on('tool_result', event => {
          if (event.toolName.startsWith('mcp__meantime_fixture__')) {
            nativeMcpResults.set(event.toolName, {
              content: event.content, details: event.details, structuredContent: event.structuredContent,
            });
          }
        });
        pi.registerTool({
          name: 'background_probe', label: 'background probe', description: 'Test nested background result retrieval',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            assert.ok(!ctx.tools.some(t => t.name === 'meantime'), 'model-only meantime is not callable from nested tools');
            const started = await ctx.executeTool('bash', { command: 'sleep 0.1; printf REAL_BACKGROUND_OK', __background__: 'yes' });
            assert.equal(started.result.structuredContent.result_available, false);
            return started.result;
          },
        });
        extension = install(pi, {
          config: validateConfig({ autoDetachMs: 0 }),
        });
      }],
    });
    await loader.reload();
    const manager = sdk.SessionManager.create(root, join(root, 'sessions'));
    // This is a synthetic recorded assistant call, not a model invocation.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'smoke', name: 'mcp__meantime_fixture__slow', arguments: { ms: 1 } }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, sessionManager: manager }));
    await session.bindExtensions({ mode: 'rpc' });
    const prompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'smoke' }, {
      cwd: root, sections: { existing: 'Keep other prompt sections.' },
    });
    assert.equal(prompt.systemPromptOptions.sections.existing, 'Keep other prompt sections.');
    assert.doesNotMatch(prompt.systemPromptOptions.sections.meantime, /_mt\b/);
    assert.match(prompt.systemPromptOptions.sections.meantime, /__background__/);
    const nextPrompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'again' }, prompt.systemPromptOptions);
    assert.equal(nextPrompt.systemPromptOptions.sections.meantime, prompt.systemPromptOptions.sections.meantime);
    const deadline = Date.now() + 8000;
    const target = 'mcp__meantime_fixture__slow';
    while (!session.getAllTools().some(t => t.name === target)) {
      if (Date.now() > deadline) throw new Error('MCP original registration timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // SDK may keep added MCP tools outside its initial active set. Explicit activation
    // here is part of the test setup, not the extension's production policy.
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), target, 'mcp__meantime_fixture__fail', 'meantime', 'bash', 'background_probe'])]);
    const result = await invoke(session, target, 'smoke', { ms: 1, text: 'REAL_PI_MCP_OK', __background__: 'no' });
    assert.ok(result.content.some(b => b.type === 'text' && b.text.includes('REAL_PI_MCP_OK')));
    assert.equal(result.structuredContent?.task, undefined);
    const shell = await invoke(session, 'bash', 'smoke-bash', { command: 'printf REAL_PI_BASH_OK', __background__: 'no' });
    assert.deepEqual(shell.content, [{ type: 'text', text: 'REAL_PI_BASH_OK' }]);
    assert.equal(shell.structuredContent.exit_code, 0);
    assert.equal(shell.structuredContent.task, undefined);
    assert.equal(manager.getEntries().filter(e => e.customType === 'meantime-index').length, 0);
    const probe = await invoke(session, 'background_probe', 'background-probe', { __background__: 'no' });
    const id = probe.structuredContent.task.id;
    const collected = await invoke(session, 'meantime', 'probe-real', { action: 'wait', ids: [id] });
    assert.equal(collected.isError, false);
    assert.equal(collected.structuredContent.result_available, true);
    assert.equal(collected.structuredContent.result.output, 'REAL_BACKGROUND_OK');
    assert.doesNotMatch(collected.content.map(b => b.text).join('\n'), /Output:/);
    for (const [tool, args] of [
      ['bash', { command: `sleep 0.1; node -e 'process.stdout.write("B".repeat(60000))'` }],
      ['mcp__meantime_fixture__slow', { ms: 100, text: largeMcpText }],
    ]) {
      const handle = await invoke(session, tool, `probe-start-${tool}`, { ...args, __background__: 'yes' });
      assert.equal(handle.structuredContent.result_available, false);
      const id = handle.structuredContent.task.id;
      const result = await invoke(session, 'meantime', `probe-wait-${tool}`, { action: 'wait', ids: [id] });
      assert.equal(result.isError, false);
      const task = result.structuredContent.task;
      assert.ok(task.outputPath, JSON.stringify({ tool, task, result: result.structuredContent.result }).slice(0, 2000));
      assert.equal(result.details.nativeDetails.fullOutputPath, task.outputPath, `${tool}: wait preserves native fullOutputPath`);
      assert.equal(result.details.task.id, task.id, `${tool}: control task stays beside the native envelope`);
      assert.match(result.content[0].text, /\nOutput: /);
      const retained = result.structuredContent.result;
      const text = result.content[1].text;
      if (tool.startsWith('mcp__')) {
        const native = nativeMcpResults.get('mcp__meantime_fixture__slow');
        assert.deepEqual(result.details.nativeDetails, native.details);
        assert.equal(task.outputPath, native.details.fullOutputPath);
        assert.deepEqual(result.content.slice(1), native.content);
        assert.deepEqual(retained, native.structuredContent);
        assert.match(text, /^Warning: truncated output/);
        assert.equal(text.replaceAll(task.outputPath, '<native-path>'),
          baseline.content[0].text.replaceAll(baseline.details.fullOutputPath, '<native-path>'));
        assert.ok(text.includes('\x1b[31m\x00HEAD'), 'native MCP controls must survive');
        assert.equal(retained.content[0].text, largeMcpText);
      } else {
        assert.equal(result.details.nativeDetails.truncation.truncated, true, 'wait preserves native Bash truncation');
      }
      assert.equal(readFileSync(task.outputPath, 'utf8'), tool === 'bash' ? 'B'.repeat(60000) : largeMcpText);
      outputs.push({ id, path: task.outputPath, text });
    }
    assert.equal(outputs[1].path.includes('pi-bash-'), true);
    assert.equal(outputs[2].path.includes('pi-mcp-'), true);
    const failed = await invoke(session, 'mcp__meantime_fixture__fail', 'probe-start-fail', { ms: 100, __background__: 'yes' });
    const failure = await invoke(session, 'meantime', 'probe-wait-fail', { action: 'wait', ids: [failed.structuredContent.task.id] });
    const nativeFailure = nativeMcpResults.get('mcp__meantime_fixture__fail');
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.task.state, 'failed');
    assert.deepEqual(failure.content.slice(1), nativeFailure.content);
    assert.deepEqual(failure.structuredContent.result, nativeFailure.structuredContent);
    assert.equal(failure.content[1].text, 'fixture failure');
    const sessionFile = manager.getSessionFile();
    const completions = manager.getEntries().filter(e => e.customType === 'meantime-index' && e.data.change.completion);
    assert.equal(completions.length, 4);
    for (const { id, path, text } of outputs.filter(o => o.id)) {
      const indexed = completions.find(e => e.data.change.completion.id === id).data.change.completion;
      assert.equal(indexed.text, text); assert.equal(indexed.outputPath, path);
    }
    const persisted = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const persistedCompletions = persisted.filter(e => e.customType === 'meantime-index' && e.data.change.completion);
    assert.deepEqual(persistedCompletions.map(e => e.data.change.completion),
      JSON.parse(JSON.stringify(completions.map(e => e.data.change.completion))));
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await extension.dispose();
    session.dispose();
    await loader.reload();
    const reopened = sdk.SessionManager.open(sessionFile);
    assert.equal(reopened.getEntries().filter(e => e.customType === 'meantime-index').length, 8);
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, sessionManager: reopened }));
    await session.bindExtensions({ mode: 'rpc' });
    session.setActiveToolsByName(['meantime']);
    const restored = await invoke(session, 'meantime', 'restored-result', { action: 'wait', timeout: 0, ids: [id] });
    assert.equal(restored.structuredContent.task.recovered, true);
    assert.equal(restored.structuredContent.result, 'REAL_BACKGROUND_OK');
    assert.match(restored.content.map(b => b.text).join('\n'), /contains text only/);
    for (const { id, path, text } of outputs.filter(o => o.id)) {
      const result = await invoke(session, 'meantime', `restored-output-${id}`, { action: 'wait', timeout: 0, ids: [id] });
      assert.equal(result.structuredContent.task.outputPath, path);
      assert.match(result.content[0].text, /\nOutput: /);
      assert.equal(result.content[1].text, text);
      assert.equal(result.structuredContent.result, text);
    }
  } finally {
    try {
      // AgentSession.dispose() invalidates context and listeners, but does not
      // emit session_shutdown. Dispatch the public lifecycle event first so
      // the official MCP extension closes its stdio clients and child process.
      // This mirrors AgentSessionRuntime.dispose(), without private imports.
      if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      try { await extension?.dispose(); }
      finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        for (const output of outputs) rmSync(output.path, { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log('REAL_PI_SMOKE_PASS: official SDK registration, nested MCP and native Bash; shutdown cleanup completed. No external model call; scripted provider completion-ordering regression passed. SDK RPC-mode detach and nested result retrieval passed; no actual TUI/CLI transport exercised.');
}

/** Dispatch a recorded assistant call through Pi's native preparation and hooks. */
async function invoke(session, name, id, args) {
  const toolCall = { type: 'toolCall', id, name, arguments: args };
  const assistantMessage = { role: 'assistant', content: [toolCall], api: 'openai-completions',
    provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  session.sessionManager.appendMessage(assistantMessage);
  session.refreshContext();
  await session.extensionRunner.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
  const outcome = await runToolCall(toolCall, {
    tools: session.agent.state.tools, assistantMessage,
    context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
    beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall,
    signal: new AbortController().signal,
  });
  await session.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: outcome.result, isError: outcome.isError });
  return { ...outcome.result, isError: outcome.isError };
}

/** Real QuickJS scripts, compared with the identical tools without meantime. */
async function batchCodemodeParity(sdk, root) {
  const observed = [];
  for (const managed of [false, true]) {
    let session, extension;
    const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['codemode', 'meantime'] });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, `batch-${managed}`), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [sdk.createCodemodeExtension({ mode: 'only' }), pi => {
        for (const structured of [true, false]) pi.registerTool({
          name: structured ? 'fixture_data' : 'fixture_text', label: 'fixture', description: 'Return a fixture value',
          exposure: 'codemode', executionMode: 'parallel',
          parameters: { type: 'object', properties: {} },
          ...(structured ? { outputSchema: { type: 'object', properties: { value: { type: 'string' } } } } : {}),
          async execute(_id, args) {
            assert.deepEqual(args, {}, 'execution control must not reach the original');
            await new Promise(resolve => setTimeout(resolve, 20));
            return { content: [{ type: 'text', text: structured ? 'DATA' : 'TEXT' }], details: undefined,
              ...(structured ? { structuredContent: { value: 'DATA' } } : {}) };
          },
        });
        if (managed) extension = install(pi, { config: validateConfig({ include: ['fixture_*'], autoDetachMs: 0 }) });
      }] });
    try {
      await loader.reload();
      const manager = sdk.SessionManager.inMemory(root);
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `batch-${managed}`, name: 'codemode', arguments: {} }],
        api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager,
        sessionManager: manager }));
      await session.bindExtensions({ mode: 'rpc' });
      if (managed) {
        assert.deepEqual(session.getToolDefinition('fixture_text').outputSchema, {}, 'unknown output permits structured handles without changing native text fallback');
        assert.equal(session.getToolDefinition('fixture_data').outputSchema.anyOf.length, 2, 'declared output accepts native data or handle');
      }
      const code = managed ? `
        const foreground = await Promise.all([tools.fixture_data({__background__: 'no'}), tools.fixture_text({__background__: 'no'})]);
        const handles = await Promise.all([tools.fixture_data({__background__: 'yes'}), tools.fixture_text({__background__: 'yes'})]);
        if (handles.some(h => typeof h !== 'object' || h.result_available !== false || !h.task.id)) throw new Error('structured handles required, including text-only native tools');
        if ('meantime' in tools || ALL_TOOLS.some(t => t.name === 'meantime')) throw new Error('model-only meantime must not be callable or listed inside scripts');
        return {foreground, handles};`
        : 'return [await tools.fixture_data({}), await tools.fixture_text({})];';
      const result = await invoke(session, 'codemode', `batch-${managed}`, { code });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const output = JSON.parse(text.slice(text.indexOf('Output:\n') + 'Output:\n'.length));
      if (!managed) observed.push(output);
      else {
        const { foreground, handles } = output;
        assert.ok(handles.every(h => typeof h === 'object' && h.result_available === false && h.task.id));
        const ids = handles.map(h => h.task.id);
        const singles = [];
        for (const [index, id] of ids.entries()) {
          const waited = await invoke(session, 'meantime', `batch-${index}-single`, { action: 'wait', ids: [id] });
          assert.equal(waited.isError ?? false, false, JSON.stringify(waited));
          singles.push(waited.structuredContent.result);
        }
        const batch = await invoke(session, 'meantime', 'batch-all', { action: 'wait', ids, timeout: 0 });
        assert.equal(batch.isError ?? false, false, JSON.stringify(batch));
        observed.push({ foreground, singles, batch: batch.structuredContent });
      }
    } finally {
      if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      await extension?.dispose(); session?.dispose();
    }
  }
  const [native, managed] = observed;
  console.log(`BATCH_CODEMODE: ${JSON.stringify({ native, singles: managed.singles,
    batch: managed.batch.tasks.map(t => ({ id: t.id, result_available: t.result_available, result: t.result })), pending: managed.batch.pending })}`);
  assert.deepEqual(managed.foreground, native, 'foreground preserves native structured/text programmatic values');
  assert.deepEqual(managed.singles, native, 'single wait matches tools without meantime');
  assert.deepEqual(managed.batch.tasks.map(t => t.result), native, 'batch wait must expose the same native structured/text results to scripts');
  assert.ok(managed.batch.tasks.every(t => t.result_available));
  assert.deepEqual(managed.batch.pending, []);
}

/** Alignment baseline: the same real MCP server/tool without meantime installed. */
async function nativeMcpBaseline(sdk, root, text) {
  let requests = 0, native;
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['mcp__meantime_fixture__slow'] });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, 'baseline-agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [sdk.createMcpExtension(), pi => {
      pi.registerMcpServer('meantime_fixture', { command: process.execPath,
        args: [fileURLToPath(new URL('../test/fixtures/mcp-server.mjs', import.meta.url))], exposure: 'direct', timeout: 10 });
      pi.on('tool_execution_end', event => { if (event.toolName === 'mcp__meantime_fixture__slow') native = event.result; });
      pi.registerProvider('native-fixture', { api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'unused',
        models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }],
        streamSimple(model) {
          const stream = createAssistantMessageEventStream(), first = ++requests === 1;
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: first ? [{ type: 'toolCall', id: 'baseline', name: 'mcp__meantime_fixture__slow', arguments: { ms: 1, text } }] : [{ type: 'text', text: 'done' }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
          stream.push({ type: 'start', partial: message });
          if (first) {
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
        } });
    }] });
  let session;
  try {
    await loader.reload();
    const manager = sdk.SessionManager.create(root, join(root, 'baseline-sessions'));
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, modelRuntime, sessionManager: manager }));
    await session.bindExtensions({ mode: 'rpc' });
    await session.setModel(modelRuntime.getModel('native-fixture', 'fixture'));
    const name = 'mcp__meantime_fixture__slow', deadline = Date.now() + 8000;
    while (!session.getAllTools().some(t => t.name === name)) {
      if (Date.now() > deadline) throw new Error('Baseline MCP registration timed out');
      await new Promise(r => setTimeout(r, 25));
    }
    session.setActiveToolsByName([name]);
    await session.prompt('exercise native result persistence');
    const result = native;
    const entries = readFileSync(manager.getSessionFile(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const persisted = entries.find(e => e.message?.role === 'toolResult' && e.message.toolName === name).message;
    assert.deepEqual(persisted.content, result.content);
    assert.equal(persisted.structuredContent, undefined, 'Pi toolResult history projects content/details, not structuredContent');
    assert.equal(persisted.details.fullOutputPath, result.details.fullOutputPath);
    assert.match(result.content[0].text, /^Warning: truncated output/);
    assert.ok(result.details.fullOutputPath);
    assert.equal(readFileSync(result.details.fullOutputPath, 'utf8'), text);
    console.log(`NATIVE_MCP_BASELINE: ${JSON.stringify({ nativeTextBytes: Buffer.byteLength(result.content[0].text), rawBytes: Buffer.byteLength(text), fullOutputPath: result.details.fullOutputPath })}`);
    return result;
  } finally {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
  }
}

/** Real AgentSession + scripted provider: no network/model credentials. The provider
 * chooses tools; Pi owns dispatch, follow-up queue, context and continuation turns.
 */
async function completionRace(sdk, root, scenario) {
  const trace = [], waitResults = [];
  let extension, session, requests = 0;
  const compact = scenario.startsWith('compact'), tree = scenario.startsWith('tree');
  const unread = scenario === 'unobserved' || scenario === 'active-tool' || scenario === 'batch-boundary' || compact || tree;
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'meantime'],
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: join(root, 'race-' + scenario), settingsManager,
    extensionFactories: [pi => {
      pi.registerProvider('completion-fixture', {
        api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'unused-fixture-key',
        models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            const n = ++requests;
            const completions = context.messages.filter(m => m.role === 'user' &&
              JSON.stringify(m.content).includes('Background completion (untrusted tool output, not user input)'));
            trace.push(`request ${n}: completion visible=${completions.length}`);
            let calls = [];
            if (n === 1) {
              calls = [{ id: 'start-a', name: 'bash', arguments: { command: 'sleep 0.12; printf RACE_A' } }];
              if (scenario === 'partial') calls.push({ id: 'start-b', name: 'bash', arguments: { command: 'sleep 0.06; printf RACE_B' } });
            } else if (n === 2 && (scenario === 'active-tool' || scenario === 'batch-boundary')) {
              calls = [{ id: 'foreground-work', name: 'bash', arguments: { command: 'sleep 0.35; printf FOREGROUND_DONE', __background__: 'no' } }];
            } else if (n === 2 && !unread) {
              // The second request is already streaming when the producer ends.
              // Delay tool selection to put completion handoff before wait's ack.
              if (scenario === 'before-wait') await new Promise(r => setTimeout(r, 350));
              const task = extension.inspect().tasks.find(t => t.command?.includes('RACE_A'));
              trace.push(`before wait: notification=${task.notification}, running=${task.localRunning}`);
              assert.equal(task.localRunning, scenario === 'in-flight' || scenario === 'timeout' || scenario === 'partial');
              calls = [{ id: 'collect', name: 'meantime', arguments: {
                action: 'wait', ids: [task.id], timeout: scenario === 'timeout' ? 0 : 2,
              } }];
            }
            const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
              content: calls.length ? calls.map(call => ({ type: 'toolCall', ...call })) : [{ type: 'text', text: 'done' }],
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now() };
            stream.push({ type: 'start', partial: message });
            for (let i = 0; i < message.content.length; i++) {
              const block = message.content[i];
              if (block.type === 'toolCall') {
                stream.push({ type: 'toolcall_start', contentIndex: i, partial: message });
                stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message });
              }
            }
            stream.push({ type: 'done', reason: message.stopReason, message });
            stream.end();
          })().catch(error => { stream.end(); console.error(error); process.exitCode = 1; });
          return stream;
        },
      });
      extension = install(pi, {
        config: validateConfig({ autoDetachMs: 10, notifyDebounceMs: scenario === 'batch-boundary' ? 5000 : 5 }),
      });
      if (compact) pi.on('session_before_compact', async event => {
        trace.push('manual compact start');
        await new Promise(r => setTimeout(r, 350));
        const task = extension.inspect().tasks[0];
        assert.equal(task.localRunning, false);
        assert.equal(task.notification, 'pending');
        trace.push('task finished/pending during compact');
        return scenario === 'compact-cancel' ? { cancel: true } : { compaction: {
          summary: 'fixture summary', firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
      if (tree) pi.on('session_before_tree', async () => {
        trace.push('tree start');
        await new Promise(r => setTimeout(r, 350));
        const task = extension.inspect().tasks[0];
        assert.equal(task.localRunning, false);
        assert.equal(task.notification, 'pending');
        trace.push('task finished/pending during tree');
        return scenario === 'tree-cancel' ? { cancel: true } : undefined;
      });
      pi.on('tool_execution_end', event => {
        if (event.toolName === 'bash' && event.toolCallId !== 'foreground-work') {
          trace.push(`handle ${event.toolCallId}: ${event.result.structuredContent?.task?.detachReason}`);
          assert.equal(event.result.structuredContent?.task?.detachReason, 'timeout');
        }
        if (event.toolName === 'meantime') {
          if (scenario === 'partial') assert.equal(extension.inspect().tasks.find(t => t.command?.includes('RACE_B')).notification, 'queued', 'B uses the fast path while wait(A) suppresses only A');
          waitResults.push(event.result);
          trace.push(`wait returned: available=${event.result.structuredContent?.result_available}`);
        }
      });
    }],
  });
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager,
      sessionManager: sdk.SessionManager.inMemory(root), modelRuntime }));
    await session.bindExtensions({ mode: 'rpc' });
    await session.setModel(modelRuntime.getModel('completion-fixture', 'fixture'));
    session.subscribe(event => {
      if (event.type === 'message_queued' || event.type === 'agent_settled') trace.push(event.type);
      if (event.type === 'message_end' && event.message.customType === 'meantime-completion') trace.push('completion delivered');
    });
    if (compact || tree) session.sessionManager.appendMessage({ role: 'user',
      content: 'older turn '.repeat(100), timestamp: Date.now() });
    const treeTarget = session.sessionManager.getLeafId();
    await session.prompt('exercise completion ordering');
    if (compact) {
      if (scenario === 'compact-cancel') await assert.rejects(session.compact(), /cancelled/);
      else await session.compact();
      trace.push(`manual compact ended: idle=${session.isIdle}`);
      // Failure flush is synchronous and may already have started the completion run.
      if (scenario === 'compact') assert.equal(session.isIdle, true);
    }
    if (tree) {
      const result = await session.navigateTree(treeTarget);
      assert.equal(result.cancelled, scenario === 'tree-cancel');
      trace.push(`tree ended: idle=${session.isIdle}`);
      assert.equal(session.isIdle, true);
      if (result.cancelled) {
        // No tree-end event on cancellation: next run must flush before its first request.
        await new Promise(r => setTimeout(r, 30));
        assert.equal(extension.inspect().tasks[0].notification, 'pending');
        assert.equal(session.messages.filter(m => m.customType === 'meantime-completion').length, 0);
        trace.push('tree cancelled: still pending, next prompt resumes');
        await session.prompt('resume after cancelled tree');
      }
    }
    // Idle producers still run after prompt resolves; give them time to notify.
    await new Promise(r => setTimeout(r, 500));
    await session.waitForIdle();
    const messages = session.messages.filter(m => m.customType === 'meantime-completion');
    const observed = !unread && scenario !== 'timeout';
    console.log(`COMPLETION_RACE ${scenario}: ${JSON.stringify({ trace, requests,
      notifications: messages.map(m => ({ taskIds: m.details.taskIds, content: m.content })) })}`);
    if (observed) {
      assert.equal(waitResults.length, 1);
      assert.equal(waitResults[0].structuredContent.result_available, true);
      assert.equal(waitResults[0].structuredContent.result.output, 'RACE_A');
    }
    // A wait acknowledges its task, but cannot retract a completion already
    // handed off through the fast path (before-wait and partial/B).
    assert.equal(messages.length, observed && !['partial', 'before-wait'].includes(scenario) ? 0 : 1);
    if (scenario === 'active-tool' || scenario === 'batch-boundary') {
      const nextRequest = trace.indexOf('request 3: completion visible=1');
      assert.ok(nextRequest >= 0 && nextRequest < trace.indexOf('agent_settled'),
        'completion enters the next model request before settled, even with a debounce pending');
      assert.equal(requests, 3);
    }
    if (scenario === 'tree-cancel') {
      const resumed = trace.indexOf('tree cancelled: still pending, next prompt resumes');
      assert.ok(trace.indexOf('request 3: completion visible=1', resumed) > resumed,
        'deferred completion must enter the resumed run, not wait for its settled event');
      assert.equal(requests, 3, 'resuming must not need a separate completion run after the answer');
    }
    if (scenario === 'in-flight') assert.equal(requests, 3, 'active wait consumes its task without another notification turn');
    if (scenario === 'partial') {
      assert.ok(trace.indexOf('request 3: completion visible=1') < trace.indexOf('agent_settled'));
      assert.match(messages[0].content, /RACE_B/);
      assert.doesNotMatch(messages[0].content, /RACE_A/);
    }
  } finally {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await extension?.dispose();
    session?.dispose();
  }
}

/** Real provider prompt and unmodified QuickJS/standalone discovery of original names. */
async function controlGuidance(sdk, root) {
  const originalDescription = 'Return the supplied fixture value.';
  const fixtures = ['direct', 'codemode', 'deferred'].map(exposure => ({ exposure, name: `mcp__fixture__${exposure}` }));
  const providerContexts = [], calls = [], scriptResults = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let session, extension, requests = 0;
  try {
    const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['codemode', 'tool_search', 'meantime'] });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, 'control-agent'), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [sdk.createCodemodeExtension({ mode: 'only' }), sdk.createToolSearchExtension(), pi => {
        for (const { name, exposure } of fixtures) pi.registerTool({ name, exposure,
          label: name, description: originalDescription, executionMode: 'parallel',
          parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
          outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          async execute(_id, args) {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: args.value }], structuredContent: args, details: undefined };
          },
        });
        pi.registerProvider('control-fixture', { api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'unused',
          models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 32000, maxTokens: 2048 }],
          streamSimple(model, context) {
            providerContexts.push(structuredClone(context));
            const first = ++requests === 1, stream = createAssistantMessageEventStream();
            const code = `
              const names = ${JSON.stringify(fixtures.map(f => f.name))};
              const found = await searchTools('mcp__fixture', {limit: 20});
              const descriptions = await Promise.all(names.map(name => describeTool(name)));
              const results = await Promise.all(names.map(name => tools[name]({value: name, __background__: 'no'})));
              return {all: ALL_TOOLS, found, descriptions, results};`;
            const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage,
              content: first ? [{ type: 'toolCall', id: 'discover', name: 'codemode', arguments: { code } }] : [{ type: 'text', text: 'done' }],
              stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
            stream.push({ type: 'start', partial: message });
            if (first) {
              stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
            }
            stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
          },
        });
        pi.on('tool_execution_end', event => { if (event.toolName === 'codemode') scriptResults.push(event.result); });
        extension = install(pi, { config: validateConfig({ autoDetachMs: 1750 }) });
      }] });
    await loader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, modelRuntime,
      sessionManager: sdk.SessionManager.inMemory(root) }));
    await session.bindExtensions({ mode: 'rpc' });
    await session.setModel(modelRuntime.getModel('control-fixture', 'fixture'));
    await session.prompt('Discover indirect fixture tools and return their values with automatic backgrounding disabled.');
    assert.equal(requests, 2);
    assert.equal(scriptResults.length, 1);
    assert.equal(scriptResults[0].isError ?? false, false, JSON.stringify(scriptResults));
    const output = scriptResults[0].content.filter(b => b.type === 'text').map(b => b.text).join('');
    const discovered = JSON.parse(output.slice(output.indexOf('Output:\n') + 'Output:\n'.length));
    assert.doesNotMatch(JSON.stringify(discovered), /_mt\b/);
    for (const { name } of fixtures) {
      assert.equal(discovered.all.filter(t => t.name === name).length, 1, 'ALL_TOOLS has one original candidate');
      assert.equal(discovered.found.filter(t => t.name === name).length, 1, 'searchTools has one original candidate');
    }
    assert.deepEqual(discovered.results, fixtures.map(f => ({ value: f.name })));
    assert.deepEqual(calls.map(c => c.args), fixtures.map(f => ({ value: f.name })), 'control never reaches business tool');
    const standalone = await invoke(session, 'tool_search', 'standalone-discover', { query: 'mcp__fixture', limit: 20 });
    assert.equal(standalone.isError, false);
    assert.doesNotMatch(JSON.stringify(standalone), /_mt\b/);
    assert.deepEqual([...standalone.details.loaded].sort(), fixtures.filter(f => f.exposure !== 'direct').map(f => f.name).sort());
    const all = session.getAllTools();
    assert.doesNotMatch(JSON.stringify(all), /_mt\b/);
    for (const { name, exposure } of fixtures) {
      assert.equal(all.filter(t => t.name === name).length, 1, 'one registered candidate per original name');
      const tool = all.find(t => t.name === name);
      assert.equal(tool.exposure, exposure, 'indirect tools must not be promoted');
      assert.equal(tool.description, originalDescription, 'native description is untouched');
      const i = fixtures.findIndex(f => f.name === name);
      assert.ok(discovered.descriptions[i].includes(name));
      assert.ok(discovered.descriptions[i].includes(originalDescription));
      assert.match(discovered.descriptions[i], /__background__\?/);
      for (const mode of ['auto', 'yes', 'no']) assert.ok(discovered.descriptions[i].includes(`"${mode}"`));
      assert.deepEqual(tool.parameters.properties.__background__.enum, ['auto', 'yes', 'no']);
      assert.ok(!tool.parameters.required.includes('__background__'));
    }
    const codemode = providerContexts[0].messages.filter(m => m.role === 'system')
      .flatMap(m => m.toolsAdded ?? []).find(t => t.name === 'codemode');
    assert.ok(codemode);
    assert.doesNotMatch(codemode.description, /_mt\b/);
    for (const { name, exposure } of fixtures.filter(f => f.exposure !== 'deferred')) {
      assert.equal(codemode.description.split(`${name}(args:`).length - 1, 1, `${exposure}: one inline candidate`);
    }

    const system = providerContexts[0].messages.filter(m => m.role === 'system');
    const section = system.map(m => m.sections?.meantime).find(Boolean);
    assert.ok(section, 'meantime instructions reach the actual provider even in codemode-only mode');
    for (const phrase of ['__background__', '"auto" (default)', 'detaches after 1.75s', '"yes" requests background execution', '"no" disables automatic backgrounding']) {
      assert.ok(section.includes(phrase), phrase);
    }
    const meaningsInRequest = JSON.stringify(system).split('Detaching does not cancel the operation.').length - 1;
    assert.doesNotMatch(section, /_mt\b/);
    assert.equal(meaningsInRequest, 1, 'full control meaning appears only in the shared prompt');
    console.log('CONTROL_GUIDANCE_PASS: original names unique in codemode description, ALL_TOOLS, searchTools and standalone tool_search; native descriptions unchanged.');
  } finally {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await extension?.dispose(); session?.dispose();
  }
}

/** Real dispatch, approvals and QuickJS worker startup; no synthetic tool/input events.
 * Deferred gates hold producer completion so a handle alone cannot fake success. */
async function earlySteerRace(sdk, root, scenario) {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const tick = () => new Promise(r => setImmediate(r));
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`early steer timeout: ${scenario}: ${trace.join('; ')}`)), 8000);
    })]); } finally { clearTimeout(timer); }
  };
  const trace = [], results = [], bodies = new Set();
  const firstBody = deferred(), nextBody = deferred(), firstRelease = deferred(), nextRelease = deferred();
  const freshBody = deferred(), freshRelease = deferred();
  const approval = deferred(), choice = deferred(), outerCall = deferred(), primaryEnd = deferred();
  const denied = scenario === 'outer-denial', approvalCase = scenario.startsWith('outer-');
  const nested = scenario === 'codemode-startup', disabled = scenario === 'disabled';
  let extension, session, requests = 0, earlyInput;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['fixture', 'meantime', 'codemode'], compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, 'early-' + scenario), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [sdk.createCodemodeExtension(), pi => {
      pi.registerTool({ name: 'fixture', label: 'fixture', description: 'Held producer', executionMode: 'parallel',
        parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
        async execute(_id, { tag }, signal) {
          bodies.add(tag); trace.push(`body ${tag}`);
          (tag === 'first' ? firstBody : tag === 'fresh' ? freshBody : nextBody).resolve();
          await (tag === 'first' ? firstRelease : tag === 'fresh' ? freshRelease : nextRelease).promise;
          assert.equal(signal.aborted, false, 'detached producer must retain its independent signal');
          trace.push(`finished ${tag}`);
          return { content: [{ type: 'text', text: tag }], details: undefined };
        } });
      pi.registerProvider('early-fixture', { api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'unused',
        models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model, context) {
          const n = ++requests, stream = createAssistantMessageEventStream();
          trace.push(`request ${n}`);
          if (n === 2) assert.ok(JSON.stringify(context.messages).includes('early-redirect-marker'), 'Pi must preserve steer input');
          const call = n === 1 ? { id: 'outer', name: nested ? 'codemode' : 'fixture',
            arguments: nested ? { code: "return await tools.fixture({tag: 'first'});" }
              : { tag: 'first', ...(scenario === 'outer-approval' ? { __background__: 'no' } : {}) } }
            : n === 2 ? { id: 'unrelated', name: 'fixture', arguments: { tag: 'next' } }
            : n === 4 ? { id: 'outer', name: 'fixture', arguments: { tag: 'fresh' } } : undefined;
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: call ? [{ type: 'toolCall', ...call }] : [{ type: 'text', text: 'done' }], usage,
            stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now() };
          stream.push({ type: 'start', partial: message });
          if (call) {
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
        } });
      extension = install(pi, { config: validateConfig({ include: ['fixture'],
        autoDetachMs: 0, detachOnSteer: !disabled, notifyDebounceMs: 5000 }) });
      pi.on('tool_execution_start', async event => {
        trace.push(`start ${event.toolCallId} parent=${event.parentToolCallId ?? '-'} tasks=${extension.inspect().tasks.length}`);
        if ((scenario === 'execution-start' || disabled) && event.toolCallId === 'outer') {
          assert.equal(extension.inspect().tasks.length, 0);
          earlyInput = session.steer('early-redirect-marker', undefined, { source: 'rpc' });
          await earlyInput;
        }
      });
      pi.on('tool_call', async (event, ctx) => {
        if (event.toolCallId === 'outer') {
          trace.push('outer hook'); outerCall.resolve();
          if (approvalCase && requests === 1) {
            const granted = await ctx.ui.confirm('approval', 'fixture');
            trace.push(`approval ${granted}`);
            if (!granted) return { block: true, reason: 'fixture denied' };
          }
        }
      });
      pi.on('input', event => trace.push(`input ${event.streamingBehavior} tasks=${extension.inspect().tasks.length}`));
      pi.on('tool_execution_end', event => {
        trace.push(`end ${event.toolCallId} handle=${event.result.structuredContent?.task?.detachReason ?? '-'}`);
        results.push(event);
        if (event.toolCallId === 'outer') primaryEnd.resolve(event);
      });
    }] });
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, modelRuntime,
      sessionManager: sdk.SessionManager.inMemory(root) }));
    await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
      confirm: async () => { approval.resolve(); return choice.promise; } } });
    await session.setModel(modelRuntime.getModel('early-fixture', 'fixture'));
    session.setActiveToolsByName(['fixture', 'codemode', 'meantime']);
    const run = session.prompt('start early steer race');
    if (approvalCase) await bounded(approval.promise);
    else if (nested || scenario === 'execution-start' || disabled) await bounded(outerCall.promise);
    else await bounded(firstBody.promise);
    if (scenario === 'execution-start' || disabled) await earlyInput;
    else {
      if (approvalCase || nested) assert.equal(extension.inspect().tasks.length, 0, 'intent must precede runtime admission');
      await session.steer('early-redirect-marker', undefined, { source: 'rpc' });
    }
    trace.push('steer submitted');
    if (approvalCase) {
      await tick();
      assert.equal(results.length, 0, 'approval must not be bypassed');
      assert.equal(bodies.size, 0);
      choice.resolve(!denied);
    }
    if (disabled) {
      await bounded(firstBody.promise);
      await tick(); await tick();
      assert.equal(extension.inspect().tasks[0].delivery, 'foreground');
      assert.equal(requests, 1);
      firstRelease.resolve();
    } else if (!denied) {
      await bounded(firstBody.promise);
      await bounded(primaryEnd.promise);
      const task = extension.inspect().tasks.find(t => t.tool === 'fixture');
      assert.equal(task.delivery, 'background'); assert.equal(task.detachReason, 'steer');
      if (scenario === 'outer-approval') assert.equal(task.mode, 'no', 'user intent overrides timer-only no mode');
      assert.equal(task.localRunning, true, 'producer must still be held when Pi continues');
    }
    const firstEnd = await bounded(primaryEnd.promise);
    if (denied) {
      assert.equal(firstEnd.isError, true); assert.equal(bodies.has('first'), false);
      assert.equal(extension.inspect().tasks.length, 0, 'denial creates no handle');
    }
    await bounded(nextBody.promise); await tick(); await tick();
    const foreground = extension.inspect().tasks.filter(t => t.delivery === 'foreground');
    assert.equal(foreground.length, 1, 'next model turn must not inherit intent');
    assert.equal(requests, 2, 'unrelated call must still be waiting');
    nextRelease.resolve(); await bounded(run);
    firstRelease.resolve();
    // Wait via public meantime, not a polling loop, and acknowledge the detached result.
    const task = extension.inspect().tasks.find(t => t.delivery === 'background');
    if (task) {
      const result = await invoke(session, 'meantime', 'collect', { action: 'wait', ids: [task.id], timeout: 2 });
      assert.equal(result.structuredContent.result_available, true); assert.equal(result.isError, false);
    }
    assert.equal(requests, 3);
    assert.equal(results.find(e => e.toolCallId === 'unrelated').result.structuredContent?.task, undefined);
    if (denied) {
      // A real session replacement retires extension contexts; reload resources
      // before binding the new owner and reusing the former outer call ID.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'switch' });
      session.dispose();
      await extension.dispose();
      await loader.reload();
      ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, modelRuntime,
        sessionManager: sdk.SessionManager.inMemory(root) }));
      await session.bindExtensions({ mode: 'rpc' });
      await session.setModel(modelRuntime.getModel('early-fixture', 'fixture'));
      session.setActiveToolsByName(['fixture', 'meantime']);
      const freshRun = session.prompt('unrelated new session');
      await bounded(freshBody.promise); await tick(); await tick();
      assert.equal(requests, 4);
      assert.equal(extension.inspect().tasks.length, 1);
      assert.equal(extension.inspect().tasks[0].delivery, 'foreground', 'new session cannot inherit prior intent');
      freshRelease.resolve(); await bounded(freshRun);
      assert.equal(requests, 5);
      assert.equal(results.at(-1).result.structuredContent?.task, undefined);
    }
    console.log(`EARLY_STEER ${scenario}: ${JSON.stringify(trace)}`);
  } finally {
    choice.resolve(false); firstRelease.resolve(); nextRelease.resolve(); freshRelease.resolve();
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await extension?.dispose(); session?.dispose();
  }
}
