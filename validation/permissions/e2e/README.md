# Real terminal permission acceptance

This directory contains the permission-suite harness. Run the repository's
`validation/run-all.sh` to prepare an isolated source copy, or use
`validation/prepare.py` and run this suite from its generated workspace.
Each real Pi 1.3.0 CLI process records `source-hashes-at-launch.json`; the
verifier compares those hashes with the workspace and optional
`PI_BG_PRODUCTION_ROOT`. Generated cases and credentials are not committed.

The driver opens a real 48-row, 140-column PTY. It starts the official bundled
Pi CLI with an empty isolated HOME/agent directory, a local deterministic HTTP
provider, and a local MCP stdio server. No real credentials or provider are used.
The permission gate is registered after the background extension and uses the
official `tool_call` hook with `ctx.ui.select`. The driver sends real arrow keys,
Enter, or Escape; it does not replace the UI or inject permission events.

Example, using unused case names:

```sh
PI_E2E_NODE=/path/to/node python3 e2e/run-permissions.py \
  permission_final_widget_yes_deny permission_final_widget_auto_deny \
  permission_final_widget_yes_allow permission_final_widget_auto_allow \
  permission_final_widget_yes_escape_deny permission_final_widget_auto_escape_deny
python3 e2e/verify-permissions.py \
  permission_final_widget_yes_deny permission_final_widget_auto_deny \
  permission_final_widget_yes_allow permission_final_widget_auto_allow \
  permission_final_widget_yes_escape_deny permission_final_widget_auto_escape_deny
```

The driver refuses to overwrite prior cases. Each case contains full `tui.ansi`,
`prompt.ansi`, `choice.ansi`, `result.ansi`, readable text, exact keyboard input,
SDK host events, provider HTTP requests/responses, MCP wire requests/responses,
and task snapshots during the prompt and before normal quit.

The verifier asserts that the prompt stays open longer than the automatic
detach deadline without returning a handle or starting a second model request.
Denied/dismissed calls must return the native error directly and send zero MCP
`tools/call` requests. Allowed calls must execute once, detach only after the
choice, finish successfully, and be explicitly retrieved once.

Visual findings describe what the captured terminal actually rendered. Raw ANSI
is terminal evidence, not a claimed graphical desktop screenshot. The default
theme uses plain/dim text for these tool results; no red error styling is assumed.
The gate covers immediate Yes/No continuation, not arbitrary asynchronous plugin
decisions made after the prompt closes.
