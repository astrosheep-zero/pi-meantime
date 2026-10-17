import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),dir=process.env.E2E_CASE_DIR;
export default function observer(pi){
let bound;function log(event,ctx){let identity;try{identity={sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile()};bound??=identity;}catch{identity={...bound,staleContext:true};}fs.appendFileSync(path.join(dir,'host-events.jsonl'),JSON.stringify({at:Date.now(),mode:'tui',...identity,event})+'\n');}
pi.registerMcpServer('parity',{command:process.execPath,args:[path.join(here,'mcp-server.mjs'),dir],exposure:'direct',timeout:10});
for(const type of ['session_start','session_shutdown','input','agent_start','agent_end','agent_settled','tool_call','tool_result','tool_execution_start','tool_execution_end','message_end'])pi.on(type,(event,ctx)=>log(event,ctx));
pi.registerCommand('e2e-new',{description:'Create isolated test session through the public API',async handler(_args,ctx){await ctx.newSession({withSession:async fresh=>log({type:'control_new_session'},fresh)});}});
}
