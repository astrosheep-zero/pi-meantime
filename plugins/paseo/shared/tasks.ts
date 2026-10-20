import { z } from "zod";

/**
 * Recognition and folding for pi-meantime background tasks on Paseo timelines.
 *
 * Data contract (owned by pi-meantime, not by Paseo):
 * - The `meantime` tool returns details with `tasks` (list), `task`
 *   (wait/cancel), or a bare snapshot with `id` (handle), plus optional
 *   `next_offset` pagination.
 * - `<tool>_mt` proxies return the task snapshot as details with
 *   `delivery: "background"` when detached.
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
export const taskSummarySchema = z.object({
  id: z.string(),
  tool: z.string().optional(),
  state: z.string(),
  command: z.string().optional(),
  progress: z.string().optional(),
  outputTail: z.string().optional(),
  outputPath: z.string().optional(),
  exitCode: z.number().optional(),
  isError: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  recovered: z.boolean().optional(),
  createdAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type TaskSummary = z.output<typeof taskSummarySchema>;

export const cardDataSchema = z.object({
  source: z.enum(["handle", "meantime", "completion"]),
  action: z.string().optional(),
  tasks: z.array(taskSummarySchema),
  moreOffset: z.number().optional(),
  phase: z.enum(["streaming", "complete"]),
});
export type MeantimeCardData = z.output<typeof cardDataSchema>;

/** Structural minimum of a Paseo tool_call timeline item. */
export interface ToolCallItemLike {
  type: "tool_call";
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: unknown;
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
  const outputPath = text(raw.outputPath);
  const outputTail = text(raw.outputTail);
  return {
    id: raw.id,
    tool: raw.tool,
    state: raw.state,
    ...(command ? { command } : {}),
    ...(progress ? { progress } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(outputTail ? { outputTail } : {}),
    ...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}),
    ...(raw.isError === true ? { isError: true } : {}),
    ...(typeof raw.cancelRequestedAt === "number" ? { cancelRequested: true } : {}),
    ...(raw.recovered === true ? { recovered: true } : {}),
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

/**
 * Recognize a tool_call timeline item as meantime-related. Returns undefined
 * to leave the entry on Paseo's native renderer.
 */
export function recognizeToolCall(item: ToolCallItemLike): Omit<MeantimeCardData, "phase"> | undefined {
  const { name, detail } = item;
  if (!isRecord(detail)) return undefined;

  if (name === "meantime") {
    const details = unknownDetails(detail);
    if (!details) return undefined;
    const raws = Array.isArray(details.tasks) ? details.tasks
      : details.task !== undefined ? [details.task]
      : typeof details.id === "string" ? [details]
      : undefined;
    if (!raws) return undefined;
    const tasks = raws.map(simplifySnapshot).filter((task): task is TaskSummary => task !== undefined);
    if (tasks.length === 0) return undefined;
    const action = isRecord(detail.input) ? text(detail.input.action) : undefined;
    const moreOffset = typeof details.next_offset === "number" ? details.next_offset : undefined;
    return { source: "meantime", ...(action ? { action } : {}), tasks, ...(moreOffset !== undefined ? { moreOffset } : {}) };
  }

  if (name.endsWith("_mt")) {
    const details = unknownDetails(detail);
    if (!details || details.delivery !== "background") return undefined;
    const task = simplifySnapshot(details);
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
export function recognizeTimelineToolCall(item: ToolCallItemLike): Omit<MeantimeCardData, "phase"> | undefined {
  const data = recognizeToolCall(item);
  return data?.source === "completion" || data?.source === "meantime" ? data : undefined;
}

const ACTIVE_STATES = new Set(["running", "cancel_requested", "started"]);

export function isActiveTask(task: TaskSummary): boolean {
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
  for (const task of data.tasks) byId.set(task.id, { ...byId.get(task.id), ...task });
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
