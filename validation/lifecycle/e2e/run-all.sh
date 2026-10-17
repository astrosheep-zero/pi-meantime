#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p evidence
if find evidence -name host-events.jsonl -print -quit | grep -q .; then
  echo 'Existing PTY evidence found. Archive evidence/ before running a fresh suite.' >&2
  exit 1
fi
node --version | tee evidence/node-version.log
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version" | tee evidence/sdk-version.log
npm run check > evidence/check.log 2>&1
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
env -i PATH="$PATH" HOME="$home" PI_OFFLINE=1 LANG=C.UTF-8 npm run test:pi > evidence/sdk-smoke.log 2>&1
node --experimental-strip-types e2e/runtime-regressions.ts > evidence/runtime-regressions.log 2>&1
python3 e2e/run-pty.py bash_yes_repeat bash_auto mcp_yes mcp_auto codemode_mcp deferred_mcp custom_codemode custom_deferred bash_steer bash_shortcut bash_no search_deferred cancel_bash_repeat cancel_mcp_repeat reload_mcp reload_custom_repeat switch_custom | tee evidence/pty-run.log
node e2e/verify-evidence.mjs | tee evidence/verify.log
