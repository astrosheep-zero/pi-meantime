import pathlib,json,re,hashlib
ROOT=pathlib.Path(__file__).resolve().parent.parent
cases=['manual_cancel_cooperative','manual_cancel_stubborn','manual_complete','manual_foreign','mcp_steer_auto','mcp_steer_no'];report=[]
def rows(p):return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
for case in cases:
 d=ROOT/'evidence'/case;s=json.loads((d/'summary.json').read_text());ev=rows(d/'host-events.jsonl');wire=rows(d/'mcp-server-events.jsonl');driver=rows(d/'driver-events.jsonl');http=rows(d/'mock-http.jsonl');meta=json.loads((d/'metadata-before-quit.json').read_text());screen=(d/'tui-stripped.txt').read_text();raw=(d/'tui.ansi').read_text();checks=[]
 def ck(name,v):
  if not v:raise AssertionError(case+': '+name)
  checks.append(name)
 ck('normal real CLI/PTY exit',s['processExit']==0 and s['driverFailure'] is None and json.loads((d/'cli-process-status.json').read_text())=={'status':0,'signal':None,'error':None})
 ck('exact frozen production bytes',all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in json.loads((d/'source-hashes-at-launch.json').read_text()).items()))
 ck('local mock only',all(x['authorizationIsLocalStub'] for x in http if x['event']=='request'))
 calls=[x for x in wire if x['event']=='request' and x['message']['method']=='tools/call'];cancels=[x for x in wire if x['event']=='cancel_received'];results=[x for x in ev if x['event']['type']=='tool_result'];ends=[x for x in ev if x['event']['type']=='tool_execution_end'];notes=[x for x in ev if x['event']['type']=='message_end' and x['event'].get('message',{}).get('customType')=='meantime-completion']
 ck('no business control leakage',all('__background__' not in x['message']['params']['arguments'] for x in calls))
 ck('only expected business calls',len(calls)==(2 if case=='manual_foreign' else 1))
 ck('no duplicate completion notices',len([i for x in notes for i in x['event']['message']['details']['taskIds']])==len(set(i for x in notes for i in x['event']['message']['details']['taskIds'])))
 for t in meta:
  disk=json.loads(next(d.glob('tasks/*/'+t['id']+'.meta.json')).read_text());ck('close retains '+t['id'],disk==t)
 if case.startswith('mcp_steer'):
  ck('three actual steer inputs',len([x for x in ev if x['event']['type']=='input' and x['event'].get('streamingBehavior')=='steer'])==3)
  delivered=[x['event']['message']['content'][0]['text'] for x in ev if x['event']['type']=='message_end' and x['event'].get('message',{}).get('role')=='user' and 'STEER_REPEAT_' in str(x['event']['message'])]
  ck('steers delivered once and in order',delivered==['STEER_REPEAT_1','STEER_REPEAT_2','STEER_REPEAT_3'])
  ck('steer never sends cancellation',len(cancels)==0)
  ck('success not an outer error',all(x['event']['isError']==False for x in results+ends))
  ck('completed once',s['mcpFinishes']==1 and meta[0]['state']=='completed' and meta[0]['isError']==False)
  ck('correct detach mode',meta[0]['delivery']==('background' if case.endswith('auto') else 'foreground'))
  ck('no visible cancellation/error text',not re.search(r'MCP request aborted|outcome_unknown|: failed|Cannot cancel|\x1b\[38;5;1m|\x1b\[31m',raw))
  if case.endswith('auto'):ck('visible actionable successful background receipt','execution continues independently' in screen and '/bg cancel '+meta[0]['id'] in screen and len(notes)==1)
  else:ck('no false background receipt','execution continues independently' not in screen and len(notes)==0)
 elif case=='manual_complete':
  ck('completed cancel is idempotent',not cancels and meta[0]['state']=='completed' and meta[0]['isError']==False)
  ck('visible no-running-call feedback','No running local call was cancelled' in screen)
 else:
  target=meta[-1];wanted=2 if case=='manual_foreign' else 1
  ck('single native cancel per actual target',len(cancels)==wanted and len(set((x['instanceId'],x['requestId']) for x in cancels))==wanted)
  ck('returned native error not unknown',target['state']=='failed' and target['isError']==True and target['cancelRequestedAt'])
  payload=json.loads(next(d.glob('tasks/*/'+target['id']+'.result.json')).read_text());ck('native raw result exact',payload=={'content':[{'type':'text','text':'MCP request aborted'}],'details':{}})
  read=next(x for x in results if x['event']['toolName']=='meantime' and x['event']['input'].get('action')=='result');ck('outer final error retained',read['event']['isError']==True and any(x.get('text')=='MCP request aborted' for x in read['event']['content']))
  ck('visible native cancellation outcome','MCP request aborted' in screen and 'A cancellation was requested' in screen)
  ck('stable latest-control panel','Latest background control:' in screen and 'Cancellation requested for' in screen)
  if case=='manual_foreign':
   wrong=next(x for x in driver if x['text']=='/bg cancel '+s['aid']);right=next(x for x in driver if x['text']=='/bg cancel '+s['bid']);bcall=calls[-1]
   ck('foreign id cannot cancel current task',not any(x['instanceId']==bcall['instanceId'] and x['at']<right['at'] for x in cancels))
   ck('visible foreign ownership error','No task with that id in this session' in screen)
   bsession=next(x['sessionId'] for x in ev if x['event']['type']=='control_new_session')
   ck('no old completion delivered to B',all(s['aid'] not in x['event']['message']['details']['taskIds'] for x in notes if x['sessionId']==bsession))
  else:
   right=next(x for x in driver if x['text']=='/bg cancel '+s['aid']);ck('no-id and wrong-id cause no cancellation',all(x['at']>=right['at'] for x in cancels))
   ck('visible usage and readable task list','Usage: /bg cancel <id>' in screen and 'No task was cancelled' in screen and 'Current session tasks 1-1 of 1' in screen)
   ck('no stale old info-history rewrite',not re.search('Task .*failed. No running local call was cancelled',screen.split('Latest background control:')[0]))
   ck('remote behavior faithful',s['mcpStops']==(1 if case.endswith('cooperative') else 0) and s['mcpFinishes']==(1 if case.endswith('stubborn') else 0))
 report.append({'case':case,'status':'PASS','checks':checks,'providerRequests':s['providerRequests']})
out={'status':'PASS','cases':report,'totalCases':len(report),'totalChecks':sum(len(x['checks']) for x in report),'providerRequests':sum(x['providerRequests'] for x in report)};(ROOT/'evidence/verified-manual-results.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
