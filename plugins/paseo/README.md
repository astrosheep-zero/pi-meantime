# pi-meantime Paseo plugin

Paseo client plugin for [pi-meantime](../../README.md) background tasks. Pure client side: no server entry, no changes to the pi extension.

## What it does

- **Timeline task cards** — explicit `meantime list/wait/cancel` results, a running `meantime wait`, and `meantime-completion` notifications become compact task cards. A running wait is recognized from its `ids` input (single, batch, or short prefixes); unique ids are resolved against the agent timeline so the card shows the awaited command. An omitted `ids` shows “All pending tasks” without guessing the target set. Historical `id` inputs remain readable. Identity resolution scans the latest 500 timeline entries; missing or ambiguous prefixes remain as supplied. Original tool invocations (`bash`, managed tools under their original names, and historical `<tool>_mt` rows) keep Paseo's native tool rows; the plugin does not replace those running calls with task cards.
- **Background tasks board** — an agent-context workspace panel (Command Center: "Open background tasks") folding the agent's timeline (tail page, 500 entries) into the latest snapshot per task id, live-updated via `timeline.subscribe`. Read-only; cancel by asking the agent (`meantime cancel <id>`). The board still reads handles, list/wait snapshots, and completion receipts.

Non-goals (v1): no cancel/control channel, no `setStatus`/`setWidget`/`custom()` equivalents — those Pi TUI surfaces are invisible over RPC by design; the timeline is the only source of truth.

## Display

Completion cards and the board use compact task rows with breathing live dots and steady parked/terminal marks. Press a row to expand a bounded, scrollable inline drawer showing its command, output, timing and output path. Wait/cancel output is projected from existing tool-result content, not persisted again. Display text is capped at 32,000 UTF-16 units (omission line included), keeping the head and tail without splitting surrogate pairs; the original result and history are unchanged; completion-only snapshots retain their output tail. Upstream wait-budget omission notices remain visible. States and elapsed durations are snapshots, not live liveness indicators: elapsed appears only when both start and end are known. Completion data comes from structured message metadata, not parsed receipt prose. No progress meter or client-side ticking is inferred.

## Develop

```bash
npm install
npm run typecheck
npm test
node scripts/render-a4.mjs      # actual RN-web component previews (headless)
paseo plugin reload pi-meantime   # after edits, if installed
```

Installed from this directory with `paseo plugin install <path>`. Manifest id: `pi-meantime`.
