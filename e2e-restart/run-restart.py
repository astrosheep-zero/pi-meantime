"""Real Pi TUI crash/restart test. Only owned test child groups are signalled."""
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = os.environ.get('PI_E2E_NODE') or shutil.which('node')
if not NODE:
    raise RuntimeError('Node.js not found; set PI_E2E_NODE or add node to PATH')
RUN = sys.argv[1] if len(sys.argv) > 1 else 'proof-01'
if not RUN.replace('-', '').replace('_', '').isalnum():
    raise ValueError('Use a simple isolated run directory name')
DIR = ROOT / 'evidence' / 'restart' / RUN
DIR.mkdir(parents=True, exist_ok=False)
for folder in ['home', 'agent', 'sessions']:
    (DIR / folder).mkdir()


def dump(name, value):
    (DIR / name).write_text(json.dumps(value, indent=2) + '\n')


def append(value):
    with (DIR / 'driver-events.jsonl').open('a') as out:
        out.write(json.dumps({'at': int(time.time() * 1000), **value}) + '\n')


def rows(name):
    try:
        return [json.loads(line) for line in (DIR / name).read_text().splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def disk_snapshot(label):
    data = {str(p.relative_to(DIR)): json.loads(p.read_text()) for p in (DIR / 'tasks').glob('*/*.json')}
    dump('disk-' + label + '.json', data)
    dump('disk-' + label + '-hashes.json', {str(p.relative_to(DIR)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (DIR / 'tasks').glob('*/*.json')})
    return data


def source_hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [ROOT / 'index.mjs', ROOT / 'package.json', *sorted((ROOT / 'src').iterdir())] if p.is_file()}


def terminate_owned(process, why, sig=signal.SIGTERM):
    if process is not None and process.poll() is None:
        # Every managed process was started by this driver in its own session.
        if os.getpgid(process.pid) != process.pid:
            raise RuntimeError('Owned PID lost its expected dedicated process group')
        append({'action': 'signal_owned_process_group', 'pid': process.pid, 'signal': sig.name, 'why': why})
        os.killpg(process.pid, sig)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


def write_provider(phase, port):
    dump('agent/models.json', {'providers': {'localmock': {
        'baseUrl': f'http://127.0.0.1:{port}/{phase}/v1', 'api': 'openai-completions', 'apiKey': 'localstubkey',
        'models': [{'id': 'mock-model', 'name': 'Synthetic localhost restart test', 'reasoning': False, 'input': ['text'],
                    'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 128000, 'maxTokens': 4096}]
    }}})


def launch(phase, port, session_file=None):
    write_provider(phase, port)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 140, 0, 0))

    def preexec():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    env = {'PATH': str(pathlib.Path(NODE).parent) + ':/usr/bin:/bin', 'HOME': str(DIR / 'home'), 'TERM': 'xterm-256color',
           'LANG': 'C.UTF-8', 'PI_CODING_AGENT_DIR': str(DIR / 'agent'), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0',
           'PI_MEANTIME_CONFIG': str(DIR / 'bg-config.json'), 'E2E_CASE_DIR': str(DIR), 'E2E_SOURCE_ROOT': str(ROOT),
           'E2E_PHASE': phase, 'E2E_TOOL_URL': f'http://127.0.0.1:{port}/work', 'NO_PROXY': '127.0.0.1,localhost'}
    args = [NODE, str(ROOT / 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
            '--offline', '--no-extensions', '-e', str(ROOT / 'index.mjs'), '-e', str(ROOT / 'e2e-restart/observer.mjs'),
            '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--approve',
            '--provider', 'localmock', '--model', 'mock-model', '--thinking', 'off', '--session-dir', str(DIR / 'sessions'),
            '--system-prompt', 'Deterministic isolated test. Use only the synthetic localhost fixture and meantime. Never replay a recovered operation.']
    if session_file:
        if not pathlib.Path(session_file).resolve().is_relative_to(DIR):
            raise RuntimeError('Refusing a non-synthetic session')
        args += ['--session', session_file]
    dump('launch-' + phase + '.json', {'args': args, 'env': env, 'sourceHashesBeforeLaunch': source_hashes()})
    process = subprocess.Popen(args, cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=preexec)
    os.close(slave)
    append({'action': 'launch_owned_pi', 'phase': phase, 'pid': process.pid, 'sessionFileArgument': session_file})
    return process, master


def drive(process, master, phase):
    started = time.monotonic()
    sent = False
    quit_sent = False
    settled_at = None
    status_sent_at = None
    with (DIR / f'tui-{phase}.ansi').open('wb') as out:
        while process.poll() is None and time.monotonic() - started < 30:
            if select.select([master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                out.write(chunk)
                out.flush()
            events = [row for row in rows('host-events.jsonl') if row['phase'] == phase]
            http = [row for row in rows('mock-http.jsonl') if row.get('phase') == phase]
            if not sent and time.monotonic() - started > 1.5 and any(x['event']['type'] == 'session_start' for x in events):
                text = 'START_RESTART_TEST' if phase == 'before' else 'VERIFY_CRASH_RECOVERY_WITHOUT_REPLAY'
                os.write(master, (text + '\r').encode())
                append({'action': 'input', 'phase': phase, 'text': text})
                sent = True
            marker = 'READY_FOR_PLANNED_PROCESS_CRASH' if phase == 'before' else 'RESTART_PROBES_DONE'
            response = next((x for x in http if x['event'] == 'response' and x.get('text') == marker), None)
            if response and any(x['event']['type'] == 'agent_settled' and x['at'] >= response['at'] for x in events):
                if settled_at is None:
                    settled_at = time.monotonic()
                if time.monotonic() - settled_at < 0.5:
                    continue
                if phase == 'before':
                    before = disk_snapshot('before-crash')
                    metas = [value for name, value in before.items() if name.endswith('.meta.json')]
                    assert len(metas) == 2 and sum(x['state'] == 'completed' for x in metas) == 1
                    assert sum(x['state'] == 'running' and x['localRunning'] for x in metas) == 1
                    identity = next(x for x in events if x['event']['type'] == 'session_start')
                    session_file = pathlib.Path(identity['sessionFile'])
                    assert session_file.is_file() and session_file.resolve().is_relative_to(DIR)
                    shutil.copyfile(session_file, DIR / 'session-before-crash.jsonl')
                    dump('session-identity.json', {'sessionId': identity['sessionId'], 'sessionFile': str(session_file)})
                    terminate_owned(process, 'Planned crash after running task and completed control are persisted', signal.SIGKILL)
                    os.close(master)
                    return str(session_file)
                if not quit_sent:
                    if status_sent_at is None:
                        os.write(master, b'/bg status\r')
                        append({'action': 'input', 'phase': phase, 'text': '/bg status'})
                        status_sent_at = time.monotonic()
                        continue
                    if time.monotonic() - status_sent_at < 0.7:
                        continue
                    out.flush()
                    shutil.copyfile(DIR / f'tui-{phase}.ansi', DIR / 'tui-after-status.ansi')
                    append({'action': 'capture_visible_status', 'phase': phase, 'file': 'tui-after-status.ansi'})
                    disk_snapshot('after-probes-before-quit')
                    os.write(master, b'/quit\r')
                    append({'action': 'input', 'phase': phase, 'text': '/quit'})
                    quit_sent = True
        os.close(master)
    if phase == 'before':
        raise RuntimeError(f'Before-crash phase ended without a planned crash; exit={process.poll()}')
    if not quit_sent:
        raise RuntimeError('Restart phase did not finish all probes and normal /quit')
    process.wait(timeout=5)
    if process.returncode != 0:
        raise RuntimeError(f'Restarted Pi did not exit normally: {process.returncode}')


server = None
current = None
status = {'test': 'real-Pi-process-crash-and-official-session-resume', 'plannedCrashExit': None, 'restartExit': None, 'failure': None}
try:
    dump('source-hashes-before-test.json', source_hashes())
    dump('agent/settings.json', {'enableInstallTelemetry': False, 'enableAnalytics': False, 'quietStartup': True, 'defaultTools': ['fixture_restart', 'meantime']})
    dump('bg-config.json', {'include': ['fixture_*'], 'autoDetachMs': 0, 'reconcileMs': 100, 'notifyDebounceMs': 5000, 'shutdownGraceMs': 100, 'storageRoot': str(DIR / 'tasks')})
    server_env = {'PATH': str(pathlib.Path(NODE).parent) + ':/usr/bin:/bin', 'HOME': str(DIR / 'home')}
    server = subprocess.Popen([NODE, str(ROOT / 'e2e-restart/mock-http.mjs'), str(DIR)], cwd=ROOT, env=server_env,
                              stdout=(DIR / 'mock-stdout.txt').open('w'), stderr=(DIR / 'mock-stderr.txt').open('w'), start_new_session=True)
    append({'action': 'launch_owned_mock', 'pid': server.pid})
    deadline = time.monotonic() + 5
    while not (DIR / 'mock-port.txt').exists():
        if time.monotonic() > deadline or server.poll() is not None:
            raise RuntimeError('Local mock startup failed')
        time.sleep(0.02)
    port = int((DIR / 'mock-port.txt').read_text())
    current, master = launch('before', port)
    session_file = drive(current, master, 'before')
    status['plannedCrashExit'] = current.returncode
    disk_snapshot('after-crash-before-restart')
    current, master = launch('after', port, session_file)
    drive(current, master, 'after')
    status['restartExit'] = current.returncode
    disk_snapshot('after-normal-quit')
    shutil.copyfile(session_file, DIR / 'session-after-restart.jsonl')
except Exception as error:
    status['failure'] = repr(error)
    raise
finally:
    terminate_owned(current, 'Safety cleanup of this driver-owned Pi process only')
    terminate_owned(server, 'Safety cleanup of this driver-owned localhost mock only')
    status['sourceHashesAfterTest'] = source_hashes()
    dump('driver-summary.json', status)
    print(json.dumps({'evidence': str(DIR), **status}), flush=True)
