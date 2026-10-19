# pi-meantime Paseo plugin

Paseo client plugin for [pi-meantime](../../README.md) background tasks. Pure client side: no server entry, no changes to the pi extension.

## What it does

- **Timeline cards** — `addTimelineTransformer` recognizes meantime-related `tool_call` entries and renders them as compact task cards (state, elapsed, command):
  - `meantime` tool results (`list` / `wait` / `cancel`): task snapshots survive RPC under the `unknown` detail's `output.details`.
  - `<tool>_mt` proxies: background handles via `output.details.delivery === "background"`.
  - Background `bash`: Paseo's pi provider maps bash to a shell detail and drops `details`, so the card is recovered from the extension's stable handle text (`Meantime mt_xxxxxxxx running in background; ...`).
- **Background tasks board** — an agent-context workspace panel (Command Center: "Open background tasks") folding the agent's timeline (tail page, 500 entries) into the latest snapshot per task id, live-updated via `timeline.subscribe`. Read-only; cancel by asking the agent (`meantime cancel <id>`).

Non-goals (v1): no cancel/control channel, no `setStatus`/`setWidget`/`custom()` equivalents — those Pi TUI surfaces are invisible over RPC by design; the timeline is the only source of truth.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin reload pi-meantime   # after edits, if installed
```

Installed from this directory with `paseo plugin install <path>`. Manifest id: `pi-meantime`.
