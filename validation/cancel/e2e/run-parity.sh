#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p evidence
python3 e2e/run-parity.py native_cooperative bg_cooperative native_stubborn bg_stubborn native_late_error bg_late_error no_cooperative no_stubborn no_late_error | tee evidence/pty-run.log
python3 e2e/verify-parity.py | tee evidence/verify-parity.log
