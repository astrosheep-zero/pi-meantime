/** Executable offline model-facing trace using the public-contract host double
 * and a real MCP stdio server. No paid model or API key is used. */
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { FakePi, basicTool, fixtureBash } from '../test/host.ts';
import { FixtureMcpClient } from '../test/mcp-client.ts';
import { until } from '../test/helpers.ts';
import type { Snapshot } from '../src/runtime.ts';
const client = new FixtureMcpClient();
const pi = new FakePi('demo');
for (const tool of await client.connect()) pi.registerTool(basicTool(`mcp__fixture__${tool.name}`,
  (_id, args, signal) => client.call(tool.name, args, signal), { parameters: tool.inputSchema }));
const instance = install(pi, { config: validateConfig({ autoDetachMs: 0, notifyDebounceMs: 5 }), makeBash: fixtureBash });
try {
  await pi.emit('session_start', { type: 'session_start' });
  console.log('HOST: deterministic Pi contract double; TRANSPORT: real MCP JSON-RPC over stdio');
  console.log('MODEL TOOLS:', pi.modelTools().join(', '));
  console.log('\nMODEL CALL: mcp__fixture__slow_mt({ms:180,text:"MCP completed",__background__:"yes"})');
  const out = await pi.call('mcp__fixture__slow_mt', { ms: 180, text: 'MCP completed', __background__: 'yes' });
  const task = (out.result.structuredContent as { task: unknown }).task as Snapshot;
  console.log('TOOL RESULT:', JSON.stringify(out.result.structuredContent));
  console.log('\nMODEL CALL WHILE MCP RUNS: bash({command:"printf PARALLEL",__background__:"no"})');
  const parallel = await pi.call('bash', { command: 'printf PARALLEL', __background__: 'no' });
  console.log('BASH:', parallel.result.content);
  await until(() => pi.notifications.length > 0);
  console.log('\nNOTIFICATION:', pi.notifications[0]!.content);
  const done = await pi.call('meantime', { action: 'wait', timeout: 0, id: task.id });
  console.log('COLLECTED:', JSON.stringify(done.result.structuredContent));
  console.log('MCP REQUEST COUNT:', client.sent.filter(m => m.method === 'tools/call').length);
} finally {
  await instance.dispose(); await client.close();
}
