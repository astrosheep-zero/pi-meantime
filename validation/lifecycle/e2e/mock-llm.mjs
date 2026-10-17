import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(process.argv[2]),counts=new Map(),states=new Map();
function log(s,event){fs.mkdirSync(path.join(root,s),{recursive:true});fs.appendFileSync(path.join(root,s,'mock-http.jsonl'),JSON.stringify({at:Date.now(),...event})+'\n');}
function tasks(s){const found=[],dir=path.join(root,s,'tasks');try{for(const owner of fs.readdirSync(dir))for(const f of fs.readdirSync(path.join(dir,owner)))if(f.endsWith('.meta.json'))found.push(JSON.parse(fs.readFileSync(path.join(dir,owner,f))));}catch(e){if(e.code!=='ENOENT')throw e;}return found.sort((a,b)=>a.createdAt-b.createdAt);}
function taskInfo(s){return tasks(s)[0];}
function starts(s){try{return fs.readFileSync(path.join(root,s,'fixture-execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(x=>x.phase==='start');}catch{return undefined;}}
function userText(body){const u=body.messages.filter(m=>m.role==='user').at(-1);return typeof u?.content==='string'?u.content:JSON.stringify(u?.content??'');}
const server=http.createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const s=req.url.split('/')[1];try{
 const body=JSON.parse(raw),n=(counts.get(s)||0)+1;counts.set(s,n);const state=states.get(s)||{issued:new Set(),read:false,resultIds:new Set()};states.set(s,state);
 log(s,{event:'request',n,url:req.url,body,authorizationIsLocalStub:req.headers.authorization==='Bearer localstubkey'});if(n>25)throw new Error('Request safety limit');
 const user=userText(body),id=taskInfo(s)?.id;let tool,text,delay=0;
 const race=s.startsWith('cancel_'),isBash=s.startsWith('cancel_bash');
 if(race){
  if(n===1)tool=isBash?['bash',{command:'sleep 1; printf BASH_RACE_FINISHED',__background__:'yes'}]:['fixture_direct_bg',{ms:1000,...(['cancel_custom_early','cancel_custom_late','cancel_custom_error'].includes(s)?{gate:'job'}:{}),...(s==='cancel_custom_error'?{failAfterGate:true}:{}),__background__:'yes'}];
  else if(n===2){if(s==='cancel_custom_late'){const end=Date.now()+10000;while(!taskInfo(s)?.endedAt){if(Date.now()>end)throw new Error('Waiting for gated completion timed out');await new Promise(r=>setTimeout(r,10));}}const offset=s.endsWith('early')?-100:s.endsWith('late')?100:0;const start=isBash?taskInfo(s)?.createdAt:starts(s)?.at;if(!start||!id)throw new Error('Missing actual task start');delay=['cancel_custom_early','cancel_custom_late','cancel_custom_error'].includes(s)?0:Math.max(0,start+1000+offset-Date.now());tool=['bg_task',{action:'cancel',id}];}
  else if(n===3)tool=['bg_task',{action:'cancel',id}];
  else if(!state.read&&taskInfo(s)?.endedAt){tool=['bg_task',{action:'result',id}];state.read=true;}
  else text=state.read?'RACE_RESULT_READ':'WAIT_FOR_COMPLETION';
 }else if(s.startsWith('steer_')){
  if(n===1)tool=['fixture_direct_bg',{ms:1800,__background__:s==='steer_no_repeat'?'no':'auto'}];
  else if(n===2){delay=700;text='STEERING_ACCEPTED';}
  else if(!state.read&&s!=='steer_no_repeat'&&taskInfo(s)?.endedAt){tool=['bg_task',{action:'result',id}];state.read=true;}
  else text='STEERING_CONTINUES';
 }else if(user.includes('Background task completion')){const noteId=[...user.matchAll(/bg_[a-f0-9-]{36}/g)].map(x=>x[0]).at(-1);if(noteId&&!state.resultIds.has(noteId)){state.resultIds.add(noteId);tool=['bg_task',{action:'result',id:noteId}];}else text='COMPLETION_OBSERVED';}
 else if(user.includes('SEED_'))text='SEED_SAVED';
 else if(user.includes('START_LONG_TASK')&&!state.issued.has(user)){state.issued.add(user);tool=['fixture_direct_bg',{ms:5000,gate:'job',__background__:'yes'}];}
 else if(user.includes('B_OWN_JOB')&&!state.issued.has(user)){state.issued.add(user);tool=['fixture_direct_bg',{ms:200,__background__:'yes'}];}
 else if(user.includes('CHECK_FOREIGN_LIST')&&!state.issued.has(user)){state.issued.add(user);tool=['bg_task',{action:'list'}];}
 else if(user.includes('CANCEL_RECOVERED')&&!state.issued.has(user)){state.issued.add(user);tool=['bg_task',{action:'cancel',id}];}
 else if((user.includes('CHECK_FOREIGN')||user.includes('READ_ORIGINAL')||user.includes('READ_EARLY'))&&!state.issued.has(user)){state.issued.add(user);tool=['bg_task',{action:'result',id}];}
 else text='CONTROL_TURN_DONE';
 if(delay){log(s,{event:'response_wait',n,delayMs:delay});await new Promise(r=>setTimeout(r,delay));}
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const base={id:`chatcmpl-${s}-${n}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'mock-model'};const chunk=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})+'\n\n');chunk({role:'assistant',content:''});
 if(tool){chunk({tool_calls:[{index:0,id:`call_${s}_${n}`,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]});chunk({},'tool_calls');}else{chunk({content:text});chunk({},'stop');}res.write('data: [DONE]\n\n');res.end();log(s,{event:'response',n,tool,text});
 }catch(e){log(s,{event:'error',error:String(e)});if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:String(e)}}));}
});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(process.argv[3],String(server.address().port));});
