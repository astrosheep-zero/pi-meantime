import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve('evidence');const results=[];
const read=(c,f)=>JSON.parse(fs.readFileSync(path.join(root,c,f),'utf8'));
const lines=(c,f)=>fs.readFileSync(path.join(root,c,f),'utf8').trim().split('\n').map(x=>JSON.parse(x));
const task=r=>r?.structuredContent?.task??r?.details?.task??r?.details;
function test(name,fn){try{const extra=fn()||{};results.push({name,status:'PASS',...extra})}catch(e){results.push({name,status:'FAIL',error:String(e)})}}
for(const c of ['bash_yes_repeat','bash_auto','mcp_yes','mcp_auto','codemode_mcp','deferred_mcp','custom_codemode','custom_deferred','bash_steer','bash_shortcut','search_deferred'])test(c,()=>{
 const summary=read(c,'summary.json'),e=lines(c,'host-events.jsonl'),http=lines(c,'mock-http.jsonl');const req=http.filter(x=>x.event==='request');const ends=e.filter(x=>x.event.type==='tool_execution_end');
 assert.equal(summary.processExit,0);assert.deepEqual(read(c,'cli-process-status.json'),{status:0,signal:null,error:null});assert.deepEqual(summary.mode,['tui']);assert(req.every(x=>x.authorizationIsLocalStub));
 const first=ends.find(x=>task(x.event.result)?.delivery==='background'&&task(x.event.result)?.state==='running');assert(first,'missing running background handle');
 const id=task(first.event.result).id;const note=e.find(x=>x.event.type==='message_end'&&x.event.message.customType==='bg-poc-completion');assert(note,'no completion notification');assert(note.at>first.at,'completion must follow handle');
 const result=ends.find(x=>x.event.toolName==='bg_task'&&x.event.result.structuredContent?.result_available===true);assert(result,'result not retrieved');assert.equal(task(result.event.result).id,id);assert.equal(task(result.event.result).state,'completed');assert.equal(summary.completionMessages,1);
 assert(req.some(x=>x.at>=note.at&&JSON.stringify(x.body.messages).includes('Background task completion')),'completion did not trigger HTTP request');
 const names=req[0].body.tools.map(t=>t.function?.name);assert(!names.includes('mcp__bg_poc_fixture__slow'));assert(names.includes('mcp__bg_poc_fixture__slow_bg'));assert(!names.includes('fixture_codemode_bg'));assert(!names.includes('fixture_deferred_bg'));assert(!names.includes('mcp__deferred__slow_bg'));
 if(c==='search_deferred')assert(req[1].body.tools.some(t=>t.function?.name==='mcp__deferred__slow_bg'));
 const maps=e.find(x=>x.event.type==='loadout_evidence').event.tools;for(const n of ['fixture_codemode','fixture_deferred','mcp__indirect__slow','mcp__deferred__slow'])assert.equal(maps.find(t=>t.name===n)?.exposure,maps.find(t=>t.name===n+'_bg')?.exposure);
 if(c.includes('mcp')||c==='search_deferred'){
  const server=c==='codemode_mcp'?'indirect':c==='deferred_mcp'||c==='search_deferred'?'deferred':'bg_poc_fixture';const wire=lines(c,'mcp-'+server+'.jsonl');const calls=wire.flatMap(x=>x.data.trim().split('\n').map(l=>({direction:x.direction,msg:JSON.parse(l)}))).filter(x=>x.msg.method==='tools/call');assert.equal(calls.length,1);assert(!('__background__' in calls[0].msg.params.arguments));
  const original=ends.find(x=>x.event.toolName===task(first.event.result).tool);assert(original.at>first.at);assert(original.event.parentToolCallId);assert(original.at<=note.at);
 }
 const reason=task(first.event.result).detachReason;if(c.includes('auto'))assert.equal(reason,'timeout');if(c==='bash_steer')assert.equal(reason,'steer');if(c==='bash_shortcut')assert.equal(reason,'shortcut');
 return {handleMs:first.event.durationMs,finishAfterHandleMs:note.at-first.at,requestCount:req.length,detachReason:reason};
});
test('bash_no_rejects_shortcut',()=>{const d=read('bash_no','summary.json');const t=d.tools.find(t=>t.name==='bash');assert.equal(task(t.result).delivery,'foreground');assert.equal(task(t.result).state,'completed');assert(t.durationMs>2000);assert.equal(d.completionMessages,0);return {durationMs:t.durationMs}});
for(const c of ['cancel_bash_repeat','cancel_mcp_repeat'])test(c,()=>{const d=read(c,'summary.json');const result=d.tools.find(x=>x.name==='bg_task'&&x.result.structuredContent?.result_available===true);assert(result);assert.equal(task(result.result).state,'failed');if(c.includes('mcp')){assert(fs.existsSync(path.join(root,c,'remote-side-effect.txt')));assert(lines(c,'mcp-bg_poc_fixture.jsonl').some(x=>x.data.includes('notifications/cancelled')))}return {resultState:task(result.result).state,remoteSideEffect:c.includes('mcp')}});
test('reload_mcp_suppresses_old_notification',()=>{const d=read('reload_mcp','summary.json');assert.equal(d.shutdowns,2);assert.equal(d.completionMessages,0);assert(d.tools.some(x=>x.name==='mcp__bg_poc_fixture__stubborn'&&x.isError));});
test('reload_late_result_refresh_and_close_preservation',()=>{
 const c='reload_custom_repeat',d=read(c,'summary.json'),events=lines(c,'host-events.jsonl'),http=lines(c,'mock-http.jsonl');
 assert.equal(d.processExit,0);assert.equal(d.shutdowns,2);assert.equal(d.completionMessages,0);
 assert(http.filter(x=>x.event==='request').every(x=>x.authorizationIsLocalStub));
 const originals=d.tools.filter(x=>x.name==='fixture_codemode');assert.equal(originals.length,1);const late=originals[0],result=d.tools.find(x=>x.name==='bg_task');assert(!late.isError);assert(late.at<result.at);
 assert.equal(result.result.structuredContent.result_available,true);assert.equal(task(result.result).state,'completed');assert.equal(task(result.result).recovered,true);assert(result.result.content.some(x=>x.text?.includes('CUSTOM_codemode_FINISHED')));
 const before=Object.values(read(c,'metadata-before-quit.json'))[0];assert.equal(before.state,'completed');assert(before.resultPath);assert(before.endedAt);
 const ownerDir=fs.readdirSync(path.join(root,c,'tasks'))[0];const after=JSON.parse(fs.readFileSync(path.join(root,c,'tasks',ownerDir,before.id+'.meta.json')));
 assert.equal(after.state,'completed');assert.equal(after.resultPath,before.resultPath);assert.equal(after.endedAt,before.endedAt);
 assert(fs.existsSync(path.join(root,c,'tasks',ownerDir,before.id+'.result.json')));
 return {beforeQuit:before.state,afterQuit:after.state,resultRead:'available',originalCalls:originals.length};
});
test('runtime_retention_after_notifications',()=>{const d=read('runtime-regressions','retention.json');assert.equal(d.maxRetained,1);assert.equal(d.actualRetained,1);assert(d.tasks.every(t=>t.notification==='queued'));return {scope:'runtime-unit-only',configured:1,retained:1}});
test('new_session_does_not_expose_or_notify_old_task',()=>{
 const c='switch_custom',d=read(c,'summary.json'),e=lines(c,'host-events.jsonl'),http=lines(c,'mock-http.jsonl');
 assert.equal(d.processExit,0);assert.equal(d.completionMessages,0);
 const starts=e.filter(x=>x.event.type==='session_start');assert.equal(starts.length,2);assert.notEqual(starts[0].sessionId,starts[1].sessionId);
 const originals=e.filter(x=>x.event.type==='tool_execution_start'&&x.event.toolName==='fixture_codemode');assert.equal(originals.length,1);
 const saved=Object.values(read(c,'metadata-before-quit.json'))[0];assert.equal(saved.state,'completed');assert(saved.endedAt);assert(saved.resultPath);
 const inspected=d.tools.find(x=>x.name==='bg_task');assert(inspected);assert.equal(inspected.isError,true);assert(JSON.stringify(inspected.result).includes('No task with that id in this session'));
 assert(http.filter(x=>x.event==='request').every(x=>x.authorizationIsLocalStub));
 return {differentSessionIds:true,oldResultInNewSession:'rejected',completionMessages:0,scope:'actual TUI /new only'};
});
fs.writeFileSync(path.join(root,'verified-results.json'),JSON.stringify(results,null,2));for(const r of results)console.log(JSON.stringify(r));if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
