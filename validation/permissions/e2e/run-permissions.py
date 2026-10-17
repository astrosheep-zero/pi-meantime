import os, sys, pty, fcntl, termios, struct, select, time, json, signal, subprocess, pathlib, shutil, re
ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = os.environ.get('PI_E2E_NODE') or shutil.which('node')
def rows(path):
    try: return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except (FileNotFoundError, json.JSONDecodeError): return []
def metadata(directory):
    return {str(path.relative_to(directory)): json.loads(path.read_text()) for path in directory.glob('tasks/*/*.meta.json')}
def run(case):
    directory = ROOT / 'evidence' / case
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / 'host-events.jsonl').exists(): raise RuntimeError('Existing evidence: ' + case)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 140, 0, 0))
    def preexec(): os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    process = subprocess.Popen([NODE, str(ROOT / 'e2e/launch-case.mjs'), case, '--stdio'], cwd=ROOT,
        stdin=slave, stdout=slave, stderr=slave, preexec_fn=preexec)
    os.close(slave)
    start = time.monotonic(); sent = False; selected = False; arrow_at = None; chosen = False; quit_at = None; failure = None
    chunks = bytearray()
    def send(data, action):
        os.write(master, data)
        with (directory / 'driver-events.jsonl').open('a') as file:
            file.write(json.dumps({'at': int(time.time()*1000), 'action': action, 'bytesHex': data.hex()}) + '\n')
    with (directory / 'tui.ansi').open('wb') as ansi:
        while process.poll() is None and time.monotonic() - start < 20:
            if select.select([master], [], [], .03)[0]:
                try: data = os.read(master, 65536)
                except OSError: break
                if not data: break
                ansi.write(data); ansi.flush(); chunks.extend(data)
            events = rows(directory / 'host-events.jsonl'); http = rows(directory / 'mock-http.jsonl')
            now = int(time.time()*1000)
            if not sent and time.monotonic()-start > 1.3 and any(row['event']['type']=='session_start' for row in events):
                send(b'Run permission acceptance.\r', 'start'); sent = True
            prompts = [row for row in events if row['event']['type']=='ui_prompt_start']
            if prompts and not selected and now >= prompts[0]['at']+350:
                (directory / 'metadata-during-prompt.json').write_text(json.dumps(metadata(directory), indent=2))
                (directory / 'prompt.ansi').write_bytes(chunks)
                (directory / 'events-during-prompt.json').write_text(json.dumps(events, indent=2))
                (directory / 'http-during-prompt.json').write_text(json.dumps(http, indent=2))
                if case.endswith('_deny') and '_escape_' not in case: send(b'\x1b[B', 'select_deny_arrow_down')
                selected = True; arrow_at = now
            if selected and not chosen and now >= arrow_at+120:
                (directory / 'choice.ansi').write_bytes(chunks)
                if '_escape_' in case: send(b'\x1b', 'dismiss_permission_with_escape')
                else: send(b'\r', 'confirm_deny' if case.endswith('_deny') else 'confirm_allow')
                chosen = True
            expected = 'PERMISSION_DENIED_DONE' if case.endswith('_deny') else 'PERMISSION_ALLOW_DONE'
            complete = [row for row in http if row['event']=='response' and row.get('text')==expected]
            if complete and not quit_at and any(row['event']['type']=='agent_settled' and row['at']>=complete[-1]['at'] for row in events):
                quit_at = now+250
            if quit_at and now >= quit_at:
                (directory / 'metadata-before-quit.json').write_text(json.dumps(metadata(directory), indent=2))
                (directory / 'result.ansi').write_bytes(chunks)
                send(b'/quit\r', 'normal_quit'); quit_at = now+3000
            if any(row['event']['type']=='session_shutdown' for row in events): break
        else:
            if process.poll() is None: failure = 'PTY scenario deadline reached'
    try: process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        failure = failure or 'CLI did not exit after normal quit'; os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=3)
    os.close(master)
    plain = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', chunks.decode('utf8', errors='replace'))
    plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', plain)
    (directory / 'tui-readable.txt').write_text(plain)
    result = {'case':case, 'exit':process.returncode, 'driverFailure':failure, 'elapsed':round(time.monotonic()-start,2),
        'actualTerminalInput':True, 'rows':48, 'columns':140, 'chosen':chosen}
    (directory / 'driver-summary.json').write_text(json.dumps(result, indent=2)); print(json.dumps(result), flush=True)
for case in sys.argv[1:]: run(case)
