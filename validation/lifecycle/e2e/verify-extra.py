import json,pathlib,hashlib,traceback
ROOT=pathlib.Path(__file__).resolve().parent.parent;E=ROOT/'evidence'
CASES=['session_roundtrip_late','session_roundtrip_early','fork_late','tree_late','steer_repeat','steer_no_repeat','cancel_custom_early','cancel_custom_boundary_1','cancel_custom_boundary_2','cancel_custom_late','cancel_custom_error','cancel_bash_early','cancel_bash_boundary','cancel_bash_late']
def rows(p):return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
def task(r):return r.get('structuredContent',{}).get('task') or r.get('details',{}).get('task') or r.get('details',{})
def check(v,message):
 if not v:raise AssertionError(message)
results=[]
for c in CASES:
 try:
  d=E/c;s=json.loads((d/'summary.json').read_text());events=rows(d/'host-events.jsonl');http=rows(d/'mock-http.jsonl');req=[x for x in http if x['event']=='request'];responses=[x for x in http if x['event']=='response'];fx=rows(d/'fixture-execution.jsonl') if (d/'fixture-execution.jsonl').exists() else []
  cli=json.loads((d/'cli-process-status.json').read_text());check(cli=={'status':0,'signal':None,'error':None},'CLI subprocess did not exit normally');check(s['processExit']==0 and s['driverFailure'] is None,'TUI must finish normally');check(s['mode']==['tui'],'not TUI');check(all(x['authorizationIsLocalStub'] for x in req),'nonstub request');check(not [x for x in http if x['event']=='error'],'mock error')
  hashes=json.loads((d/'source-hashes-at-launch.json').read_text());check(all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items()),'loaded source mismatch')
  check(any(x['event']=={'type':'session_shutdown','reason':'quit'} for x in events),'missing normal quit lifecycle')
  loaded=json.loads((E/'source-version-verification.json').read_text());check(hashes==loaded['productionSha256'],'loaded source differs from original delivered version')
  lifecycle=[x for x in events if x['event']['type']=='session_start']
  for previous,current in zip(lifecycle,lifecycle[1:]):
   reason=current['event']['reason'];between=[x for x in events if previous['at']<=x['at']<=current['at']];check(current['event'].get('previousSessionFile')==previous['sessionFile'],'wrong previous session file')
   shut=[x for x in between if x['event']['type']=='session_shutdown' and x['event'].get('reason')==reason];check(len(shut)==1 and shut[0]['sessionFile']==previous['sessionFile'] and shut[0]['event'].get('targetSessionFile')==current['sessionFile'],'shutdown target mismatch')
   be=[x for x in between if x['event']['type']==('session_before_fork' if reason=='fork' else 'session_before_switch')];check(len(be)==1 and be[0]['at']<=shut[0]['at'],'before lifecycle missing')
   if reason!='fork':check(be[0]['event'].get('reason')==reason and (reason=='new' or be[0]['event'].get('targetSessionFile')==current['sessionFile']),'before switch reason/target mismatch')
   nextStart=next((x['at'] for x in lifecycle if x['at']>current['at']),float('inf'));replaced=[x for x in events if x['event']['type']=='control_replaced' and current['at']<=x['at']<nextStart and x['sessionId']==current['sessionId'] and x['sessionFile']==current['sessionFile']];check(len(replaced)==1,'withSession did not bind replacement')
  returns=[x for x in events if x['event']['type']=='control_return'];check(all(x['event'].get('cancelled') is False for x in returns),'session navigation cancelled');check(len(returns)==len(lifecycle)-1+(1 if c=='tree_late' else 0),'navigation return count')
  tools=s['tools'];outer=next(x for x in tools if x['toolName'] in ['fixture_direct_bg','bash']);old=task(outer['result']);oid=old['id'];source_session=(outer['sessionId'],outer['sessionFile']);metas={p.stem.removesuffix('.meta'):json.loads(p.read_text()) for p in d.glob('tasks/*/*.meta.json')};meta=metas[oid]
  before=json.loads((d/'metadata-before-quit.json').read_text());beforeOld=next(x for x in before.values() if x['id']==oid)
  check(all(meta.get(k)==beforeOld.get(k) for k in ['state','endedAt','resultPath','cancelRequestedAt','producerId']),'quit regressed terminal metadata');check(meta.get('endedAt') and meta.get('resultPath'),'no terminal result');check((d/'tasks'/hashlib.sha256((source_session[0]+'\0'+source_session[1]).encode()).hexdigest()[:32]/(oid+'.result.json')).exists(),'wrong owner or missing result')
  rawCalls=[x['tool'] for x in responses if x.get('tool')];reads=[x for x in tools if x['toolName']=='bg_task' and x['result'].get('structuredContent',{}).get('result_available') is True and task(x['result']).get('id')==oid]
  check(meta.get('producerId')==old.get('producerId'),'producer ownership changed')
  retained=json.loads(next((d/'tasks').glob('*/'+oid+'.result.json')).read_text())
  for read in reads:
   check(read['result']['structuredContent']['result']==retained.get('structuredContent','\n'.join(b['text'] for b in retained['content'] if b['type']=='text')),'model read differs from retained result')
  starts=[x for x in fx if x['phase']=='start'];finishes=[x for x in fx if x['phase']=='finish'];aborts=[x for x in fx if x['phase']=='abort'];extra={}
  if c.startswith('session_') or c in ['fork_late','tree_late']:
   original=[x for x in starts if x.get('gate')=='job'];finish=[x for x in finishes if x.get('gate')=='job'];abort=[x for x in aborts if x.get('gate')=='job'];check(len(original)==len(finish)==len(abort)==1,'producer replay or wrong abort count');check(finish[0]['signalAborted'] is True,'old producer not cancelled by shutdown');check(meta['state']=='completed','late success lost');check(reads and task(reads[-1]['result'])['recovered'] is True,'not read by recovered runtime')
   check((reads[-1]['sessionId'],reads[-1]['sessionFile'])==source_session,'read returned in wrong owner');check(not any(oid in n['message'].get('details',{}).get('taskIds',[]) for n in s['completionMessages']),'old notification leaked')
   early=[x for x in tools if x['toolName']=='bg_task' and x['result'].get('structuredContent',{}).get('result_available') is False and task(x['result']).get('id')==oid]
   foreign=[x for x in tools if x['toolName']=='bg_task' and 'No task with that id in this session' in json.dumps(x['result'])]
   if c.startswith('session_'):
    check(len(s['starts'])==5,'expected startup,new B,resume A,resume B,resume A');A=s['starts'][0];B=s['starts'][1];check(A['sessionId']!=B['sessionId'] and A['sessionFile']!=B['sessionFile'],'A/B identity');check(all((x['sessionId'],x['sessionFile'])==(A['sessionId'],A['sessionFile']) for x in [s['starts'][2],s['starts'][4]]),'return A changed identity');check((s['starts'][3]['sessionId'],s['starts'][3]['sessionFile'])==(B['sessionId'],B['sessionFile']),'did not resume existing B');check(all(x['reason']=='resume' for x in s['starts'][2:]),'not resume existing sessions')
    check(foreign and foreign[0]['sessionId']==B['sessionId'],'B did not reject A ID');check(any(x['toolName']=='bg_task' and x['sessionId']==B['sessionId'] and x['result'].get('structuredContent',{}).get('tasks')==[] for x in tools),'B list exposed A')
    positive=[n for n in s['completionMessages'] if n['sessionId']==B['sessionId']];check(len(positive)==1,'B own notification positive control missing');check(oid not in json.dumps(positive),'old ID in B notification');check(any('Background task completion' in json.dumps(r['body']) and positive[0]['message']['details']['taskIds'][0] in json.dumps(r['body']) for r in req),'positive note did not trigger provider')
    if c.endswith('late'):check(s['starts'][3]['at']<finish[0]['at']<s['starts'][4]['at'],'old completion did not occur while B active')
    else:
     check(early and task(early[0]['result'])['state']=='outcome_unknown','no early unknown view');check(s['starts'][4]['at']<early[0]['at']<finish[0]['at']<reads[-1]['at'],'current restored runtime did not refresh late completion');check(any('no live local controller' in json.dumps(x['result']) for x in tools),'recovered cancel must reject')
    extra={'sameOriginalSessionIdAndFile':True,'lateCompletionWhile':('B' if c.endswith('late') else 'restored A'),'foreignAccess':'rejected','BNotificationPositiveControl':True}
   elif c=='fork_late':
    check(len(s['starts'])==3 and s['starts'][1]['reason']=='fork' and s['starts'][2]['reason']=='resume','not real fork then resume');check(s['starts'][0]['sessionId']!=s['starts'][1]['sessionId'],'fork identity unchanged');check(foreign and foreign[0]['sessionId']==s['starts'][1]['sessionId'],'fork can read old task');check(s['starts'][1]['at']<finish[0]['at']<s['starts'][2]['at'],'late completion not in fork interval');extra={'forkAccess':'rejected','resumeOriginalResult':'completed'}
   else:
    check(len(s['starts'])==1,'tree replaced session');trees=[x for x in events if x['event']['type']=='session_tree'];check(len(trees)==1,'tree no-op or absent');check((trees[0]['sessionId'],trees[0]['sessionFile'])==source_session,'tree changed owner');check(early and early[0]['at']<finish[0]['at']<reads[-1]['at'],'tree late refresh not established');check(not s['completionMessages'],'tree old notification leaked');extra={'sameSessionTreeNavigation':True,'earlyUnknownThenCompleted':True}
  elif c.startswith('steer_'):
   steers=[x for x in events if x['event']['type']=='input' and x['event'].get('text','').startswith('STEER_REPEAT_')];check(len(steers)==3 and all(x['event'].get('streamingBehavior')=='steer' for x in steers),'not three real streaming steers');check(len(starts)==len(finishes)==1 and len(aborts)==0,'steer restarted/aborted producer');
   expectedInputs=[x['event']['text'] for x in steers];userMessages=[x['event']['message'] for x in events if x['event']['type']=='message_end' and x['event'].get('message',{}).get('role')=='user'];delivered=[''.join(b['text'] for b in m['content'] if b.get('type')=='text') if isinstance(m.get('content'),list) else m.get('content') for m in userMessages];check([x for x in delivered if x in expectedInputs]==expectedInputs,'steer user messages duplicated or reordered');
   histories=[[m for m in r['body']['messages'] if m.get('role')=='user'] for r in req];ordered=False
   for history in histories:
    texts=[''.join(b['text'] for b in m['content'] if b.get('type')=='text') if isinstance(m.get('content'),list) else m.get('content') for m in history];visible=[x for x in texts if x in expectedInputs]
    check(len(visible)==len(set(visible)),'duplicate steer payload in one HTTP history')
    if visible==expectedInputs:ordered=True
   check(ordered,'no HTTP history has all three steers in order');check(finishes[0]['signalAborted'] is False,'steer aborted');check(len(metas)==1,'extra task');check(all(any(x['event']['text'] in json.dumps(r['body']['messages']) for r in req) for x in steers),'steering payload lost from model requests')
   if c=='steer_repeat':check(old['delivery']=='background' and old['detachReason']=='steer' and old['state']=='running','not detached by steer');check(len(s['completionMessages'])==1 and reads,'completion/read missing')
   else:check(old['delivery']=='foreground' and old['state']=='completed' and 'detachReason' not in old,'no mode detached');check(not s['completionMessages'],'no mode extra completion')
   extra={'realStreamingSteers':3,'producerCalls':1,'signalAborted':False,'delivery':old['delivery']}
  else:
   cancelIds=[f'call_{c}_{x["n"]}' for x in responses if x.get('tool',[None,{}])[0]=='bg_task' and x['tool'][1].get('action')=='cancel'];cancels=[x for x in tools if x['toolCallId'] in cancelIds];check(len(cancels)==2,'not two real cancel calls');check(len(metas)==1,'race duplicated task');check(reads,'race result not read');check(task(cancels[0]['result']).get('cancelRequestedAt')==task(cancels[1]['result']).get('cancelRequestedAt'),'double cancel changed timestamp');check(len(s['completionMessages'])<=1,'duplicate notification')
   cancelled_before=bool(meta.get('cancelRequestedAt'));retained=json.loads(next((d/'tasks').glob('*'+ '/' +oid+'.result.json')).read_text());expected='failed' if c=='cancel_custom_error' or c.startswith('cancel_bash') and cancelled_before and meta.get('isError') else 'completed';check(meta['state']==expected,'wrong final race outcome')
   if c.startswith('cancel_custom'):
    check(len(starts)==len(finishes)==1,'custom replay');check(len(aborts)==(1 if cancelled_before else 0),'double abort or false abort');check(finishes[0]['signalAborted']==cancelled_before,'abort evidence mismatch')
    if c.endswith('early') or c.endswith('error'):check(cancels[1]['at']<finishes[0]['at'] and cancelled_before,'gated cancel-before-complete not established')
    if c.endswith('late'):check(finishes[0]['at']<cancels[0]['at'] and not cancelled_before,'gated complete-before-cancel not established')
   else:
    check(len([x for x in events if x['event']['type']=='tool_execution_start' and x['event']['toolName']=='bash'])==1,'bash replay')
    cancelCalls=[x for x in events if x['event']['type']=='tool_call' and x['event'].get('toolCallId') in cancelIds];check(len(cancelCalls)==2,'cancel invocation evidence missing')
    if c.endswith('early'):check(cancelled_before and cancelCalls[0]['at']<=meta['cancelRequestedAt']<meta['endedAt'] and task(cancels[0]['result'])['state']=='cancel_requested','Bash early no longer cancel-before-settlement')
    if c.endswith('late'):check(not cancelled_before and meta['endedAt']<cancelCalls[0]['at'] and all(task(x['result'])['state']=='completed' for x in cancels),'Bash late no longer complete-before-cancel')
    if c.endswith('boundary'):check(900<=cancelCalls[0]['at']-meta['createdAt']<=1300,'Bash boundary missed intended timing window')
   extra={'cancelCalls':2,'cancelBeforeSettlement':cancelled_before,'finalState':meta['state'],'firstCancelReturn':task(cancels[0]['result']).get('state'),'secondCancelReturn':task(cancels[1]['result']).get('state'),'cancelVsEndMs':(meta['cancelRequestedAt']-meta['endedAt']) if cancelled_before else cancels[0]['at']-meta['endedAt']}
  results.append({'case':c,'status':'PASS','requests':len(req),**extra})
 except Exception as error:results.append({'case':c,'status':'FAIL','error':str(error),'trace':traceback.format_exc()})
(E/'verified-extra-results.json').write_text(json.dumps(results,indent=2));print('\n'.join(json.dumps(x) for x in results));raise SystemExit(1 if any(x['status']!='PASS' for x in results) else 0)
