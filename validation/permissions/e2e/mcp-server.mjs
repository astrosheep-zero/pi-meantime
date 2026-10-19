import {randomUUID} from 'node:crypto';import {createInterface} from 'node:readline';import fs from 'node:fs';import path from 'node:path';
const dir=process.argv[2],pending=new Map(),instanceId=randomUUID();
function log(event){fs.appendFileSync(path.join(dir,'mcp-server-events.jsonl'),JSON.stringify({at:Date.now(),instanceId,...event})+'\n');}
function send(message){log({event:'response',message});process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');}
const tools=['cooperative','stubborn','late_error'].map(name=>({name,description:'Harmless cancellation parity fixture '+name,inputSchema:{type:'object',properties:{ms:{type:'number'}},required:['ms'],additionalProperties:false},annotations:{readOnlyHint:true}}));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);log({event:'request',message:m});const {id,method,params}=m;
if(method==='initialize')return send({id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'cancel-parity',version:'1'}}});
if(method==='tools/list')return send({id,result:{tools}});
if(method==='ping')return send({id,result:{}});
if(method==='notifications/cancelled'){const job=pending.get(params.requestId);log({event:'cancel_received',requestId:params.requestId,reason:params.reason,tool:job?.name});if(job?.name==='cooperative'){clearTimeout(job.timer);pending.delete(params.requestId);log({event:'work_stopped',requestId:params.requestId,tool:job.name});}return;}
if(method!=='tools/call')return;
if('__background__' in params.arguments)throw new Error('Leaked Pi control argument');
log({event:'work_started',requestId:id,tool:params.name,args:params.arguments});
const timer=setTimeout(()=>{pending.delete(id);const isError=params.name==='late_error';log({event:'work_finished',requestId:id,tool:params.name,isError});fs.writeFileSync(path.join(dir,'server-work-finished.txt'),params.name+' FINISHED');send({id,result:{content:[{type:'text',text:isError?'NATIVE_MCP_TEST_ERROR':'NATIVE_MCP_TEST_SUCCESS'}],structuredContent:{tool:params.name,finished:true},isError}});},params.arguments.ms);
pending.set(id,{name:params.name,timer});
});
process.stdin.on('end',()=>{for(const x of pending.values())clearTimeout(x.timer);log({event:'stdin_end'});});
