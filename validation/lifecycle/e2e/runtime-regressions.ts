import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TaskRuntime} from '../src/runtime.ts';
import {TaskStore} from '../src/store.ts';
import {validateConfig} from '../src/config.ts';
import {deferred,ok,sleep,until} from '../test/helpers.ts';
import type {Outcome} from '../src/protocol.ts';
const root=new URL('../evidence/runtime-regressions/',import.meta.url).pathname;fs.mkdirSync(root,{recursive:true});
const config=validateConfig({storageRoot:root,autoDetachMs:0,shutdownGraceMs:10,notifyDebounceMs:5});
const store=new TaskStore(root,'same-session',config.maxResultBytes);const old=new TaskRuntime(store,config,{notify(){}});
const work=deferred<Outcome>();const view=await old.run({tool:'noncooperative',kind:'tool',callId:'late',mode:'yes',canDetach:true,execute:()=>work.promise});old.published('late');await old.close();
const restored=new TaskRuntime(store,config,{notify(){}});const before=restored.get(view.task.id);
work.resolve(ok('LATE_REAL_RESULT'));await until(()=>TaskRuntime.liveProducerCount()===0);
const after=restored.result(view.task.id);const diskBeforeClose=store.loadMetadata().find(x=>x.id===view.task.id);const diskResult=store.readResult(view.task.id);
assert.equal(diskBeforeClose?.state,'completed');assert.equal(after.task.state,'completed');assert.deepEqual(after.result,diskResult);assert.equal(after.task.resultPath,diskBeforeClose.resultPath);
await restored.close();const diskAfterClose=store.loadMetadata().find(x=>x.id===view.task.id);
assert.equal(diskAfterClose?.state,'completed');assert.equal(diskAfterClose?.resultPath,diskBeforeClose?.resultPath);assert.equal(diskAfterClose?.endedAt,diskBeforeClose?.endedAt);
const data={kind:'runtime-regression-not-Pi-e2e',before,liveAfterLateFinish:after,diskBeforeClose,diskResult,diskAfterClose,findings:['Current restored runtime reads late completed result','Closing restored runtime preserves terminal metadata']};
fs.writeFileSync(root+'late-recovery.json',JSON.stringify(data,null,2));console.log('PASS: restored runtime reads late result and close preserves completed metadata');
const cfg=validateConfig({...config,storageRoot:root+'/retention',maxRetained:1});const st=new TaskStore(cfg.storageRoot,'retention',cfg.maxResultBytes);let notifications=0;const rt=new TaskRuntime(st,cfg,{notify(){notifications++}});
rt.prompt(true);const jobs=[deferred<Outcome>(),deferred<Outcome>(),deferred<Outcome>()];
const handles=[];for(let i=0;i<jobs.length;i++){
 // Do not hold the prompt while requesting explicit detach; hold it only at completion.
 rt.prompt(false);handles.push(await rt.run({tool:'retained',kind:'tool',callId:'c'+i,mode:'yes',canDetach:true,execute:()=>jobs[i]!.promise}));rt.prompt(true);rt.published('c'+i);
}
jobs.forEach(j=>j.resolve(ok()));await until(()=>TaskRuntime.liveProducerCount()===0);rt.prompt(false);rt.flushNotifications();await sleep(20);
const retained=rt.list();assert.equal(retained.length,1);assert.equal(retained.every(x=>x.notification==='queued'),true);
fs.writeFileSync(root+'retention.json',JSON.stringify({kind:'runtime-regression-not-Pi-e2e',maxRetained:1,actualRetained:retained.length,notifications,tasks:retained},null,2));console.log('PASS: maxRetained=1 retains exactly 1 completed record after notification flush');await rt.close();
