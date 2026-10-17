"""Assert actual CLI process, localhost HTTP, session, and disk evidence together."""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / 'evidence' / 'restart' / (sys.argv[1] if len(sys.argv) > 1 else 'proof-01')


def load(name):
    return json.loads((DIR / name).read_text())


def rows(name):
    return [json.loads(line) for line in (DIR / name).read_text().splitlines() if line.strip()]


checks = []


def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})


summary = load('driver-summary.json')
host = rows('host-events.jsonl')
http = rows('mock-http.jsonl')
work = rows('tool-http.jsonl')
fixture = rows('fixture-events.jsonl')
loads = rows('actual-host-loads.jsonl')
driver = rows('driver-events.jsonl')
identity = load('session-identity.json')
before = load('disk-before-crash.json')
after = load('disk-after-normal-quit.json')
meta = {value['id']: value for name, value in before.items() if name.endswith('.meta.json')}
incomplete = next(value for value in meta.values() if value['localRunning'])
complete = next(value for value in meta.values() if value['state'] == 'completed')
ends = {row['event']['toolCallId']: row['event'] for row in host if row['phase'] == 'after' and row['event']['type'] == 'tool_execution_end'}
starts = [row for row in host if row['event']['type'] == 'session_start']
statuses = [ends['restart_after_' + str(n)]['result']['structuredContent']['task'] for n in [2, 6]]
result_unknown = ends['restart_after_3']['result']['structuredContent']
result_control = ends['restart_after_5']['result']['structuredContent']
cancel = ends['restart_after_4']
unknown_name = next(name for name, value in before.items() if name.endswith('.meta.json') and value['id'] == incomplete['id'])
result_name = next(name for name in before if name.endswith('.result.json'))

check('driver completed without failure', summary['failure'] is None)
check('first actual CLI exit was planned SIGKILL', summary['plannedCrashExit'] == -9 and any(row.get('signal') == 'SIGKILL' and 'Planned crash' in row['why'] for row in driver))
check('restarted actual CLI exited normally', summary['restartExit'] == 0)
check('two different actual Pi PIDs loaded production extension', len(loads) == 2 and len({row['pid'] for row in loads}) == 2)
check('both actual hosts loaded version 0.1.4 / official SDK 1.3.0', all(row['sourceVersion'] == '0.1.4' and row['sdkVersion'] == '1.3.0' for row in loads))
check('source hashes identical before/during/after both processes', all(row['sourceHashes'] == load('source-hashes-before-test.json') == summary['sourceHashesAfterTest'] for row in loads))
check('SDK CLI bytes identical between processes', len({row['sdkCliHash'] for row in loads}) == 1)
check('same session ID and file in both actual host session_start events', len(starts) == 2 and all(row['sessionId'] == identity['sessionId'] and row['sessionFile'] == identity['sessionFile'] for row in starts))
args = load('launch-after.json')['args']
check('restart used official --session with exact saved file', '--session' in args and args[args.index('--session') + 1] == identity['sessionFile'])
check('no graceful shutdown occurred before planned crash', not any(row['phase'] == 'before' and row['event']['type'] == 'session_shutdown' for row in host))
check('normal quit shutdown event present after recovery', any(row['phase'] == 'after' and row['event']['type'] == 'session_shutdown' and row['event']['reason'] == 'quit' for row in host))
check('unfinished task had a detached running durable record before crash', incomplete['state'] == 'running' and incomplete['localRunning'] is True and incomplete['delivery'] == 'background' and 'endedAt' not in incomplete)
check('completed control had completed durable metadata before crash', complete['state'] == 'completed' and complete['localRunning'] is False and complete['isError'] is False and 'endedAt' in complete)
check('list includes exactly both recovered task IDs', {task['id'] for task in ends['restart_after_1']['result']['structuredContent']['tasks']} == set(meta) and all(task['recovered'] for task in ends['restart_after_1']['result']['structuredContent']['tasks']))
check('unfinished status is recovered unknown, not locally running, before and after cancel rejection', all(task['id'] == incomplete['id'] and task['recovered'] is True and task['state'] == 'outcome_unknown' and task['localRunning'] is False for task in statuses))
check('unfinished result explicitly unavailable', result_unknown['task']['id'] == incomplete['id'] and result_unknown['result_available'] is False and 'result' not in result_unknown)
check('cancel of controller-less recovered task explicitly rejected', cancel['isError'] is True and 'Recovered task has no live local controller' in json.dumps(cancel['result']) and 'will not be replayed' in json.dumps(cancel['result']))
check('completed retained result still readable after restart', result_control['task']['id'] == complete['id'] and result_control['result_available'] is True and result_control['task']['state'] == 'completed' and result_control['result']['text'] == 'RESTART_CONTROL_RESULT_V014' and ends['restart_after_5']['isError'] is False)
check('unfinished canonical disk record was not rewritten to fake terminal state', before[unknown_name] == after[unknown_name])
check('completed retained result JSON survived crash and normal quit unchanged', before[result_name] == after[result_name])
hash_path = DIR / 'disk-before-crash-hashes.json'
if hash_path.exists():
    check('completed retained result bytes survived crash and normal quit unchanged', load('disk-before-crash-hashes.json')[result_name] == load('disk-after-normal-quit-hashes.json')[result_name])
check('no result file was invented for unfinished task', not any(incomplete['id'] in name and name.endswith('.result.json') for name in after))
check('exactly two HTTP business starts occurred, both before crash', len([row for row in work if row['event'] == 'work_started']) == 2 and all(row['phase'] == 'before' for row in work if row['event'] == 'work_started'))
check('HTTP incomplete work never reported finish', not any(row['event'] == 'work_finished' and row['kind'] == 'unfinished' for row in work))
check('no business fixture execute was replayed after restart', len([row for row in fixture if row['event'] == 'start']) == 2 and not any(row['phase'] == 'after' for row in fixture))
check('all provider requests authenticated only with synthetic localhost stub', all(row['authorizationIsLocalStub'] for row in http if row['event'] == 'request'))
check('no local mock error or unexpected provider retries', not any(row['event'] == 'error' for row in http) and len([row for row in http if row['event'] == 'request' and row['phase'] == 'before']) == 4 and len([row for row in http if row['event'] == 'request' and row['phase'] == 'after']) == 7)
check('resume provider calls are only read/cancel recovery probes', all(row.get('tool', ['bg_task'])[0] == 'bg_task' for row in http if row['event'] == 'response' and row['phase'] == 'after' and 'tool' in row))

if (DIR / 'status-screen.txt').exists():
    screen = (DIR / 'status-screen.txt').read_text()
    check('real PTY command requested recovered status panel before quit', any(row.get('text') == '/bg status' and row.get('phase') == 'after' for row in driver))
    check('visible latest-control panel shows both current-session tasks', screen.count('Latest background control:') == 1 and 'Current session tasks 1-2 of 2:' in screen)
    check('visible panel displays recovered unknown task on one readable line', f"{incomplete['id']} | fixture_restart | outcome_unknown | recovered" in screen)
    check('visible panel displays completed recovered task on one readable line', f"{complete['id']} | fixture_restart | completed | recovered" in screen)
    check('completed retained result is visibly readable in resumed terminal', 'RESTART_CONTROL_RESULT_V014' in screen)
    check('visible panel includes concrete cancel/result affordance and no warnings', 'Cancel: /bg cancel <id>; output: ask bg_task(action="result", id=...).' in screen and 'Active proxies: 1; warnings: 0.' in screen)

out = {'passed': sum(row['passed'] for row in checks), 'total': len(checks), 'allPassed': all(row['passed'] for row in checks),
       'sessionId': identity['sessionId'], 'unfinishedTaskId': incomplete['id'], 'completedTaskId': complete['id'],
       'plannedCrashExit': summary['plannedCrashExit'], 'restartExit': summary['restartExit'], 'checks': checks,
       'limits': ['Planned process SIGKILL with already-written snapshots, not a machine/power/storage failure test.',
                  'Loopback HTTP synthetic tools and provider only; this does not establish external service cancellation or rollback.',
                  'No original work replay is observed in this exact session-resume path.',
                  'Atomic rename is not a cross-process database or fsync durability claim.']}
(DIR / 'verification.json').write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps(out, indent=2))
sys.exit(0 if out['allPassed'] else 1)
