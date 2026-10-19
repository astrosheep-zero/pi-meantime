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
    for (const scenario of ['outer-approval', 'outer-denial', 'codemode-startup', 'body', 'disabled', 'execution-start']) {
      await earlySteerRace(sdk, root, scenario);
    }
    for (const scenario of ['in-flight', 'before-wait', 'unobserved', 'partial', 'timeout', 'compact', 'compact-cancel', 'tree', 'tree-cancel']) {
      await completionRace(sdk, root, scenario);
    }
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
        pi.on('tool_execution_end', event => {
          if (event.toolName.startsWith('mcp__meantime_fixture__') && !event.toolName.endsWith('_mt')) {
            nativeMcpResults.set(event.toolName, event.result);
          }
        });
        pi.registerTool({
          name: 'background_probe', label: 'background probe', description: 'Test nested background result retrieval',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            assert.ok(ctx.tools.some(t => t.name === 'meantime'), 'meantime must be callable by codemode');
            const started = await ctx.executeTool('bash', { command: 'sleep 0.1; printf REAL_BACKGROUND_OK', __background__: 'yes' });
            assert.equal(started.result.structuredContent.result_available, false);
            const id = started.result.structuredContent.task.id;
            await new Promise(resolve => setTimeout(resolve, 300));
            const collected = await ctx.executeTool('meantime', { action: 'wait', timeout: 0, id });
            assert.equal(collected.isError, false);
            assert.equal(collected.result.structuredContent.result_available, true);
            assert.equal(collected.result.structuredContent.result.output, 'REAL_BACKGROUND_OK');
            assert.doesNotMatch(collected.result.content.map(b => b.text).join('\n'), /Output:/);
            for (const [tool, args] of [
              ['bash', { command: `sleep 0.1; node -e 'process.stdout.write("B".repeat(60000))'` }],
              ['mcp__meantime_fixture__slow_mt', { ms: 100, text: largeMcpText }],
            ]) {
              const handle = await ctx.executeTool(tool, { ...args, __background__: 'yes' });
              const id = handle.result.structuredContent.task.id;
              const result = await ctx.executeTool('meantime', { action: 'wait', id });
              assert.equal(result.isError, false);
              const task = result.result.structuredContent.task;
              assert.ok(task.outputPath, JSON.stringify({ tool, task, result: result.result.structuredContent.result }).slice(0, 2000));
              assert.equal(result.result.details.fullOutputPath, task.outputPath, `${tool}: wait preserves native fullOutputPath`);
              assert.equal(result.result.details.task.id, task.id);
              assert.match(result.result.content[0].text, /\nOutput: /);
              const retained = result.result.structuredContent.result;
              const text = result.result.content[1].text;
              if (tool.startsWith('mcp__')) {
                const native = nativeMcpResults.get('mcp__meantime_fixture__slow');
                const { task: _task, ...details } = result.result.details;
                assert.deepEqual(details, native.details);
                assert.equal(task.outputPath, native.details.fullOutputPath);
                assert.deepEqual(result.result.content.slice(1), native.content);
                assert.deepEqual(retained, native.structuredContent);
                assert.match(text, /^Warning: truncated output/);
                assert.equal(text.replaceAll(task.outputPath, '<native-path>'),
                  baseline.content[0].text.replaceAll(baseline.details.fullOutputPath, '<native-path>'));
                assert.ok(text.includes('\x1b[31m\x00HEAD'), 'native MCP controls must survive');
                assert.equal(retained.content[0].text, largeMcpText);
              } else {
                assert.equal(result.result.details.truncation.truncated, true, 'wait preserves native Bash truncation');
              }
              assert.equal(readFileSync(task.outputPath, 'utf8'), tool === 'bash' ? 'B'.repeat(60000) : largeMcpText);
              outputs.push({ id, path: task.outputPath, text });
            }
            assert.equal(outputs[1].path.includes('pi-bash-'), true);
            assert.equal(outputs[2].path.includes('pi-mcp-'), true);
            const failed = await ctx.executeTool('mcp__meantime_fixture__fail_mt', { ms: 100, __background__: 'yes' });
            const failure = await ctx.executeTool('meantime', { action: 'wait', id: failed.result.structuredContent.task.id });
            const nativeFailure = nativeMcpResults.get('mcp__meantime_fixture__fail');
            assert.equal(failure.isError, true);
            assert.equal(failure.result.structuredContent.task.state, 'failed');
            assert.deepEqual(failure.result.content.slice(1), nativeFailure.content);
            assert.deepEqual(failure.result.structuredContent.result, nativeFailure.structuredContent);
            assert.equal(failure.result.content[1].text, 'fixture failure');
            return collected.result;
          },
        });
        extension = install(pi, {
          config: validateConfig({ autoDetachMs: 0 }),
          makeBash: cwd => sdk.createBashToolDefinition(cwd),
        });
      }],
    });
    await loader.reload();
    const manager = sdk.SessionManager.create(root, join(root, 'sessions'));
    // This is a synthetic recorded assistant call, not a model invocation.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'smoke', name: 'mcp__meantime_fixture__slow_mt', arguments: { ms: 1 } }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, sessionManager: manager }));
    await session.bindExtensions({ mode: 'rpc' });
    const prompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'smoke' }, {
      cwd: root, sections: { existing: 'Keep other prompt sections.' },
    });
    assert.equal(prompt.systemPromptOptions.sections.existing, 'Keep other prompt sections.');
    assert.match(prompt.systemPromptOptions.sections.meantime, /_mt/);
    assert.match(prompt.systemPromptOptions.sections.meantime, /__background__/);
    const nextPrompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'again' }, prompt.systemPromptOptions);
    assert.equal(nextPrompt.systemPromptOptions.sections.meantime, prompt.systemPromptOptions.sections.meantime);
    const deadline = Date.now() + 8000;
    const target = 'mcp__meantime_fixture__slow_mt';
    while (!session.getAllTools().some(t => t.name === target)) {
      if (Date.now() > deadline) throw new Error('MCP proxy registration timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // SDK may keep added MCP tools outside its initial active set. Explicit activation
    // here is part of the test setup, not the extension's production policy.
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), target, 'mcp__meantime_fixture__slow', 'mcp__meantime_fixture__fail', 'mcp__meantime_fixture__fail_mt', 'meantime', 'bash', 'background_probe'])]);
    const wrapped = session.agent.state.tools.find(t => t.name === target);
    assert.ok(wrapped, 'proxy must be activated in the test session');
    const result = await wrapped.execute('smoke', { ms: 1, text: 'REAL_PI_MCP_OK', __background__: 'no' }, new AbortController().signal);
    assert.ok(result.content.some(b => b.type === 'text' && b.text.includes('REAL_PI_MCP_OK')));
    assert.equal(result.structuredContent?.task, undefined);
    const bash = session.agent.state.tools.find(t => t.name === 'bash');
    const shell = await bash.execute('smoke-bash', { command: 'printf REAL_PI_BASH_OK', __background__: 'no' }, new AbortController().signal);
    assert.deepEqual(shell.content, [{ type: 'text', text: 'REAL_PI_BASH_OK' }]);
    assert.equal(shell.structuredContent.exit_code, 0);
    assert.equal(shell.structuredContent.task, undefined);
    assert.equal(manager.getEntries().filter(e => e.customType === 'meantime-index').length, 0);
    const probe = session.agent.state.tools.find(t => t.name === 'background_probe');
    const completed = await probe.execute('background-probe', {}, new AbortController().signal);
    const id = completed.structuredContent.task.id;
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
    const restored = await session.agent.state.tools.find(t => t.name === 'meantime')
      .execute('restored-result', { action: 'wait', timeout: 0, id }, new AbortController().signal);
    assert.equal(restored.structuredContent.task.recovered, true);
    assert.equal(restored.structuredContent.result, 'REAL_BACKGROUND_OK');
    assert.match(restored.content.map(b => b.text).join('\n'), /contains text only/);
    for (const { id, path, text } of outputs.filter(o => o.id)) {
      const result = await session.agent.state.tools.find(t => t.name === 'meantime')
        .execute('restored-output', { action: 'wait', timeout: 0, id }, new AbortController().signal);
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
  const unread = scenario === 'unobserved' || compact || tree;
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
              JSON.stringify(m.content).includes('Automated background completion'));
            trace.push(`request ${n}: completion visible=${completions.length}`);
            let calls = [];
            if (n === 1) {
              calls = [{ id: 'start-a', name: 'bash', arguments: { command: 'sleep 0.12; printf RACE_A' } }];
              if (scenario === 'partial') calls.push({ id: 'start-b', name: 'bash', arguments: { command: 'sleep 0.12; printf RACE_B' } });
            } else if (n === 2 && !unread) {
              // The second request is already streaming when the producer ends.
              // Delay tool selection to put completion handoff before wait's ack.
              if (scenario === 'before-wait' || scenario === 'partial') await new Promise(r => setTimeout(r, 350));
              const task = extension.inspect().tasks.find(t => t.command?.includes('RACE_A'));
              trace.push(`before wait: notification=${task.notification}, running=${task.localRunning}`);
              assert.equal(task.localRunning, scenario === 'in-flight' || scenario === 'timeout');
              calls = [{ id: 'collect', name: 'meantime', arguments: {
                action: 'wait', id: task.id, timeout: scenario === 'timeout' ? 0 : 2,
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
        config: validateConfig({ autoDetachMs: 10, notifyDebounceMs: 5 }),
        makeBash: cwd => sdk.createBashToolDefinition(cwd),
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
        if (event.toolName === 'bash') {
          trace.push(`handle ${event.toolCallId}: ${event.result.structuredContent?.task?.detachReason}`);
          assert.equal(event.result.structuredContent?.task?.detachReason, 'timeout');
        }
        if (event.toolName === 'meantime') {
          waitResults.push(event.result);
          trace.push(`wait returned: available=${event.result.structuredContent?.result_available}`);
        }
      });
      pi.on('message_end', event => {
        if (event.message.customType === 'meantime-completion') trace.push('completion delivered');
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
        // No tree-end event on cancellation: pending survives until another flush.
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
    assert.equal(messages.length, observed && scenario !== 'partial' ? 0 : 1);
    assert.equal(requests, scenario === 'timeout' || scenario === 'partial' || scenario === 'tree-cancel' ? 4 : 3);
    if (scenario === 'partial') {
      assert.match(messages[0].content, /RACE_B/);
      assert.doesNotMatch(messages[0].content, /RACE_A/);
    }
  } finally {
    if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await extension?.dispose();
    session?.dispose();
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
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['fixture', 'fixture_mt', 'meantime', 'codemode'], compaction: { enabled: false } });
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
          const call = n === 1 ? { id: 'outer', name: nested ? 'codemode' : 'fixture_mt',
            arguments: nested ? { code: "return await tools.fixture_mt({tag: 'first'});" }
              : { tag: 'first', ...(scenario === 'outer-approval' ? { __background__: 'no' } : {}) } }
            : n === 2 ? { id: 'unrelated', name: 'fixture_mt', arguments: { tag: 'next' } }
            : n === 4 ? { id: 'outer', name: 'fixture_mt', arguments: { tag: 'fresh' } } : undefined;
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
        autoDetachMs: 0, detachOnSteer: !disabled, notifyDebounceMs: 5000 }), makeBash: cwd => sdk.createBashToolDefinition(cwd) });
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
    session.setActiveToolsByName(['fixture', 'fixture_mt', 'codemode', 'meantime']);
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
      const tool = session.agent.state.tools.find(t => t.name === 'meantime');
      const result = await tool.execute('collect', { action: 'wait', id: task.id, timeout: 2 }, new AbortController().signal);
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
      session.setActiveToolsByName(['fixture', 'fixture_mt', 'meantime']);
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
