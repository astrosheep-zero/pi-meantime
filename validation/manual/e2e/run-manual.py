import os,sys,pty,fcntl,termios,struct,select,time,json,signal,subprocess,pathlib,shutil,re
ROOT=pathlib.Path(__file__).resolve().parent.parent;NODE=os.environ.get('PI_E2E_NODE') or shutil.which('node')
def rows(p):
 try:return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
 except (FileNotFoundError,json.JSONDecodeError):return []
def metas(d):
 try:return sorted([json.loads(x.read_text()) for x in d.glob('tasks/*/*.meta.json')],key=lambda x:x['createdAt'])
 except (FileNotFoundError,json.JSONDecodeError):return []
def run(case):
 d=ROOT/'evidence'/case;d.mkdir(parents=True,exist_ok=True)
 if (d/'host-events.jsonl').exists():raise RuntimeError('Existing case '+case)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,140,0,0))
 def preexec():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 p=subprocess.Popen([NODE,str(ROOT/'e2e/launch-case.mjs'),case,'--stdio'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,preexec_fn=preexec);os.close(slave)
 start=time.monotonic();sent=False;quit=False;failure=None;quitAt=0;step=0;last=0;aid=None;bid=None;steers=0;readAt=0;raw=b''
 def send(text):
  os.write(master,(text+'\r').encode())
  with (d/'driver-events.jsonl').open('a') as f:f.write(json.dumps({'at':int(time.time()*1000),'action':'input','text':text})+'\n')
 with (d/'tui.ansi').open('wb') as log:
  while p.poll() is None and time.monotonic()-start<22:
   if select.select([master],[],[],0.03)[0]:
    try:b=os.read(master,65536)
    except OSError:break
    if not b:break
    raw+=b;log.write(b);log.flush()
   ev=rows(d/'host-events.jsonl');mcp=rows(d/'mcp-server-events.jsonl');http=rows(d/'mock-http.jsonl');jobs=metas(d);begun=[x for x in mcp if x['event']=='work_started'];now=int(time.time()*1000)
   if not sent and time.monotonic()-start>1.5 and any(x['event']['type']=='session_start' for x in ev):send('START_MANUAL_CHECK');sent=True
   if jobs:aid=jobs[0]['id']
   handles=[x for x in ev if x['event']['type']=='tool_execution_end' and x['event'].get('toolName','').endswith('_bg')]
   if case.startswith('mcp_steer'):
    if begun and steers<3 and now>=begun[0]['at']+60+steers*70:steers+=1;send('STEER_REPEAT_'+str(steers))
    delivered=[x for x in ev if x['event']['type']=='message_end' and x['event'].get('message',{}).get('role')=='user' and 'STEER_REPEAT_' in str(x['event']['message'])]
    settled=any(x['event']['type']=='agent_settled' and jobs and x['at']>=jobs[0].get('endedAt',float('inf')) for x in ev) if begun else False
    if jobs and jobs[0].get('endedAt') and len(delivered)>=3 and settled and not quit:
     (d/'metadata-before-quit.json').write_text(json.dumps(jobs,indent=2));send('/quit');quit=True;quitAt=now
   elif case=='manual_foreign':
    if step==0 and handles:send('/e2e-new');step=1;last=now
    elif step==1 and any(x['event']['type']=='control_new_session' for x in ev):send('START_B');step=2;last=now
    elif step==2 and len(jobs)>=2 and len(handles)>=2:bid=jobs[-1]['id'];send('/bg cancel '+aid);step=3;last=now
    elif step==3 and now-last>180:send('/bg cancel '+bid);step=4;last=now
    elif step==4 and now-last>180:send('/bg cancel '+bid);step=5;last=now
    elif step==5 and now-last>350:send('READ_RESULT');step=6;readAt=now
   elif case=='manual_complete':
    if step==0 and jobs and jobs[0].get('endedAt') and handles:send('/bg cancel '+aid);step=1;last=now
    elif step==1 and now-last>150:send('/bg cancel '+aid);step=2;last=now
    elif step==2 and now-last>250:send('READ_RESULT');step=6;readAt=now
   else:
    if step==0 and handles:send('/bg status');step=-1;last=now
    elif step==-1 and now-last>150:send('/bg cancel');step=1;last=now
    elif step==1 and now-last>160:send('/bg cancel 00000000-0000-4000-8000-000000000000');step=2;last=now
    elif step==2 and now-last>160:send('/bg cancel '+aid);step=3;last=now
    elif step==3 and now-last>160:send('/bg cancel '+aid);step=4;last=now
    elif step==4 and now-last>300 and (case!='manual_cancel_stubborn' or any(x['event']=='work_finished' for x in mcp)):send('READ_RESULT');step=6;readAt=now
   if not case.startswith('mcp_steer') and step==6 and not quit and any(x['event']=='response' and x['at']>=readAt and x.get('text')=='CONTROL_TURN_DONE' for x in http) and any(x['event']['type']=='agent_settled' and x['at']>=readAt for x in ev):
    (d/'metadata-before-quit.json').write_text(json.dumps(jobs,indent=2));send('/quit');quit=True;quitAt=now
   if quit and now-quitAt>2500:break
  if not quit:failure='No observed final result/steer delivery and normal quit before deadline'
 try:p.wait(timeout=2)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=3)
 os.close(master)
 plain=re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)','',raw.decode('utf8','replace'));plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',plain);(d/'tui-stripped.txt').write_text(plain)
 mcp=rows(d/'mcp-server-events.jsonl');http=rows(d/'mock-http.jsonl');summary={'case':case,'processExit':p.returncode,'driverFailure':failure,'providerRequests':sum(x['event']=='request' for x in http),'mcpStarts':sum(x['event']=='work_started' for x in mcp),'mcpCancels':sum(x['event']=='cancel_received' for x in mcp),'mcpFinishes':sum(x['event']=='work_finished' for x in mcp),'mcpStops':sum(x['event']=='work_stopped' for x in mcp),'steers':steers,'aid':aid,'bid':bid};(d/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary),flush=True)
for c in sys.argv[1:]:run(c)
