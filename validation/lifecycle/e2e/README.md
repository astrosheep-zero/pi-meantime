# Reproducible Pi 1.3.0 acceptance

Requirements: Node >=22.19 (validated with 24.19.0), npm, Python 3, local TCP and a real PTY. No tmux server, real provider, API key, or existing Pi login is needed. Run from a fresh source copy:

```sh
npm ci --ignore-scripts
bash e2e/run-all.sh
```

The lock pins the official SDK to 1.3.0. Set PI_E2E_NODE to an absolute Node path if Python cannot find the intended Node; also use the same Node in PATH for npm and compile tests. The suite refuses existing PTY logs. Archive the whole evidence directory before a repeat run.

Each case starts its own localhost HTTP mock and actual Pi CLI as children of one launcher. Pi gets an empty synthetic HOME/agent directory, --offline, no discovered user extensions/skills/context, and a literal localstubkey. The three fixture MCP servers use real JSON-RPC stdio and harmless delays/markers. All provider calls must have the fake key; headers and credentials are not retained. The mock text is not an acceptance assertion.

Assertions read actual host events, HTTP request bodies, MCP wire captures, and on-disk task metadata/results. The 15 original behavior gates are retained. The late-reload case now asserts recovery succeeds and terminal metadata remains intact after exit. An additional actual /new test verifies the old task is not accessible or notified in the new session. Runtime retention evidence is explicitly unit-level, not labeled TUI evidence.

`source-hashes-at-launch.json` records the production files loaded per case. Normal /quit is expected; a bounded emergency termination prevents a hung test from running indefinitely. `scripts/pi-smoke.mjs` emits the official session_shutdown lifecycle before dispose, so it closes MCP clients and naturally exits.

Safe evidence export: include host-events.jsonl, mock-http.jsonl, mcp-*.jsonl, summary.json, metadata-before-quit.json, source-hashes-at-launch.json, tasks/*.json, tui.ansi, and harmless markers. Do not export generated home/agent/session files, auth files, node_modules, caches, or unrelated local data. launch-command.txt and generated config files need not be shared. This repository contains only the harness, not an evidence ZIP.

This suite does not establish cross-process concurrent storage safety, crash durability, remote-provider billing, real remote MCP cancellation/elicitation, every schema family, or arbitrary tree/fork navigation.
