import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));const evidence=process.env.E2E_CASE_DIR;
function log(event,ctx){fs.appendFileSync(path.join(evidence,'host-events.jsonl'),JSON.stringify({at:Date.now(),mode:ctx?.mode,sessionId:ctx?.sessionManager.getSessionId(),event})+'\n');}
export default function observer(pi){
 for(const [server,exposure] of [['meantime_fixture','direct'],['indirect','codemode'],['deferred','deferred']]){
   pi.registerMcpServer(server,{command:process.execPath,args:[path.join(here,'mcp-wire.mjs'),path.join(evidence,'mcp-'+server+'.jsonl'),path.join(here,'../test/fixtures/mcp-server.mjs')],exposure,timeout:20});
 }
 for(const exposure of ['codemode','deferred'])pi.registerTool({name:'fixture_'+exposure,label:'Fixture '+exposure,description:'Slow harmless custom fixture '+exposure,exposure,executionMode:'parallel',parameters:{type:'object',properties:{ms:{type:'number'}},required:['ms']},async execute(id,args,signal){await new Promise(resolve=>setTimeout(resolve,args.ms));return {content:[{type:'text',text:'CUSTOM_'+exposure+'_FINISHED'}],details:{signalAborted:signal?.aborted}};}});
 for(const name of ['session_start','session_shutdown','session_tree','before_agent_start','agent_start','agent_end','agent_settled','input','tool_call','tool_result','tool_execution_start','tool_execution_end','message_end','ui_prompt_start','ui_prompt_end'])pi.on(name,(e,c)=>{log(e,c)});
 pi.on('before_agent_start',(_e,c)=>{log({type:'loadout_evidence',tools:pi.getAllTools().map(t=>({name:t.name,exposure:t.exposure,parameters:t.parameters})),active:pi.getActiveTools()},c)});
}
