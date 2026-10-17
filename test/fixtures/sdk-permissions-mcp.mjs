/** Instrumented local MCP permission fixture: records tools/call receipt. */
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const callLog = process.argv[2];
if (!callLog) throw new Error('Fixture requires a call-log path');
const timers = new Set();
const inputSchema = { type: 'object', properties: {
  ms: { type: 'number', minimum: 0, maximum: 5000 }, marker: { type: 'string' },
}, required: ['ms'], additionalProperties: false };
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} },
    serverInfo: { name: 'pi-bg-permission-fixture', version: '1.0.0' } } });
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: [{ name: 'stubborn', description: 'Permission side-effect fixture', inputSchema }] } });
  if (method !== 'tools/call') { if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } }); return; }
  appendFileSync(callLog, JSON.stringify({ name: params?.name }) + '\n', { mode: 0o600 });
  const args = params?.arguments ?? {};
  if (params.name !== 'stubborn' || '__background__' in args || typeof args.ms !== 'number') {
    return send({ id, error: { code: -32602, message: 'Invalid fixture arguments' } });
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (args.marker) writeFileSync(args.marker, 'FIXTURE_SIDE_EFFECT', { mode: 0o600 });
    send({ id, result: { content: [{ type: 'text', text: 'FIXTURE_MCP_DONE' }], structuredContent: { name: params.name }, isError: false } });
  }, args.ms);
  timers.add(timer);
});
process.stdin.on('end', () => { for (const timer of timers) clearTimeout(timer); });
