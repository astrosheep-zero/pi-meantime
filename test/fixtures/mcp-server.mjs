/** Minimal MCP JSON-RPC/stdio test server. No model, agent or network access. */
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const timers = new Map();
const inputSchema = {
  type: 'object', properties: {
    ms: { type: 'number', minimum: 0, maximum: 5000 },
    text: { type: 'string' },
    marker: { type: 'string' },
  }, required: ['ms'], additionalProperties: false,
};
const tools = ['slow', 'stubborn', 'fail'].map(name => ({ name, description: `PoC fixture: ${name}`,
  inputSchema, annotations: { readOnlyHint: name !== 'stubborn' },
}));
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'pi-bg-poc-fixture', version: '0.1.0' } } });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'notifications/cancelled') {
    const pending = timers.get(params.requestId);
    if (pending && !pending.stubborn) { clearTimeout(pending.timer); timers.delete(params.requestId); }
    return;
  }
  if (method !== 'tools/call') { if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } }); return; }
  const args = params?.arguments ?? {};
  if ('__background__' in args) return send({ id, error: { code: -32602, message: 'Leaked runtime parameter' } });
  if (!tools.some(t => t.name === params.name) || typeof args.ms !== 'number' || !Number.isFinite(args.ms) || args.ms < 0 || args.ms > 5000) return send({ id, error: { code: -32602, message: 'Invalid fixture arguments' } });
  const timer = setTimeout(() => {
    timers.delete(id);
    if (params.name === 'stubborn' && args.marker) writeFileSync(args.marker, 'REMOTE_SIDE_EFFECT_COMPLETED', { mode: 0o600 });
    const isError = params.name === 'fail';
    send({ id, result: { content: [{ type: 'text', text: isError ? 'fixture failure' : args.text ?? 'MCP_DONE' }],
      structuredContent: { received: args, name: params.name }, isError } });
  }, args.ms);
  timers.set(id, { timer, stubborn: params.name === 'stubborn' });
});
process.stdin.on('end', () => { for (const value of timers.values()) clearTimeout(value.timer); });
