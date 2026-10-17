import os,sys,pty,fcntl,termios,struct,select,time,json,signal,subprocess,pathlib,shutil
ROOT=pathlib.Path(__file__).resolve().parent.parent;NODE=os.environ.get('PI_E2E_NODE') or shutil.which('node')
def rows(p):
 try:return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
 except (FileNotFoundError,json.JSONDecodeError):return []
def run(case):
 d=ROOT/'evidence'/case;d.mkdir(parents=True,exist_ok=True)
 if (d/'host-events.jsonl').exists():raise RuntimeError('Existing case '+case)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,140,0,0))
 def preexec():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 p=subprocess.Popen([NODE,str(ROOT/'e2e/launch-case.mjs'),case,'--stdio'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,preexec_fn=preexec);os.close(slave)
 start=time.monotonic();sent=False;aborted=False;probe=False;quit=False;failure=None;probeAt=0;quitAt=0
 def send(text,escape=False):
  os.write(master,b'\x1b' if escape else (text+'\r').encode())
  with (d/'driver-events.jsonl').open('a') as f:f.write(json.dumps({'at':int(time.time()*1000),'action':'escape' if escape else 'input','text':text})+'\n')
 with (d/'tui.ansi').open('wb') as log:
  while p.poll() is None and time.monotonic()-start<20:
   if select.select([master],[],[],0.03)[0]:
    try:b=os.read(master,65536)
    except OSError:break
    if not b:break
    log.write(b);log.flush()
   ev=rows(d/'host-events.jsonl');mcp=rows(d/'mcp-server-events.jsonl');http=rows(d/'mock-http.jsonl');begun=next((x for x in mcp if x['event']=='work_started'),None);now=int(time.time()*1000)
   if not sent and time.monotonic()-start>1.5 and any(x['event']['type']=='session_start' for x in ev):send('START_CANCEL_PARITY');sent=True
   if not case.startswith('bg_') and begun and not aborted and now>=begun['at']+200:send('NATIVE_ESCAPE_CANCEL',True);aborted=True
   if begun and not probe and now>=begun['at']+1700:send('VERIFY_POST_CANCEL_NO_LATE_RESULT');probe=True;probeAt=now
   if probe and not quit and any(x['event']=='response' and x['at']>=probeAt and x.get('text')=='PARITY_FOLLOWUP_OK' for x in http) and any(x['event']['type']=='agent_settled' and x['at']>=probeAt for x in ev):
    (d/'metadata-before-quit.json').write_text(json.dumps({str(x.relative_to(d)):json.loads(x.read_text()) for x in d.glob('tasks/*/*.meta.json')},indent=2));send('/quit');quit=True;quitAt=now
   if quit and now-quitAt>2500:break
  if not quit:failure='No observed post-cancel provider response / normal quit before deadline'
 try:p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=3)
 os.close(master)
 ev=rows(d/'host-events.jsonl');mcp=rows(d/'mcp-server-events.jsonl');http=rows(d/'mock-http.jsonl')
 summary={'case':case,'processExit':p.returncode,'driverFailure':failure,'nativeEscape':aborted,'mode':list(set(x['mode'] for x in ev)),'providerRequests':len([x for x in http if x['event']=='request']),'tools':[x for x in ev if x['event']['type']=='tool_execution_end'],'mcpStarts':len([x for x in mcp if x['event']=='work_started']),'mcpCancels':len([x for x in mcp if x['event']=='cancel_received']),'mcpFinishes':len([x for x in mcp if x['event']=='work_finished']),'mcpStops':len([x for x in mcp if x['event']=='work_stopped'])}
 (d/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k!='tools'}),flush=True)
for c in sys.argv[1:]:run(c)
