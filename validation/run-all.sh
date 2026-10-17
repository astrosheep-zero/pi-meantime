#!/usr/bin/env bash
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$SOURCE/validation-runs"}
python3 "$SOURCE/validation/prepare.py" "$OUT"
OUT=$(cd "$OUT" && pwd)
export PI_BG_PRODUCTION_ROOT="$SOURCE"
(cd "$OUT/original" && bash e2e/run-all.sh)
(cd "$OUT/lifecycle" && bash e2e/run-extra.sh)
(cd "$OUT/cancel" && bash e2e/run-parity.sh)
(cd "$OUT/manual" && mkdir -p evidence && python3 e2e/run-manual.py manual_cancel_cooperative manual_cancel_stubborn manual_complete manual_foreign mcp_steer_auto mcp_steer_no | tee evidence/run-manual.log && python3 e2e/verify-manual.py | tee evidence/verify-manual.log)
(cd "$OUT/permissions" && python3 e2e/run-permissions.py permission_final_widget_yes_deny permission_final_widget_auto_deny permission_final_widget_yes_allow permission_final_widget_auto_allow permission_final_widget_yes_escape_deny permission_final_widget_auto_escape_deny && python3 e2e/verify-permissions.py permission_final_widget_yes_deny permission_final_widget_auto_deny permission_final_widget_yes_allow permission_final_widget_auto_allow permission_final_widget_yes_escape_deny permission_final_widget_auto_escape_deny)
(cd "$SOURCE" && node --experimental-strip-types scripts/sdk-cancel-permissions.mjs --evidence="$OUT/sdk-cancel-permissions")
echo "52 real PTY cases, official type/unit/smoke and SDK hook/permission checks completed. Crash/restart is separate: see e2e-restart/README.md."
