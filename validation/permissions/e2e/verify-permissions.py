import json, pathlib, hashlib, re, sys, os
ROOT = pathlib.Path(__file__).resolve().parent.parent
PRODUCTION = pathlib.Path(os.environ.get('PI_BG_PRODUCTION_ROOT', ROOT))
CASES = sys.argv[1:] or ['permission_final_yes_deny', 'permission_final_auto_deny', 'permission_final_yes_allow', 'permission_final_auto_allow']
def rows(path): return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
def plain(text):
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
results = []
for case in CASES:
    directory = ROOT / 'evidence' / case
    events = rows(directory / 'host-events.jsonl'); http = rows(directory / 'mock-http.jsonl'); wire = rows(directory / 'mcp-server-events.jsonl')
    driver = json.loads((directory / 'driver-summary.json').read_text())
    start = [row for row in events if row['event']['type']=='ui_prompt_start']
    end = [row for row in events if row['event']['type']=='ui_prompt_end']
    decision = [row for row in events if row['event']['type']=='permission_gate_decision']
    ended = [row for row in events if row['event']['type']=='tool_execution_end']
    proxy = [row for row in ended if row['event']['toolName']=='mcp__parity__cooperative_bg']
    native = [row for row in ended if row['event']['toolName']=='mcp__parity__cooperative']
    wire_calls = [row for row in wire if row['event']=='request' and row['message'].get('method')=='tools/call']
    work = [row for row in wire if row['event']=='work_started']
    pending = list(json.loads((directory / 'metadata-during-prompt.json').read_text()).values())
    final = list(json.loads((directory / 'metadata-before-quit.json').read_text()).values())
    prompt_events = json.loads((directory / 'events-during-prompt.json').read_text())
    prompt_http = json.loads((directory / 'http-during-prompt.json').read_text())
    prompt_text = plain((directory / 'prompt.ansi').read_text())
    choice_text = plain((directory / 'choice.ansi').read_text())
    result_text = plain((directory / 'result.ansi').read_text())
    hashes = json.loads((directory / 'source-hashes-at-launch.json').read_text())
    assert driver['exit']==0 and driver['driverFailure'] is None, driver
    assert all(row['mode']=='tui' for row in events)
    assert len(start)==len(end)==len(decision)==len(proxy)==len(native)==1
    assert end[0]['at']-start[0]['at']>=450, 'Prompt must outlast 100 ms auto detach threshold'
    assert len(pending)==1 and pending[0]['state']=='running' and pending[0]['delivery']=='foreground' and pending[0]['localRunning']
    assert not any(row['event']['type']=='tool_execution_end' for row in prompt_events), 'No tool may finalize during pending approval'
    assert sum(row['event']=='request' for row in prompt_http)==1, 'No subsequent model turn during pending approval'
    assert 'Permission: run local MCP fixture?' in prompt_text and 'Allow once' in prompt_text and 'Deny' in prompt_text
    assert 'execution continues independently' not in prompt_text and 'PERMISSION_DENIED_BY_USER' not in prompt_text
    assert len(final)==1 and not final[0]['localRunning']
    assert proxy[0]['at']>=decision[0]['at']>=start[0]['at']
    assert all(row['authorizationIsLocalStub'] for row in http if row['event']=='request')
    assert not any(row['event']=='error' for row in http)
    for name, expected in hashes.items():
        assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==expected, 'Validation source changed after launch: '+name
        assert hashlib.sha256((PRODUCTION/name).read_bytes()).hexdigest()==expected, 'Production source mismatch: '+name
    is_deny = case.endswith('_deny')
    if is_deny:
        if '_escape_' in case:
            assert decision[0]['event'].get('choice') is None and 'escape/ctrl+c cancel' in choice_text
        else:
            assert decision[0]['event']['choice']=='Deny' and '→ Deny' in choice_text
        assert len(wire_calls)==len(work)==0, 'Denied request must not reach MCP'
        assert proxy[0]['event']['isError'] is True and native[0]['event']['isError'] is True
        assert final[0]['state']=='failed' and final[0]['delivery']=='foreground' and final[0]['isError'] is True
        assert proxy[0]['event']['result']['structuredContent']['result_available'] is True
        assert 'PERMISSION_DENIED_BY_USER: fixture not executed.' in result_text
        assert 'execution continues independently' not in result_text
        assert not any(row['event']['type']=='message_end' and row['event'].get('message',{}).get('customType')=='bg-poc-completion' for row in events)
    else:
        assert decision[0]['event']['choice']=='Allow once'
        assert len(wire_calls)==len(work)==1 and work[0]['at']>=decision[0]['at']
        assert proxy[0]['event']['isError'] is False and native[0]['event']['isError'] is False
        assert proxy[0]['event']['result']['structuredContent']['result_available'] is False
        assert final[0]['state']=='completed' and final[0]['delivery']=='background' and final[0]['isError'] is False
        assert proxy[0]['at']<native[0]['at'], 'Background handle must precede business completion'
        assert 'execution continues independently' in result_text and '/bg status or /bg cancel' in result_text
        assert 'NATIVE_MCP_TEST_SUCCESS' in result_text and 'PERMISSION_DENIED_BY_USER' not in result_text
        fetched = [row for row in ended if row['event']['toolName']=='bg_task']
        assert len(fetched)==1 and fetched[0]['event']['isError'] is False
    result = {'case':case, 'pass':True, 'mode':'tui', 'cliExit':driver['exit'], 'promptDurationMs':end[0]['at']-start[0]['at'],
        'choice':decision[0]['event'].get('choice','dismissed_with_escape'), 'mcpToolsCallCount':len(wire_calls), 'pendingDelivery':pending[0]['delivery'],
        'finalState':final[0]['state'], 'finalDelivery':final[0]['delivery'], 'finalIsError':final[0]['isError'],
        'proxyEndAfterDecisionMs':proxy[0]['at']-decision[0]['at'],
        'sourceHashes':{'runtime':hashes['src/runtime.ts'], 'extension':hashes['src/extension.ts']}}
    results.append(result); print(json.dumps(result))
report = {'checks':results, 'passed':len(results), 'failed':0, 'actualPTYInput':True, 'sdkVersion':'1.3.0',
    'noCredentialsOrRemoteProvider':True,
    'uiObservations':['Native selector shows clear Allow once / Deny choices and keyboard help.',
        'Pending approval remains foreground past the automatic background deadline.',
        'Denied calls display failed and the exact denial reason; no successful detached handle appears.',
        'Allowed calls show a background handle with /bg status and /bg cancel instructions, then the completed result.',
        'This terminal theme emitted default/dim tool-result text, not red ANSI for the expected denial.',
        'Pending approval still occupies a runtime slot and the footer shows bg 1/4.',
        'Retained-result file paths wrap across lines at 140 columns.'],
    'limits':['PTY terminal evidence is captured as raw ANSI and readable text; no graphical desktop screenshot is claimed.',
        'Permission extension uses direct ctx.ui.select continuation, not arbitrary later asynchronous plugin decisions.',
        'Only local deterministic provider and MCP stdio fixtures are used.']}
(ROOT/'evidence/verified-permissions-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(f'REAL_CLI_PERMISSION_UI_PASS: {len(results)}/{len(CASES)} combinations; no early detach, no denied MCP execution, one execution per approval.')
