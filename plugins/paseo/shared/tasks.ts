import { z } from "zod";

/**
 * Recognition and folding for pi-meantime background tasks on Paseo timelines.
 *
 * Data contract (owned by pi-meantime, not by Paseo):
 * - The `meantime` tool returns details with `tasks` (list), `task`
 *   (wait/cancel), or a bare snapshot with `id` (handle), plus optional
 *   `next_offset` pagination.
 * - Managed tools (and historical `<tool>_mt` proxies) return the task
 *   snapshot as details with `delivery: "background"` when detached.
 * - Completion messages carry structured snapshots in `details.tasks`
 *   (pi-meantime extension.ts). Paseo's pi provider preserves message
 *   details under `metadata.details`, so cards are built from that, never
 *   from parsing the receipt prose.
 * - Background `bash` returns the snapshot in details too, but Paseo's pi
 *   provider maps bash to a shell detail and drops details; the handle text
 *   ("Meantime mt_xxxxxxxx running in background; ...") is the only signal
 *   that survives. It is our own stable text, so matching it is fair game.
 *
 * Everything here is pure and runtime-neutral so node --test can cover it.
 */

/** pi-meantime task id shape (src/store.ts TASK_ID). */
export const TASK_ID = /^mt_[a-f0-9]{8}$/;
/** First line of the background handle text (pi-meantime src/extension.ts). */
const HANDLE_TEXT = /^Meantime (mt_[a-f0-9]{8}) running in background/;
/** Client display budget, including the omission line; never changes the retained result. */
export const OUTPUT_DISPLAY_MAX_CHARS = 32_000;
export function outputPreview(text: string): string {
  if (text.length <= OUTPUT_DISPLAY_MAX_CHARS) return text;
  const middle = "\n\n… Showing the beginning and end; the middle is hidden in this preview. …\n\n";
  const headChars = Math.floor((OUTPUT_DISPLAY_MAX_CHARS - middle.length) / 2);
  // Budget in UTF-16 units, but never cut an emoji's surrogate pair in half.
  const head = text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-(OUTPUT_DISPLAY_MAX_CHARS - middle.length - headChars)).replace(/^[\uDC00-\uDFFF]/, "");
  return head + middle + tail;
}
export const taskSummarySchema = z.object({
  id: z.string(),
  tool: z.string().optional(),
  state: z.string(),
  command: z.string().optional(),
  progress: z.string().optional(),
  outputTail: z.string().optional(),
  // Client-only projection of an existing wait/cancel result, never stored again.
  output: z.string().optional(),
  outputPath: z.string().optional(),
  exitCode: z.number().optional(),
  isError: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  recovered: z.boolean().optional(),
  notification: z.string().optional(),
  createdAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type TaskSummary = z.output<typeof taskSummarySchema>;

export const cardDataSchema = z.object({
  source: z.enum(["handle", "meantime", "completion"]),
  action: z.string().optional(),
  tasks: z.array(taskSummarySchema),
  total: z.number().optional(),
  moreOffset: z.number().optional(),
  /** A failed meantime call: the call line and one human sentence, never raw JSON. */
  call: z.string().optional(),
  error: z.string().optional(),
  pending: z.boolean().optional(),
});
export type MeantimeCardData = z.output<typeof cardDataSchema>;

/** Structural minimum of a Paseo tool_call timeline item. */
export interface ToolCallItemLike {
  type: "tool_call";
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: unknown;
  error?: unknown;
  metadata?: unknown;
}

export interface TimelineEntryLike {
  item: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Project a pi-meantime Snapshot into the JSON-safe card shape. */
export function simplifySnapshot(raw: unknown): TaskSummary | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== "string" || !TASK_ID.test(raw.id)) return undefined;
  if (typeof raw.tool !== "string" || typeof raw.state !== "string") return undefined;
  const command = text(raw.command);
  const progress = text(raw.progress);
  const output = text(raw.output);
  const outputPath = text(raw.outputPath);
  const rawTail = text(raw.outputTail);
  const outputTail = rawTail && rawTail.length >= 1024 && rawTail.includes("\n")
    ? rawTail.slice(rawTail.indexOf("\n") + 1).replace(/^\n+/, "") || rawTail
    : rawTail;
  const notification = raw.notification === "observed" || raw.notification === "delivered" ? raw.notification : undefined;
  return {
    id: raw.id,
    tool: raw.tool,
    state: raw.state,
    ...(command ? { command } : {}),
    ...(progress ? { progress } : {}),
    ...(output ? { output: outputPreview(output) } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(outputTail ? { outputTail } : {}),
    ...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}),
    ...(raw.isError === true ? { isError: true } : {}),
    ...(typeof raw.cancelRequestedAt === "number" ? { cancelRequested: true } : {}),
    ...(raw.recovered === true ? { recovered: true } : {}),
    ...(notification ? { notification } : {}),
    ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
  };
}

/** Unpack the result object preserved under a Paseo "unknown" tool detail. */
function unknownDetails(detail: Record<string, unknown>): Record<string, unknown> | undefined {
  if (detail.type !== "unknown") return undefined;
  const output = isRecord(detail.output) ? detail.output : undefined;
  return output && isRecord(output.details) ? output.details : undefined;
}

/** Receipt headers are separate content blocks; derive a bounded display without changing history. */
function projectOutputs(detail: Record<string, unknown>, tasks: TaskSummary[]): TaskSummary[] {
  const output = isRecord(detail.output) ? detail.output : undefined;
  if (!Array.isArray(output?.content)) return tasks;
  const blocks = output.content.flatMap(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []);
  if (isRecord(output.details) && Array.isArray(output.details.tasks) && blocks.at(-1)?.startsWith("Pending: ")) blocks.pop();
  const starts = tasks.map(task => blocks.findIndex(block => block.startsWith(`Meantime ${task.id} ${task.state}`)));
  return tasks.map((task, index) => {
    if (task.output !== undefined) return task;
    const start = starts[index]!;
    if (start < 0) return task;
    const end = starts.slice(index + 1).find(next => next > start) ?? blocks.length;
    const body = blocks.slice(start + 1, end);
    return body.length > 0 ? { ...task, output: outputPreview(body.join("\n")) } : task;
  });
}

/** First line of a tool error's text, whatever shape the host preserved. */
function errorSentence(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value
    : isRecord(value) && Array.isArray(value.content)
      ? value.content.flatMap(block => isRecord(block) && typeof block.text === "string" ? [block.text] : []).join("\n")
      : isRecord(value) && typeof value.message === "string" ? value.message : undefined;
  const line = raw?.split("\n").map(part => part.trim()).find(Boolean)?.replace(/^Error:\s*/, "");
  return line ? (line.length > 240 ? `${line.slice(0, 239)}…` : line) : undefined;
}

function meantimeCall(action: string | undefined, input: Record<string, unknown> | undefined): string {
  const ids = Array.isArray(input?.ids) ? input.ids.filter(id => typeof id === "string")
    : typeof input?.id === "string" ? [input.id] : [];
  return ["meantime", action, ...ids].filter(Boolean).join(" ");
}

/**
 * Recognize a tool_call timeline item as meantime-related. Returns undefined
 * to leave the entry on Paseo's native renderer.
 */
export function recognizeToolCall(item: ToolCallItemLike): MeantimeCardData | undefined {
  const { name, detail } = item;
  if (!isRecord(detail)) return undefined;

  if (name === "meantime") {
    const input = isRecord(detail.input) ? detail.input : undefined;
    const action = input ? text(input.action) : undefined;
    // Running waits have no final result yet, but the tool publishes partial
    // details as it observes: real ids, tools and commands beat bare ids.
    if (item.status === "running") {
      if (action !== "wait") return undefined;
      const details = unknownDetails(detail);
      const raws = details === undefined ? []
        : Array.isArray(details.tasks) ? details.tasks
        : details.task !== undefined ? [details.task]
        : [];
      // A wait only observes; nothing it reports has finished.
      const observed = raws.map(simplifySnapshot)
        .filter((task): task is TaskSummary => task !== undefined)
        .map(task => ({ ...task, state: "waiting" }));
      if (details !== undefined) return { source: "meantime", action, tasks: observed };
      // No partial snapshot yet. Current calls use ids (including prefixes);
      // keep id for historical timelines. No ids means wait-all, not an
      // inferred set of tasks from a later client-side snapshot.
      const ids = input?.ids ?? (input?.id !== undefined ? [input.id] : undefined);
      if (ids === undefined) return { source: "meantime", action, tasks: [] };
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 32
        || !ids.every(id => typeof id === "string" && /^(?:mt_)?[a-f0-9]{1,8}$/.test(id))) return undefined;
      return { source: "meantime", action, tasks: [], pending: true };
    }
    const output = isRecord(detail.output) ? detail.output : undefined;
    if (item.status === "failed" || output?.isError === true) {
      const error = errorSentence(item.error) ?? errorSentence(detail.output) ?? "meantime call failed";
      return { source: "meantime", ...(action ? { action } : {}), tasks: [], call: meantimeCall(action, input), error };
    }
    const details = unknownDetails(detail);
    if (!details) return undefined;
    const raws = Array.isArray(details.tasks) ? details.tasks
      : details.task !== undefined ? [details.task]
      : typeof details.id === "string" ? [details]
      : undefined;
    if (!raws) return undefined;
    const pending = Array.isArray(details.pending) ? details.pending : [];
    const snapshots = [...raws, ...pending].map(simplifySnapshot).filter((task): task is TaskSummary => task !== undefined);
    const tasks = action === "wait" || action === "cancel" ? projectOutputs(detail, snapshots) : snapshots;
    if (tasks.length === 0) {
      // An empty list is still an answer. Paseo drops unrecognized rows to a
      // raw tool line, so a completed empty list must become a card instead.
      return action === "list" && Array.isArray(details.tasks)
        ? { source: "meantime", action: "list", tasks: [] }
        : undefined;
    }
    const total = typeof details.total === "number" ? details.total : undefined;
    const moreOffset = typeof details.next_offset === "number" ? details.next_offset : undefined;
    return { source: "meantime", ...(action ? { action } : {}), tasks, ...(total !== undefined ? { total } : {}), ...(moreOffset !== undefined ? { moreOffset } : {}) };
  }

  // Managed tools now retain their original names; old _mt rows still work.
  const handle = unknownDetails(detail);
  if (handle?.delivery === "background") {
    const task = simplifySnapshot(handle);
    return task ? { source: "handle", tasks: [task] } : undefined;
  }

  if (name === "bash" && detail.type === "shell" && typeof detail.output === "string") {
    const match = HANDLE_TEXT.exec(detail.output);
    if (!match) return undefined;
    // A handle only proves the task STARTED. Reporting "running" here would
    // stay on the timeline as a lie after the task finishes; terminal state
    // arrives via the meantime-completion message or wait/list snapshots.
    return {
      source: "handle",
      tasks: [{
        id: match[1]!,
        tool: "bash",
        state: "started",
        ...(text(detail.command) ? { command: detail.command as string } : {}),
      }],
    };
  }

  if (name === "meantime-completion" && detail.type === "plain_text") {
    // Paseo's pi provider turns the custom completion message into a
    // plain_text tool row but preserves message details under
    // metadata.details. pi-meantime puts full snapshots in details.tasks;
    // the prose receipt is for the model, never parsed here.
    const metadata = isRecord(item.metadata) ? item.metadata : undefined;
    const details = metadata && isRecord(metadata.details) ? metadata.details : undefined;
    const raws = details && Array.isArray(details.tasks) ? details.tasks : undefined;
    if (!raws) return undefined;
    const tasks = raws.map(simplifySnapshot).filter((task): task is TaskSummary => task !== undefined);
    if (tasks.length === 0) return undefined;
    return { source: "completion", tasks };
  }

  return undefined;
}

/**
 * Timeline transformer gate. Original tool invocations keep their native rows;
 * explicit meantime queries and completion notifications become cards. Board
 * folding still uses recognizeToolCall so handles/list/wait snapshots retain
 * task context.
 */
export function recognizeTimelineToolCall(item: ToolCallItemLike): MeantimeCardData | undefined {
  const data = recognizeToolCall(item);
  return data?.source === "completion" || data?.source === "meantime" ? data : undefined;
}

/** Used by the board's folding, not as a fallback data source for cards. */
export function resolveWaitTask(task: TaskSummary, known: ReadonlyMap<string, TaskSummary>): TaskSummary {
  const prefix = task.id.startsWith("mt_") ? task.id : `mt_${task.id}`;
  const matches = [...known.values()].filter(candidate => candidate.id.startsWith(prefix));
  const found = known.get(task.id) ?? (matches.length === 1 ? matches[0] : undefined);
  return found ? { ...task, id: found.id, command: task.command ?? found.command, tool: task.tool ?? found.tool } : task;
}

const ACTIVE_STATES = new Set(["running", "cancel_requested", "started", "waiting"]);

export function isActiveTask(task: Pick<TaskSummary, "state">): boolean {
  return ACTIVE_STATES.has(task.state);
}

export function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) =>
    Number(isActiveTask(b)) - Number(isActiveTask(a)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Fold one timeline item into the task map (latest mention wins). Returns
 * true when the map changed. Entries arrive in seq order, so a plain
 * handle later overwritten by a wait/list snapshot converges correctly.
 */
export function foldItem(byId: Map<string, TaskSummary>, item: unknown): boolean {
  if (!isRecord(item) || item.type !== "tool_call") return false;
  const data = recognizeToolCall(item as unknown as ToolCallItemLike);
  if (!data) return false;
  // Merge, don't replace: older completion messages predate details.tasks
  // and would otherwise erase the command/createdAt the handle provided.
  for (const task of data.tasks) {
    // A wait call is observing a task, not changing its execution state.
    if (task.state !== "waiting") byId.set(task.id, { ...byId.get(task.id), ...task });
  }
  return true;
}

export function foldTimeline(entries: readonly TimelineEntryLike[]): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  for (const entry of entries) foldItem(byId, entry.item);
  return sortTasks([...byId.values()]);
}

/** Whole seconds a task ran; live for active tasks when `now` is supplied. */
export function elapsedSeconds(task: TaskSummary, now?: number): number | undefined {
  if (task.createdAt === undefined) return undefined;
  const end = task.endedAt ?? now;
  if (end === undefined) return undefined;
  return Math.max(0, Math.floor((end - task.createdAt) / 1000));
}
