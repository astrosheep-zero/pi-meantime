import os,sys,pty,fcntl,termios,struct,select,time,json,signal,subprocess,pathlib,shutil
ROOT=pathlib.Path(__file__).resolve().parent.parent
NODE=os.environ.get('PI_E2E_NODE') or shutil.which('node')
def rows(p):
 try:return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
 except (FileNotFoundError,json.JSONDecodeError):return []
def task(r):return (r or {}).get('structuredContent',{}).get('task') or (r or {}).get('details',{}).get('task') or (r or {}).get('details',{})
def run(case):
 d=ROOT/'evidence'/case;d.mkdir(parents=True,exist_ok=True)
 if (d/'host-events.jsonl').exists():raise RuntimeError('Refusing to overwrite case '+case)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,140,0,0))
 def preexec():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 p=subprocess.Popen([NODE,str(ROOT/'e2e/launch-case.mjs'),case,'--stdio'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,preexec_fn=preexec);os.close(slave)
 start=time.monotonic();ev=[];http=[];fixture=[];sent=False;quit_sent=False;quit_time=None;step=0;steers=0;last_send=0;failure=None;released=False
 def events(name):return [x for x in ev if x['event']['type']==name]
 def control(action,label=None):return [x for x in events('control_replaced') if x['event'].get('action')==action and (label is None or x['event'].get('label')==label)]
 def marked():return bool([x for x in events('control_mark') if x['event'].get('label')=='A'])
 def ended(name=None):return [x for x in events('tool_execution_end') if name is None or x['event']['toolName']==name]
 def read_results():return [x for x in ended('bg_task') if x['event']['result'].get('structuredContent',{}).get('result_available') is True]
 def bg_handle():return next((x for x in ended() if x['event']['toolName'] in ['fixture_direct_bg','bash'] and task(x['event']['result']).get('delivery')=='background'),None)
 def settled_after(at):return any(x['at']>=at for x in events('agent_settled'))
 def seed_done(n):
  x=[x for x in http if x['event']=='response' and x.get('text')=='SEED_SAVED'];return len(x)>=n and settled_after(x[n-1]['at'])
 def job_idle():
  h=bg_handle();return h is not None and settled_after(h['at'])
 def foreign_done():
  x=[x for x in ended('bg_task') if x['event'].get('isError')];return bool(x) and settled_after(x[-1]['at'])
 def foreign_list_done():
  x=[x for x in ended('bg_task') if x['event']['result'].get('structuredContent',{}).get('tasks')==[]];return bool(x) and settled_after(x[-1]['at'])
 def recovered_cancel_done():
  x=[x for x in ended('bg_task') if 'no live local controller' in json.dumps(x['event']['result'])];return bool(x) and settled_after(x[-1]['at'])
 def early_done():
  x=[x for x in ended('bg_task') if x['event']['result'].get('structuredContent',{}).get('result_available') is False];return bool(x) and settled_after(x[-1]['at'])
 def finished():return any(x['phase']=='finish' and x.get('gate')=='job' for x in fixture)
 def final_done():
  h=bg_handle();old_id=task(h['event']['result']).get('id') if h else None
  x=[x for x in read_results() if task(x['event']['result']).get('id')==old_id];return bool(x) and settled_after(x[-1]['at'])
 def own_done():
  h=bg_handle();old_id=task(h['event']['result']).get('id') if h else None
  x=[x for x in read_results() if task(x['event']['result']).get('id')!=old_id];return bool(x) and settled_after(x[-1]['at'])
 def send(text):
  nonlocal last_send
  os.write(master,(text+'\r').encode());last_send=time.monotonic();
  with (d/'driver-events.jsonl').open('a') as f:f.write(json.dumps({'at':int(time.time()*1000),'action':'pty_input','text':text})+'\n')
 def stop():
  nonlocal quit_sent,quit_time
  snapshots={str(f.relative_to(d)):json.loads(f.read_text()) for f in d.glob('tasks/*/*.meta.json')}
  (d/'metadata-before-quit.json').write_text(json.dumps(snapshots,indent=2));send('/quit');quit_sent=True;quit_time=time.monotonic()
 roundtrip=case.startswith('session_roundtrip_');early=case.endswith('early') and roundtrip;fork=case=='fork_late';tree=case=='tree_late'
 steps=[]
 if roundtrip or fork or tree:
  steps=[(lambda:bool(events('session_start')),'SEED_A'),(lambda:seed_done(1),'/e2e-mark A')]
  if roundtrip:
   steps += [(marked,'/e2e-new B'),(lambda:bool(control('new','B')),'SEED_B'),(lambda:seed_done(2),'/e2e-switch A'),(lambda:len(control('switch','A'))==1,'START_LONG_TASK')]
   steps += [(job_idle,'/e2e-switch B'),(lambda:bool(control('switch','B')),'CHECK_FOREIGN_ID'),(foreign_done,'CHECK_FOREIGN_LIST'),(foreign_list_done,'B_OWN_JOB')]
   if early:steps += [(own_done,'/e2e-switch A')]
   else:steps += [(own_done,'/e2e-release job'),(finished,'/e2e-switch A')]
   steps += [(lambda:len(control('switch','A'))==2,'READ_EARLY_ID' if early else 'READ_ORIGINAL_ID')]
   if early:steps += [(early_done,'CANCEL_RECOVERED_ID'),(recovered_cancel_done,'/e2e-release job'),(finished,'READ_ORIGINAL_ID')]
  elif fork:
   steps += [(marked,'START_LONG_TASK'),(job_idle,'/e2e-fork'),(lambda:bool(control('fork','F')),'CHECK_FOREIGN_ID'),(foreign_done,'/e2e-release job'),(finished,'/e2e-switch A'),(lambda:bool(control('switch','A')),'READ_ORIGINAL_ID')]
  else:
   steps += [(marked,'START_LONG_TASK'),(job_idle,'/e2e-tree'),(lambda:bool([x for x in events('control_return') if x['event'].get('action')=='tree']),'READ_EARLY_ID'),(early_done,'/e2e-release job'),(finished,'READ_ORIGINAL_ID')]
 with (d/'tui.ansi').open('wb') as log:
  while p.poll() is None and time.monotonic()-start<35:
   if select.select([master],[],[],0.03)[0]:
    try:b=os.read(master,65536)
    except OSError:break
    if not b:break
    log.write(b);log.flush()
   ev=rows(d/'host-events.jsonl');http=rows(d/'mock-http.jsonl');fixture=rows(d/'fixture-execution.jsonl')
   if quit_sent:
    if time.monotonic()-quit_time>3:break
    continue
   if time.monotonic()-start<1.5:continue
   if steps:
    if step<len(steps) and steps[step][0]() and time.monotonic()-last_send>0.08:send(steps[step][1]);step+=1
    elif step==len(steps) and final_done() and time.monotonic()-last_send>0.25:stop()
   else:
    if not sent and events('session_start'):send('START_LONG_TASK');sent=True
    if case.startswith('cancel_custom') and not released and (case=='cancel_custom_late' and bg_handle() or case in ['cancel_custom_early','cancel_custom_error'] and len(ended('bg_task'))>=2):
     send('/e2e-release job');released=True
    if case.startswith('steer_') and fixture and steers<3 and int(time.time()*1000)>=fixture[0]['at']+50*(steers+1):
     send('STEER_REPEAT_'+str(steers+1)+' keep the same job running');steers+=1
    if case=='steer_no_repeat':
     x=ended('fixture_direct_bg')
     if x and settled_after(x[-1]['at']) and time.monotonic()-last_send>0.3 and len([h for h in http if h['event']=='request'])>=2:stop()
    elif final_done() and time.monotonic()-last_send>0.3:stop()
  if not quit_sent:failure='did not satisfy final real-host result before 35s deadline'
 try:p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
 ev=rows(d/'host-events.jsonl');http=rows(d/'mock-http.jsonl');fixture=rows(d/'fixture-execution.jsonl')
 summary={'case':case,'elapsed_s':round(time.monotonic()-start,2),'processExit':p.returncode,'driverFailure':failure,'completedSteps':step,'expectedSteps':len(steps),'steersSent':steers,'mode':sorted(set(x.get('mode','') for x in ev if x.get('mode'))),'requestCount':sum(x['event']=='request' for x in http),'tools':[{'at':x['at'],'sessionId':x.get('sessionId'),'sessionFile':x.get('sessionFile'),'staleContext':x.get('staleContext',False),**x['event']} for x in ev if x['event']['type']=='tool_execution_end'],'completionMessages':[{'at':x['at'],'sessionId':x.get('sessionId'),'message':x['event']['message']} for x in ev if x['event']['type']=='message_end' and x['event'].get('message',{}).get('customType')=='bg-poc-completion'],'starts':[{'at':x['at'],'sessionId':x.get('sessionId'),'sessionFile':x.get('sessionFile'),'reason':x['event'].get('reason')} for x in ev if x['event']['type']=='session_start'],'fixtureRuns':fixture}
 (d/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['tools','fixtureRuns','completionMessages','starts']}),flush=True)
for case in sys.argv[1:]:run(case)
