import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { foldTimeline, type TaskSummary } from "../shared/tasks.ts";

/** Count tasks, not timeline entries: a task can appear on many history pages. */
export async function loadBoardTasks(timeline: Pick<PaseoAgentTimelineHandle, "refetch">, signal?: AbortSignal): Promise<TaskSummary[]> {
  if (signal?.aborted) throw new Error("Task history load cancelled.");
  let page = await timeline.refetch({ direction: "tail", limit: 500 });
  const epoch = page.epoch, pages = [page.entries];
  for (;;) {
    if (signal?.aborted) throw new Error("Task history load cancelled.");
    if (page.error) throw new Error(page.error);
    if (page.epoch !== epoch || page.staleCursor || page.gap) throw new Error("Task history changed while loading; reload the board.");
    if (!page.hasOlder) return foldTimeline(pages.reverse().flat());
    const cursor = page.startCursor;
    if (!cursor) throw new Error("Task history has no cursor for its older tasks.");
    page = await timeline.refetch({ direction: "before", cursor, limit: 500 });
    if (page.startCursor && page.startCursor.seq >= cursor.seq) throw new Error("Task history did not advance to its older tasks.");
    pages.push(page.entries);
  }
}
