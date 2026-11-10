import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { loadBoardTasks } from "../client/board-data.ts";
import { previewTasks } from "../shared/tasks.ts";

type Page = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
function page(seq: number, tasks: { id: string; state: string }[], older = false): Page {
  return { requestId: "fixture", agentId: "fixture", agent: null, direction: "tail", projection: "projected", epoch: "epoch",
    reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: seq, nextSeq: seq + 1 },
    startCursor: { epoch: "epoch", seq }, endCursor: { epoch: "epoch", seq }, hasOlder: older, hasNewer: false, error: null,
    entries: tasks.map(task => ({ provider: "pi", timestamp: "2026-11-10T00:00:00Z", seqStart: seq, seqEnd: seq,
      sourceSeqRanges: [], collapsed: [], item: { type: "tool_call", name: "meantime", callId: `fixture-${seq}`, status: "completed", error: null,
        detail: { type: "unknown", input: { action: "list" }, output: { details: { tasks: [{ tool: "codemode", args: { code: "return 42;" }, ...task }] } } } } })) };
}

test("board folds older pages before newer mentions and counts unique tasks", async () => {
  const calls: unknown[] = [];
  const tail = page(10, [{ id: "mt_11111111", state: "completed" }, { id: "mt_22222222", state: "running" }], true);
  const older = page(1, [{ id: "mt_11111111", state: "running" }, { id: "mt_33333333", state: "failed" }]);
  const tasks = await loadBoardTasks({ async refetch(options) { calls.push(options); return options?.direction === "before" ? older : tail; } });
  assert.equal(tasks.length, 3);
  assert.equal(tasks.find(t => t.id === "mt_11111111")?.state, "completed");
  assert.deepEqual(tasks.find(t => t.id === "mt_33333333")?.args, { code: "return 42;" });
  assert.equal((calls[1] as { cursor: unknown }).cursor, tail.startCursor);
});

test("board rejects incomplete or replaced history instead of publishing a false total", async () => {
  const incomplete = page(10, [], true);
  incomplete.startCursor = null;
  await assert.rejects(loadBoardTasks({ async refetch() { return incomplete; } }), /no cursor/);
  await assert.rejects(loadBoardTasks({ async refetch(options) {
    return options?.direction === "before" ? { ...page(1, []), epoch: "replacement" } : page(10, [], true);
  } }), /history changed/);
});

test("preview chooses newest active tasks, or the most recently finished task", () => {
  const active = ["running", "waiting", "cancel_requested", "queued"].map((state, i) => ({ id: `live-${i}`, state, createdAt: i }));
  assert.deepEqual(previewTasks([...active, { id: "done", state: "completed", createdAt: 99 }]).map(t => t.id), ["live-3", "live-2", "live-1"]);
  assert.deepEqual(previewTasks([{ id: "older", state: "completed", createdAt: 9, endedAt: 10 },
    { id: "latest", state: "failed", createdAt: 1, endedAt: 11 }]).map(t => t.id), ["latest"]);
});
