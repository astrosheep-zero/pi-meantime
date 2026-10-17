import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = process.env.E2E_CASE_DIR;
const root = process.env.E2E_SOURCE_ROOT;
const phase = process.env.E2E_PHASE;
const instance = randomUUID();
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function append(file, value) { fs.appendFileSync(path.join(dir, file), JSON.stringify({ at: Date.now(), phase, pid: process.pid, instance, ...value }) + '\n'); }
function identity(ctx) { return { mode: ctx.mode, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }; }

export default function observer(pi) {
  append('actual-host-loads.jsonl', {
    nodeVersion: process.version,
    sourceVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
    sourceHashes: Object.fromEntries(['index.mjs', 'package.json', ...fs.readdirSync(path.join(root, 'src')).map(f => 'src/' + f)].map(f => [f, digest(path.join(root, f))])),
    sdkVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version,
    sdkCliHash: digest(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')),
  });
  pi.registerTool({
    name: 'fixture_restart', label: 'Synthetic restart fixture', exposure: 'direct', executionMode: 'parallel',
    description: 'Call only the harmless isolated localhost restart test service.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['completed', 'unfinished'] } }, required: ['kind'], additionalProperties: false },
    async execute(id, args, signal, _update, ctx) {
      append('fixture-events.jsonl', { event: 'start', id, kind: args.kind, ...identity(ctx) });
      const response = await fetch(process.env.E2E_TOOL_URL, { method: 'POST', body: JSON.stringify({ kind: args.kind, id, phase }), headers: { 'content-type': 'application/json' }, signal });
      if (!response.ok) throw new Error('Local synthetic tool HTTP failure');
      const result = await response.json();
      append('fixture-events.jsonl', { event: 'finish', id, kind: args.kind, ...identity(ctx) });
      return { content: [{ type: 'text', text: result.text }], structuredContent: result, details: { synthetic: true } };
    },
  });
  for (const type of ['session_start', 'session_shutdown', 'input', 'agent_start', 'agent_end', 'agent_settled', 'tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_end', 'message_end']) {
    pi.on(type, (event, ctx) => append('host-events.jsonl', { ...identity(ctx), event }));
  }
}
