"""Prepare isolated, reproducible PTY suite roots from this exact source tree."""
import pathlib, shutil, sys, json, hashlib
ROOT=pathlib.Path(__file__).resolve().parent.parent
OUT=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'validation-runs'
if OUT.exists():raise SystemExit('Refusing existing output; choose a new directory: '+str(OUT))
if not (ROOT/'node_modules/@earendil-works/pi-coding-agent/package.json').exists():raise SystemExit('Run npm ci --ignore-scripts first')
if json.loads((ROOT/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']!='1.3.0':raise SystemExit('Exact SDK 1.3.0 required')
for suite in ['original','lifecycle','cancel','manual','permissions']:
 d=OUT/suite;d.mkdir(parents=True)
 for name in ['index.mjs','package.json','package-lock.json','tsconfig.json']:shutil.copy2(ROOT/name,d/name)
 for name in ['src','test','scripts','examples']:shutil.copytree(ROOT/name,d/name,ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(ROOT/'e2e' if suite=='original' else ROOT/'validation'/suite/'e2e',d/'e2e',ignore=shutil.ignore_patterns('__pycache__'))
 (d/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
print(OUT)
