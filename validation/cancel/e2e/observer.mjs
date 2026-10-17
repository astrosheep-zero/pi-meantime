import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),dir=process.env.E2E_CASE_DIR;
export default function observer(pi){
pi.registerMcpServer('parity',{command:process.execPath,args:[path.join(here,'mcp-server.mjs'),dir],exposure:'direct',timeout:10});
for(const type of ['session_start','session_shutdown','input','agent_start','agent_end','agent_settled','tool_call','tool_result','tool_execution_start','tool_execution_end','message_end'])pi.on(type,(event,ctx)=>{fs.appendFileSync(path.join(dir,'host-events.jsonl'),JSON.stringify({at:Date.now(),mode:ctx.mode,sessionId:ctx.sessionManager.getSessionId(),event})+'\n');});
}
