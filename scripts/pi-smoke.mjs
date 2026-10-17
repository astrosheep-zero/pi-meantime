/** Optional REAL SDK smoke: no model request, credentials or user configuration.
 * Uses the pinned development dependency @earendil-works/pi-coding-agent@1.3.0.
 * This exercises official registration, schema processing, native Bash and nested
 * MCP dispatch in a headless SDK session. Human TUI steering is a separate gate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  try {
    const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash', 'bg_task'] });
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: join(root, 'agent'), settingsManager,
      extensionFactories: [sdk.createMcpExtension(), pi => {
        pi.registerMcpServer('bg_poc_fixture', {
          command: process.execPath,
          args: [fileURLToPath(new URL('../test/fixtures/mcp-server.mjs', import.meta.url))],
          exposure: 'direct', timeout: 10,
        });
        pi.registerTool({
          name: 'background_probe', label: 'background probe', description: 'Test nested background result retrieval',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _args, _signal, _update, ctx) {
            assert.ok(ctx.tools.some(t => t.name === 'bg_task'), 'bg_task must be callable by codemode');
            const started = await ctx.executeTool('bash', { command: 'sleep 0.1; printf REAL_BACKGROUND_OK', __background__: 'yes' });
            assert.equal(started.result.structuredContent.result_available, false);
            const id = started.result.structuredContent.task.id;
            await new Promise(resolve => setTimeout(resolve, 300));
            const collected = await ctx.executeTool('bg_task', { action: 'result', id });
            assert.equal(collected.isError, false);
            assert.equal(collected.result.structuredContent.result_available, true);
            assert.equal(collected.result.structuredContent.result.output, 'REAL_BACKGROUND_OK');
            return collected.result;
          },
        });
        extension = install(pi, {
          config: validateConfig({ storageRoot: join(root, 'tasks'), autoDetachMs: 0 }),
          makeBash: cwd => sdk.createBashToolDefinition(cwd),
        });
      }],
    });
    await loader.reload();
    const manager = sdk.SessionManager.inMemory(root);
    // This is a synthetic recorded assistant call, not a model invocation.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'smoke', name: 'mcp__bg_poc_fixture__slow_bg', arguments: { ms: 1 } }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
    ({ session } = await sdk.createAgentSession({ cwd: root, resourceLoader: loader, settingsManager, sessionManager: manager }));
    await session.bindExtensions({ mode: 'rpc' });
    const deadline = Date.now() + 8000;
    const target = 'mcp__bg_poc_fixture__slow_bg';
    while (!session.getAllTools().some(t => t.name === target)) {
      if (Date.now() > deadline) throw new Error('MCP proxy registration timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // SDK may keep added MCP tools outside its initial active set. Explicit activation
    // here is part of the test setup, not the extension's production policy.
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), target, 'mcp__bg_poc_fixture__slow', 'bg_task', 'bash', 'background_probe'])]);
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
    const probe = session.agent.state.tools.find(t => t.name === 'background_probe');
    await probe.execute('background-probe', {}, new AbortController().signal);
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
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log('REAL_PI_SMOKE_PASS: official SDK registration, nested MCP and native Bash; shutdown cleanup completed. No model call. SDK RPC-mode detach and nested result retrieval passed; no actual TUI/CLI transport exercised.');
}
