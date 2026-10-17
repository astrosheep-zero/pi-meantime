"""Compare actual native / background / no-mode MCP cancellation evidence."""
import hashlib,json,pathlib,zipfile
ROOT=pathlib.Path(__file__).resolve().parent.parent
E=ROOT/'evidence'
KINDS=['cooperative','stubborn','late_error']
def rows(path):return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
def check(value,message):
 if not value:raise AssertionError(message)
def original_event(events,kind):
 found=[x for x in events if x['event']['type']=='tool_execution_end' and x['event']['toolName']=='mcp__parity__'+kind]
 check(len(found)==1,'native MCP end missing or repeated')
 return found[0]
source_files=['index.mjs','package.json']+['src/'+p.name for p in (ROOT/'src').iterdir()]
source_hashes={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in source_files}
results=[]
for kind in KINDS:
 expected=None;cancel_message=None;cases=[]
 for mode in ['native','bg','no']:
  case=mode+'_'+kind;d=E/case
  events=rows(d/'host-events.jsonl');wire=rows(d/'mcp-server-events.jsonl');http=rows(d/'mock-http.jsonl');summary=json.loads((d/'summary.json').read_text())
  check(summary['processExit']==0 and summary['driverFailure'] is None,'driver failure '+case)
  check(json.loads((d/'cli-process-status.json').read_text())=={'status':0,'signal':None,'error':None},'CLI abnormal '+case)
  check(summary['mode']==['tui'],'not real TUI')
  check(json.loads((d/'source-hashes-at-launch.json').read_text())==source_hashes,'production source mismatch')
  loaded=json.loads((d/'extension-load-manifest.json').read_text());check(loaded['backgroundExtensionLoaded']==(mode!='native') and loaded['sdkVersion']=='1.3.0','native baseline extension contamination')
  check(any(x['event']=={'type':'session_shutdown','reason':'quit'} for x in events),'no quit')
  requests=[x for x in http if x['event']=='request'];check(requests and all(x['authorizationIsLocalStub'] for x in requests),'not only local stub provider');check(not any(x['event']=='error' for x in http),'provider error')
  first_tool=next(x for x in http if x['event']=='response')['tool'];check(first_tool[0]=='mcp__parity__'+kind+('' if mode=='native' else '_bg'),'model did not issue correct native/proxy tool')
  calls=[x for x in wire if x['event']=='request' and x['message'].get('method')=='tools/call'];cancel=[x for x in wire if x['event']=='request' and x['message'].get('method')=='notifications/cancelled']
  check(len(calls)==len(cancel)==1,'call/cancel not exactly once')
  check(calls[0]['message']['params']=={'name':kind,'arguments':{'ms':1200},'_meta':{'progressToken':calls[0]['message']['id']}},'arguments rewritten or control leaked')
  check(cancel[0]['message']['params']['requestId']==calls[0]['message']['id'],'cancel targets wrong MCP request')
  cm=cancel[0]['message']['params']['reason']
  if cancel_message is None:cancel_message=cm
  check(cm==cancel_message,'native/background cancellation reasons differ')
  inner=original_event(events,kind);outcome={'result':inner['event']['result'],'isError':inner['event']['isError']}
  if expected is None:expected=outcome
  check(outcome==expected=={'result':{'content':[{'type':'text','text':'MCP request aborted'}],'details':{}},'isError':True},'native underlying cancellation result differs')
  starts=[x for x in wire if x['event']=='work_started'];finishes=[x for x in wire if x['event']=='work_finished'];stops=[x for x in wire if x['event']=='work_stopped'];check(len(starts)==1,'server replay')
  if kind=='cooperative':check(len(stops)==1 and not finishes and not (d/'server-work-finished.txt').exists(),'cooperative server did not stop')
  else:
   check(len(finishes)==1 and not stops and (d/'server-work-finished.txt').exists(),'noncooperative server did not finish')
   late=[x for x in wire if x['event']=='response' and x['message'].get('id')==calls[0]['message']['id']];check(len(late)==1 and inner['at']<late[0]['at'],'late response not after local cancellation settlement')
   check(late[0]['message']['result']['isError']==(kind=='late_error'),'wrong late response kind')
  check(all('NATIVE_MCP_TEST_SUCCESS' not in json.dumps(r['body']['messages']) and 'NATIVE_MCP_TEST_ERROR' not in json.dumps(r['body']['messages']) for r in requests),'late MCP result reached provider history')
  if mode=='native':
   check(summary['nativeEscape'] is True,'native not cancelled by actual Escape');check(not list(d.glob('tasks/*/*.meta.json')),'native baseline has bg tasks')
  else:
   check(inner['event'].get('parentToolCallId')==next(x for x in events if x['event']['type']=='tool_execution_end' and x['event']['toolName'].endswith('_bg'))['event']['toolCallId'],'not original nested tool dispatch')
   metas=list(d.glob('tasks/*/*.meta.json'));check(len(metas)==1,'duplicated background task');meta=json.loads(metas[0].read_text());check(meta['state']=='failed' and meta['isError'] is True and meta['cancelRequestedAt']<=meta['endedAt'] and meta['localRunning'] is False,'native final error was not preserved')
   stored=json.loads(next(d.glob('tasks/*/*.result.json')).read_text());check(stored==expected['result'],'saved native payload changed')
   check(meta in json.loads((d/'metadata-before-quit.json').read_text()).values(),'quit changed task metadata')
   if mode=='bg':
    cancels=[x for x in events if x['event']['type']=='tool_call' and x['event']['toolName']=='bg_task' and x['event']['input'].get('action')=='cancel'];check(len(cancels)==1 and not summary['nativeEscape'],'background cancel not model-issued bg_task')
    reads=[x for x in summary['tools'] if x['event']['toolName']=='bg_task' and x['event']['result'].get('structuredContent',{}).get('result_available') is True];check(len(reads)==1 and reads[0]['event']['result']['structuredContent']['result']=='MCP request aborted','background original error not readable')
   else:check(meta['delivery']=='foreground' and 'detachReason' not in meta and summary['nativeEscape'],'no mode detached')
  cases.append({'case':case,'nativeOriginalResult':outcome,'cancelReason':cm,'cancelAfterMcpStartMs':cancel[0]['at']-starts[0]['at'],'localSettlementAfterMcpStartMs':inner['at']-starts[0]['at'],'remoteAfterCancel':'stopped' if stops else 'late error' if kind=='late_error' else 'late success','providerRequests':len(requests),'wrapperAddsOutcomeUnknown':False})
 results.append({'fixture':kind,'nativeCancellationParity':'PASS','nativeUnderlyingResultParity':'PASS','nativeErrorSemantics':'PASS: no cancellation outcome inference','displayEnvelope':'task metadata retained','cases':cases})
(E/'verified-parity-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
