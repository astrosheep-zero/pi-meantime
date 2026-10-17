import fs from 'node:fs';import {randomUUID} from 'node:crypto';import path from 'node:path';
const evidence=process.env.E2E_CASE_DIR;
const sessionsFile=path.join(evidence,'control-sessions.json');
function identity(ctx){return {sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),leafId:ctx.sessionManager.getLeafId()};}
function log(event,ctx,fallback){let info={},mode;try{if(ctx){info=identity(ctx);mode=ctx.mode;}}catch(error){if(!fallback)throw error;info={...fallback,staleContext:true};mode='tui';}fs.appendFileSync(path.join(evidence,'host-events.jsonl'),JSON.stringify({at:Date.now(),mode,...info,observerInstanceId:fallback?.observerInstanceId,event})+'\n');}
function sessions(){try{return JSON.parse(fs.readFileSync(sessionsFile,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
function mark(label,ctx){if(!/^[A-Z]$/.test(label))throw new Error('Invalid test session label');const all=sessions();all[label]=identity(ctx);fs.writeFileSync(sessionsFile,JSON.stringify(all,null,2));log({type:'control_mark',label,...all[label]},ctx);}
function target(label){const t=sessions()[label];if(!t?.sessionFile||!path.resolve(t.sessionFile).startsWith(path.resolve(evidence)+path.sep))throw new Error('Unknown or unsafe synthetic session path');return t;}
export default function observer(pi){
 const observerInstanceId=randomUUID();let boundIdentity;
 const eventLog=(event,ctx)=>{if(!boundIdentity)boundIdentity={...identity(ctx),observerInstanceId};log(event,ctx,boundIdentity);};
 for(const exposure of ['direct','codemode','deferred'])pi.registerTool({name:'fixture_'+exposure,label:'Fixture '+exposure,description:'Harmless timed noncooperative local fixture '+exposure,exposure,executionMode:'parallel',parameters:{type:'object',properties:{ms:{type:'number'},gate:{type:'string'},failAfterGate:{type:'boolean'}},required:['ms']},async execute(id,args,signal,update,ctx){
  const event={id,name:'fixture_'+exposure,ms:args.ms,gate:args.gate,observerInstanceId,...identity(ctx)};
  fs.appendFileSync(path.join(evidence,'fixture-execution.jsonl'),JSON.stringify({at:Date.now(),phase:'start',...event})+'\n');
  const onAbort=()=>fs.appendFileSync(path.join(evidence,'fixture-execution.jsonl'),JSON.stringify({at:Date.now(),phase:'abort',...event})+'\n');signal?.addEventListener('abort',onAbort,{once:true});
  if(args.gate){if(!/^[a-z0-9-]+$/.test(args.gate))throw new Error('Invalid fixture gate');const end=Date.now()+12000;while(!fs.existsSync(path.join(evidence,'gate-'+args.gate))){if(Date.now()>end)throw new Error('Fixture gate timed out');await new Promise(r=>setTimeout(r,10));}}
  else await new Promise(resolve=>setTimeout(resolve,args.ms));
  fs.appendFileSync(path.join(evidence,'fixture-execution.jsonl'),JSON.stringify({at:Date.now(),phase:'finish',isError:args.failAfterGate===true,signalAborted:signal?.aborted,...event})+'\n');
  signal?.removeEventListener('abort',onAbort);
  if(args.failAfterGate)throw new Error('GENERIC_CANCELLED_REQUEST_FAILED_AFTER_GATE');
  return {content:[{type:'text',text:'CUSTOM_'+exposure+'_FINISHED'}],details:{signalAborted:signal?.aborted}};
 }});
 for(const name of ['session_start','session_shutdown','session_tree','session_before_tree','session_before_fork','session_before_switch','before_agent_start','agent_start','agent_end','agent_settled','input','tool_call','tool_result','tool_execution_start','tool_execution_end','message_end','ui_prompt_start','ui_prompt_end'])pi.on(name,(e,c)=>{eventLog(e,c)});
 pi.registerCommand('e2e-release',{description:'Release a harmless local fixture gate',async handler(args,ctx){const gate=args.trim();if(!/^[a-z0-9-]+$/.test(gate))throw new Error('Invalid gate');fs.writeFileSync(path.join(evidence,'gate-'+gate),'release');log({type:'control_release',gate},ctx);}});
 pi.registerCommand('e2e-mark',{description:'Record synthetic session identity',async handler(args,ctx){mark(args.trim(),ctx);}});
 pi.registerCommand('e2e-new',{description:'Create synthetic test session via public API',async handler(args,ctx){const label=args.trim();log({type:'control_action',action:'new',label},ctx);const result=await ctx.newSession({withSession:async fresh=>{mark(label,fresh);log({type:'control_replaced',action:'new',label},fresh);}});log({type:'control_return',action:'new',...result});}});
 pi.registerCommand('e2e-switch',{description:'Resume an existing synthetic session via public API',async handler(args,ctx){const label=args.trim(),saved=target(label);if(!fs.existsSync(saved.sessionFile))throw new Error('Synthetic session has not been persisted');log({type:'control_action',action:'switch',label,targetSessionId:saved.sessionId},ctx);const result=await ctx.switchSession(saved.sessionFile,{withSession:async fresh=>{log({type:'control_replaced',action:'switch',label},fresh);}});log({type:'control_return',action:'switch',...result});}});
 pi.registerCommand('e2e-fork',{description:'Fork a synthetic saved seed point using the public API',async handler(args,ctx){const saved=target('A');log({type:'control_action',action:'fork',targetEntryId:saved.leafId},ctx);const result=await ctx.fork(saved.leafId,{position:'at',withSession:async fresh=>{mark('F',fresh);log({type:'control_replaced',action:'fork',label:'F'},fresh);}});log({type:'control_return',action:'fork',...result});}});
 pi.registerCommand('e2e-tree',{description:'Navigate to a synthetic saved seed point without a model summary',async handler(args,ctx){const saved=target('A');log({type:'control_action',action:'tree',targetEntryId:saved.leafId},ctx);const result=await ctx.navigateTree(saved.leafId,{summarize:false});log({type:'control_return',action:'tree',...result},ctx);}});
}
