import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.E2E_CASE_DIR;
export default function observer(pi) {
  function log(event, ctx) {
    fs.appendFileSync(path.join(dir, 'host-events.jsonl'), JSON.stringify({ at: Date.now(), mode: ctx.mode,
      sessionId: ctx.sessionManager.getSessionId(), event }) + '\n');
  }
  pi.registerMcpServer('parity', { command: process.execPath,
    args: [path.join(here, 'mcp-server.mjs'), dir], exposure: 'direct', timeout: 10 });
  for (const type of ['session_start', 'session_shutdown', 'input', 'agent_start', 'agent_end',
    'agent_settled', 'tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_end',
    'message_end', 'ui_prompt_start', 'ui_prompt_end']) pi.on(type, (event, ctx) => log(event, ctx));
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'mcp__parity__cooperative') return;
    log({ type: 'permission_gate_enter', parentToolCallId: event.parentToolCallId, hasUI: ctx.hasUI }, ctx);
    if (!ctx.hasUI) return { block: true, reason: 'PERMISSION_DENIED_NO_UI: fixture not executed.' };
    const choice = await ctx.ui.select('Permission: run local MCP fixture?', ['Allow once', 'Deny']);
    log({ type: 'permission_gate_decision', choice }, ctx);
    if (choice !== 'Allow once') return { block: true, reason: 'PERMISSION_DENIED_BY_USER: fixture not executed.' };
  });
}
