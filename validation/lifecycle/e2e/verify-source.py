"""Verify the current 0.1.4 candidate production bytes before running extra TUI cases."""
import hashlib,json,os,pathlib,shutil,subprocess
ROOT=pathlib.Path(__file__).resolve().parent.parent
expected=json.loads((ROOT/'e2e/production-baseline.json').read_text())
actual={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in expected['productionSha256']}
if actual!=expected['productionSha256']:raise SystemExit('Production bytes differ from current 0.1.4 candidate; refusing this evidence label')
sdk=json.loads((ROOT/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']
if sdk!='1.3.0':raise SystemExit('This test requires official SDK 1.3.0')
node=os.environ.get('PI_E2E_NODE') or shutil.which('node')
node_version=subprocess.check_output([node,'--version'],text=True).strip()
out={**expected,'sdkVersion':sdk,'nodeVersion':node_version,'matchesDeliveredSource':True}
(ROOT/'evidence').mkdir(exist_ok=True)
(ROOT/'evidence/source-version-verification.json').write_text(json.dumps(out,indent=2))
print('Production bytes match current 0.1.4 candidate; official SDK '+sdk+'; Node '+node_version)
