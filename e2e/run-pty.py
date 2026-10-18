import os,sys,pty,fcntl,termios,struct,select,time,json,signal,subprocess,pathlib,shutil
ROOT=pathlib.Path(__file__).resolve().parent.parent
NODE=os.environ.get('PI_E2E_NODE') or shutil.which('node')
if not NODE:raise RuntimeError('Node.js not found')
def rows(p):
 try:return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
 except (FileNotFoundError,json.JSONDecodeError):return []
def run(case):
 d=ROOT/'evidence'/case;d.mkdir(parents=True,exist_ok=True)
 if (d/'host-events.jsonl').exists():raise RuntimeError('Existing evidence, choose new case or archive it: '+case)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,140,0,0))
 def preexec():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 p=subprocess.Popen([NODE,str(ROOT/'e2e/launch-case.mjs'),case,'--stdio'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,preexec_fn=preexec);os.close(slave)
 start=time.monotonic();sent=False;done=False;quit_at=None;reload_sent=False;inspect_at=None;inspect_sent=False;interrupt_sent=False
 with (d/'tui.ansi').open('wb') as log:
  while p.poll() is None and time.monotonic()-start<20:
   if select.select([master],[],[],0.05)[0]:
    try:b=os.read(master,65536)
    except OSError:break
    if not b:break
    log.write(b);log.flush()
   ev=rows(d/'host-events.jsonl');req=rows(d/'mock-http.jsonl')
   if not sent and time.monotonic()-start>2 and any(x['event']['type']=='session_start' for x in ev):
    os.write(master,('Run deterministic case '+case+'.\r').encode());sent=True
   if sent and not interrupt_sent and case in ['bash_steer','bash_shortcut','bash_no'] and any(x['event']['type']=='tool_execution_start' and x['event']['toolName']=='bash' for x in ev):
    if case=='bash_steer':os.write(master,b'Please keep the job running while accepting this steering message.\r')
    else:os.write(master,b'\x1b[98;6u')
    interrupt_sent=True
      # Completion is identified from real host events, not the test model's success words alone.
   completed=any(x['event']['type']=='tool_execution_end' and x['event']['toolName']=='meantime' and 'result' in json.dumps(x['event'].get('result',{})).lower() for x in ev)
   requests=sum(x['event']=='request' for x in req)
   if case=='bash_no' and requests>=2 and not quit_at:quit_at=time.monotonic()+0.5
   if (case.startswith('reload_') or case=='switch_custom') and not reload_sent and requests>=2 and any(x['event']['type']=='agent_settled' for x in ev):
    os.write(master,b'/new\r' if case=='switch_custom' else b'/reload\r');reload_sent=True;quit_at=time.monotonic()+8;inspect_at=time.monotonic()+6
    (d/'lifecycle-command.json').write_text(json.dumps({'at':int(time.time()*1000),'command':'/new' if case=='switch_custom' else '/reload','afterObservedAgentSettled':True}))
   elif case.startswith('cancel_') and requests>=3 and not quit_at:
    quit_at=time.monotonic()+6
   elif not case.startswith('reload_') and case!='switch_custom' and not case.startswith('cancel_') and completed and requests>=4 and not quit_at:
    quit_at=time.monotonic()+0.5
   if (case.startswith('reload_custom') or case=='switch_custom') and inspect_at and not inspect_sent and time.monotonic()>inspect_at:
    if case=='switch_custom':
     import re
     ids=re.findall(r'bg_[a-f0-9-]{36}',json.dumps(ev));old_id=ids[0] if ids else 'missing-id'
     os.write(master,('Inspect the old session task '+old_id+'; it must not belong to this session.\r').encode())
    else:os.write(master,b'Inspect the previous task result after reload.\r')
    inspect_sent=True
   if quit_at and time.monotonic()>quit_at:
    snap={str(p.relative_to(d)):json.loads(p.read_text()) for p in d.glob('tasks/*/*.meta.json')};(d/'metadata-before-quit.json').write_text(json.dumps(snap,indent=2))
    os.write(master,b'/quit\r');done=True;quit_at=None
   if done and time.monotonic()-start>15:break
 try:p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
 ev=rows(d/'host-events.jsonl');req=rows(d/'mock-http.jsonl')
 summary={'case':case,'elapsed_s':round(time.monotonic()-start,2),'processExit':p.returncode,'mode':sorted(set(x.get('mode','') for x in ev)),'requestCount':sum(x['event']=='request' for x in req),'tools':[{'at':x['at'],'name':x['event']['toolName'],'parent':x['event'].get('parentToolCallId'),'isError':x['event'].get('isError'),'durationMs':x['event'].get('durationMs'),'result':x['event'].get('result')} for x in ev if x['event']['type']=='tool_execution_end'],'completionMessages':sum(x['event']['type']=='message_end' and x['event'].get('message',{}).get('customType')=='meantime-completion' for x in ev),'shutdowns':sum(x['event']['type']=='session_shutdown' for x in ev)}
 (d/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k!='tools'}),flush=True)
for case in sys.argv[1:]:run(case)
