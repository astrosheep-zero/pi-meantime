import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]); const counts=new Map();
function log(s,event){fs.mkdirSync(path.join(root,s),{recursive:true});fs.appendFileSync(path.join(root,s,'mock-http.jsonl'),JSON.stringify({at:Date.now(),...event})+'\n');}
function plan(s){
 const mode=s==='bash_no'?'no':(s.includes('auto')||s==='bash_steer'||s==='bash_shortcut')?'auto':'yes';
 if(s.startsWith('bash_'))return ['bash',{command:'sleep 2.2; printf BASH_E2E_FINISHED',__meantime__:mode}];
 if(s.startsWith('mcp_'))return ['mcp__meantime_fixture__slow_mt',{ms:2200,text:'MCP_E2E_FINISHED',__meantime__:mode}];
 if(s==='search_deferred')return ['tool_search',{query:'mcp__deferred__slow_mt',limit:1}];
 if(s==='codemode_mcp')return ['codemode',{code:'text(await tools.mcp__indirect__slow_mt({ms:2200,text:"CODEMODE_MCP_FINISHED",__meantime__:"yes"}));'}];
 if(s==='deferred_mcp')return ['codemode',{code:'text(await tools.mcp__deferred__slow_mt({ms:2200,text:"DEFERRED_MCP_FINISHED",__meantime__:"yes"}));'}];
 if(s==='custom_codemode')return ['codemode',{code:'text(await tools.fixture_codemode_mt({ms:2200,__meantime__:"yes"}));'}];
 if(s==='custom_deferred')return ['codemode',{code:'text(await tools.fixture_deferred_mt({ms:2200,__meantime__:"yes"}));'}];
 if(s.startsWith('cancel_bash'))return ['bash',{command:'sleep 12; printf CANCEL_SHOULD_NOT_FINISH',__meantime__:'yes'}];
 if(s.startsWith('cancel_mcp'))return ['mcp__meantime_fixture__stubborn_mt',{ms:4000,text:'STUBBORN_FINISHED',marker:path.join(root,s,'remote-side-effect.txt'),__meantime__:'yes'}];
 if(s.startsWith('reload_custom')||s==='switch_custom')return ['codemode',{code:'text(await tools.fixture_codemode_mt({ms:5000,__meantime__:"yes"}));'}];
 if(s==='reload_mcp')return ['mcp__meantime_fixture__stubborn_mt',{ms:5000,text:'RELOAD_LATE_FINISHED',marker:path.join(root,s,'remote-side-effect.txt'),__meantime__:'yes'}];
 throw new Error('unknown scenario '+s);
}
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const x of req)raw+=x;
 const scenario=req.url.split('/')[1];
 if(req.url==='/health'){res.end('ready');return;}
 try{
 const body=JSON.parse(raw);const n=(counts.get(scenario)||0)+1;counts.set(scenario,n);
 log(scenario,{event:'request',n,url:req.url,method:req.method,body,authorizationIsLocalStub:req.headers.authorization==='Bearer localstubkey'});
 if(n>12)throw new Error('request safety cap exceeded');
 const str=JSON.stringify(body.messages); const ids=[...str.matchAll(/bg_[a-f0-9-]{36}/g)].map(m=>m[0]);const id=ids.at(-1);
 let tool,text;
 if(n===1)tool=plan(scenario);
 else if(n===2&&scenario==='search_deferred')tool=['mcp__deferred__slow_mt',{ms:2200,text:'SEARCH_DEFERRED_FINISHED',__meantime__:'yes'}];
 else if(n===3&&(scenario.startsWith('reload_custom')||scenario==='switch_custom'))tool=['meantime',{action:'result',id}];
 else if(n===2&&scenario.startsWith('cancel_'))tool=['meantime',{action:'cancel',id}];
 else if(str.includes('Background task completion')){
   const calls=body.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]);
   if(!calls.some(c=>c.function?.name==='meantime'&&c.function?.arguments.includes('result')))tool=['meantime',{action:'result',id}];
   else text='RESULT_READ_OK '+scenario;
 }
 else text=n===2?'INITIAL_HANDLE_ACCEPTED '+scenario:'RESULT_READ_OK '+scenario;
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const base={id:`chatcmpl-${scenario}-${n}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'mock-model'};
 const chunk=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})+'\n\n');
 chunk({role:'assistant',content:''});
 if(tool){chunk({tool_calls:[{index:0,id:`call_${scenario}_${n}`,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]});chunk({},'tool_calls');}
 else {chunk({content:text});chunk({},'stop');}
 res.write('data: [DONE]\n\n');res.end();log(scenario,{event:'response',n,tool,text});
 }catch(e){log(scenario,{event:'error',error:String(e)});res.writeHead(500);res.end(JSON.stringify({error:{message:String(e)}}));}
});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(process.argv[3]||path.join(root,'mock-port.txt'),String(server.address().port));console.log('MOCK_READY '+server.address().port)});
