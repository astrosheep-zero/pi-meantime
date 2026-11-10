# meantime card design spec — 2026-11-10 (lead, final)

Supersedes the earlier "typography addendum". Where it conflicts with the 20-item list, this wins.

## Input and count contract — review round 2

- Capture admitted non-shell business arguments once in `Snapshot.args` (JSON-safe copy, excluding the transport control). `args.code` is the code; no separate top-level code field. Persist the same args in the task index, and retain them in recovery, handle, partial wait, list, final wait and completion snapshots. Shell snapshots retain their original command.
- Both renderers read one display payload: shell command, otherwise args.code, otherwise every argument as `key: value` lines. Preserve multiline string values. Expanded non-shell drawers show the complete payload, including short single-line code/args.
- List results carry `total` and `remainingCount` (tasks after the returned page); the pagination cursor remains execution data, not display text. Hidden count = remainingCount + returned tasks not shown by the preview.
- Board loads every timeline page, folds oldest to newest and deduplicates by task id. Its total is the number of unique tasks in that complete inventory, never the number of timeline entries. Publish the inventory/count after all pages are known. Live updates merge into it; replacement/reconnect reloads it. `hasOlder` is only a transport pagination signal, never a UI count/fallback.
- Wait without ids carries `waitAll: true` and `pendingCount` from that observation: locally running or unresolved tasks. Include it in the first partial, subsequent partials, timeout/interrupted result and final/empty result. Do not infer it from total target rows or a later client inventory. Unknown historical/input-only waits omit the number.

## Paseo

### Tokens (one place, e.g. rows.ts; delete every other literal)
| token | family | size / line-height | weight | ink |
|---|---|---|---|---|
| `title` | MONO for commands/calls, SANS (no fontFamily) for prose headings | 13 / 18 | head token 600, rest 400 | head `primary`, rest `secondary` |
| `body` | MONO | 12 / 18 | 400 | output `secondary`, full command + error message `primary` |
| `meta` | MONO, tabular-nums | 11 / 16 | 400 | per use below |

Inks (theme-derived only — delete hex literals #9ca3ad #6b727b #cbd0d6 #a8aeb7 #5f666f #5e646d #565d66 #383d45):
- `primary` = colors.foreground
- `secondary` = secondaryColor(colors)
- `tertiary` = frameColor(colors)
- `hairline` = dividerColor(colors), 0.5px
- tone: ok/bad/run = toneColor; **neutral = `secondary`** (never colors.accent)

Removed: letterSpacing -0.2, weight 500, sizes 11.5 and 10, line-height 14/17.

### Spacing (4pt grid)
- Single card: radius 4 (unchanged), padding 8 vertical × 12 horizontal → collapsed height 34.
- Grouped card (list, board, wait/completion with >1 task): card paddingVertical 0, paddingHorizontal 12; every row (heading included) paddingVertical 8 (34 tall); 0.5 `hairline` between rows. No card stacks anywhere: `TaskTable` with >1 task renders one grouped card.
- Row: flexDirection row, alignItems center; gap 8 between pip | command | right cluster; gap 6 inside right cluster.
- Pip 6×6 (unchanged glow). Chevron 12, `tertiary`, both ChevronUp/Down.
- Drawer: hairline under the row, then paddingTop 8; blocks separated by 8: [full command] [output] [footer]. ScrollView maxHeight 240 compact / 360 wide (unchanged), wraps command+output only; footer outside the scroll.

### Row anatomy
`[pip] [command ……………… ellipsis] [state] [time] [chevron]`
- Command: `title` MONO, one line, tail ellipsis. Head = env assignments + first word (current regex). Multi-line payload: first line, then `meta tertiary` ` +N line(s)` as a separate non-shrinking Text right after it; singular `+1 line`, plural otherwise.
- Non-shell: source/tool name (600 primary) + first input line (400 secondary), using the admitted snapshot args; never the task id.
- State word (`meta`, tone ink), exactly:
  | state | word | ink |
  |---|---|---|
  | running | (none) | — |
  | completed, exit 0/absent | `✓` | ok |
  | failed / nonzero exit | `exit N` (or `failed` if no code) | bad |
  | waiting / queued / started | `waiting` / `queued` / `started` | run |
  | cancel_requested | `cancelling` | run |
  | cancelled | `cancelled` | secondary |
  | outcome_unknown, missing, unrecognized | `unknown` | secondary |
  | active row of a timed-out / interrupted wait | `timeout` (run) / `interrupted` (secondary) |
- Time (`meta secondary`, never bold, never tone-colored): `0:42`, `1:12`, `59:59`, `1h02m`. Wait outcome rows: `waited` in `tertiary` + value in `secondary`. Handle (started): no time.
- No id in any collapsed row.

### Drawer
- Full command/input block: `body primary`, original newlines, wrapped — shell command shown when it has a newline or is longer than 60 chars; non-shell code/args always shown in the expanded drawer.
- Output: `body secondary`; ℹ/✔/✖ marks keep current colors (ℹ `tertiary`).
- Cancellation caution (only cancel_requested): `meta`, run ink: `cancel requested; outcome not settled yet`.
- Footer: `meta tertiary`, one Text, separators ` · ` same ink:
  `mt_a1b2c3d4 · 12:24:48 → 12:26:00 · /path` (settled) / `mt_a1b2c3d4 · started 12:24:48 · /path` (active); append `recovered`, `error reported` as now.

### Cards
- **List / board**: grouped card. Header: bold `meantime` (MONO `title` 600 primary) + normal ` list` (MONO `title` 400 secondary), matching other tool call titles in both themes and both collapsed/expanded states; right cluster unchanged = summary pieces (`meta`, gap 6, no dots): `N active` run, `N ✓` ok, `N ✕` bad, `N other` secondary — non-zero only; chevron. Tap toggles the full list. Below the header, collapsed and expanded both show grouped task rows with their usual independent drawers. Collapsed preview = newest active tasks first, at most 3 (running/waiting/cancel_requested, also started/queued); if none are active, show the single most recently finished task by endedAt, falling back to createdAt. Expanded = all loaded tasks. Final `+N more` row is always visible when N > 0: `meta tertiary`, N = exact inventory/page remainder + loaded tasks beyond the current preview. No hasOlder-only wording or invented count.
  - Empty: single card, same `meantime list` title, then `no tasks` in `meta tertiary` below (8px gap), not pressable.
  - Board error: single card, bad pip + same `meantime list` title; below, hairline + `body secondary` error text.
  - Board hint `Ask the agent to cancel a task.` — last row, `meta tertiary`, only when active > 0.
- **Wait / completion, 1 task**: single card with the row. **>1 task**: grouped card, no heading row.
- **Wait-all**: one card: run pip, bold `meantime` (MONO title 600 primary) + normal ` wait all` (MONO title 400 secondary); right: `· N` (`meta secondary`, observed pendingCount only) · outcome word · `waited` value. If task snapshots are supplied, show them as divided rows beneath the heading in that same grouped card, preserving their output drawers. Unknown count is omitted; known empty count is 0.
- **Error**: single card: bad pip, call line `title` MONO (head 600 primary, rest secondary), right `failed` `meta` bad, no chevron; hairline, 8, message `body primary`.
- **Skeleton**: single card 34 tall: run pip, bar 6px tall, width 62% max 220, radius 2, `hairline` ink. No chevron.

## TUI (100 cols reference)

Row: `{glyph} {command}  {meta}` — meta all `dim`, pieces joined ` · `. No leading space before the glyph, anywhere.
- Glyphs: `✓` success · `✕` error (failed / nonzero exit) · `●` warning (running, waiting, queued, started, cancel_requested) · `⊘` dim (cancelled) · `?` dim (unknown).
- Meta order: [state word: `waiting` `queued` `started` `cancelling` `cancelled` `unknown` — none for running/completed/failed] [`exit N` only if nonzero] [duration `42s` / `1m12s` / `1h02m`] [`timeout · waited 1m12s` / `interrupted · waited 2s` on active rows of a timed-out wait].
- Command: first input line, source/head bold, truncated with `…` so the row fits the width; multi-line adds dim ` +N line(s)` (singular for 1). Non-shell args.code / argument lines use the same payload as Paseo.
- No id in collapsed rows.
- Collapsed single completion: row + last 2 nonblank output lines, indented 2.

Expanded block (completion, wait, list item, panel item):
```
✓ npm test -- --runInBand · 1m12s
  <full command/input, original newlines> ← shell if multi-line/truncated; non-shell always
  <output, last 40 lines>
  cancel requested; outcome not settled yet  ← warning, cancel_requested only
  mt_a1b2c3d4 · 12:24:48 → 12:26:00 · /fixture/output/test.log   ← dim footer
```
No `Output:` / `Command:` lines (path lives in the footer). One blank line between task blocks.

- List heading: bold `meantime` + normal ` list`, including empty/error variants, + dim ` · 3 active · 1 ✓ · 1 ✕ · 2 other` (non-zero only) + dim collapsed/expanded chevron. Collapsed preview uses the same newest-3-active / latest-1-finished rule as Paseo; expanded shows the full returned page. Final dim `+N more` combines the explicit remainingCount with returned tasks hidden by the preview.
- Wait-all: bold `meantime` + normal ` wait all · N` from the supplied observed pendingCount, followed by supplied task rows. Omit the number when unknown; display 0 for known empty.
- Handle: `● running in background (120s timeout)` — suffixes `(Ns timeout)` from config, `(manual detach)`, `(steered)`, explicit none; no id.
- Panel: title bold `meantime`; empty body muted `no tasks`; `→ ` selection marker and key-hint footer unchanged; items use the row format, expanded item uses the expanded block.
- Tool label: `meantime`. Paseo workspace/explorer panel title and command-center entry: `meantime list` (host-owned navigation typography). Status bar active count `bg 1/4` unchanged; notification failure text is `meantime: N notification(s) unsent`. Sentence-style system prompt/error prose is unchanged.
