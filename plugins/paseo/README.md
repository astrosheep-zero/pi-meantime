# pi-meantime Paseo plugin

Paseo client plugin for [pi-meantime](../../README.md) background tasks. Pure client side: no server entry, no changes to the pi extension.

## What it does

- **Timeline task cards** — explicit `meantime list/wait/cancel` results, a running `meantime wait`, and `meantime-completion` notifications become compact task cards. A running wait is recognized from its input id, then the card resolves that id against the agent timeline so it shows the awaited command, not just `mt_xxxxxxxx`. Original tool invocations (`bash` and `<tool>_mt`) keep Paseo's native tool rows; the plugin does not replace those running calls with task cards.
- **Background tasks board** — an agent-context workspace panel (Command Center: "Open background tasks") folding the agent's timeline (tail page, 500 entries) into the latest snapshot per task id, live-updated via `timeline.subscribe`. Read-only; cancel by asking the agent (`meantime cancel <id>`). The board still reads handles, list/wait snapshots, and completion receipts.

Non-goals (v1): no cancel/control channel, no `setStatus`/`setWidget`/`custom()` equivalents — those Pi TUI surfaces are invisible over RPC by design; the timeline is the only source of truth.

## Display

Completion cards and the board use compact task rows with static status lamps. Press a row to open a detail sheet showing its command, retained output tail, timing and output path. States and elapsed durations are snapshots, not live liveness indicators: elapsed appears only when both start and end are known. Completion data comes from structured message metadata, not parsed receipt prose. No progress meter or client-side ticking is inferred.

## Develop

```bash
npm install
npm run typecheck
npm test
node scripts/render-a4.mjs      # actual RN-web component previews (headless)
paseo plugin reload pi-meantime   # after edits, if installed
```

Installed from this directory with `paseo plugin install <path>`. Manifest id: `pi-meantime`.
