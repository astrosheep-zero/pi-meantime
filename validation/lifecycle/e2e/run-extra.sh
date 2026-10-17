#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p evidence
python3 e2e/verify-source.py
python3 e2e/run-extra-pty.py session_roundtrip_late session_roundtrip_early fork_late tree_late steer_repeat steer_no_repeat cancel_custom_early cancel_custom_boundary_1 cancel_custom_boundary_2 cancel_custom_late cancel_custom_error cancel_bash_early cancel_bash_boundary cancel_bash_late | tee evidence/extra-pty-run.log
python3 e2e/verify-extra.py | tee evidence/extra-verify.log
