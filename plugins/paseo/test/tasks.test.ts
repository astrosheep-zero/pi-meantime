import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallItemLike } from "../shared/tasks.ts";
import { elapsedSeconds, foldTimeline, recognizeToolCall, sortTasks } from "../shared/tasks.ts";

const SNAPSHOT = {
  id: "mt_a1b2c3d4",
  tool: "bash",
  kind: "bash",
  state: "running",
  command: "sleep 60",
  mode: "yes",
  delivery: "background",
  createdAt: 1_700_000_000_000,
  localRunning: true,
  notification: "none",
};

function unknownItem(name: string, input: unknown, output: unknown): ToolCallItemLike {
  return { type: "tool_call", name, status: "completed", detail: { type: "unknown", input, output } };
}

describe("recognizeToolCall: meantime tool", () => {
  it("parses list results with tasks and pagination", () => {
    const data = recognizeToolCall(unknownItem("meantime", { action: "list" }, {
      content: [{ type: "text", text: "..." }],
      details: { tasks: [SNAPSHOT], next_offset: 20 },
    }));
    assert.equal(data?.source, "meantime");
    assert.equal(data?.action, "list");
    assert.equal(data?.moreOffset, 20);
    assert.equal(data?.tasks.length, 1);
    assert.deepEqual(data?.tasks[0], {
      id: "mt_a1b2c3d4", tool: "bash", state: "running",
      command: "sleep 60", createdAt: 1_700_000_000_000,
    });
  });

  it("parses wait results via details.task", () => {
    const done = { ...SNAPSHOT, state: "completed", endedAt: 1_700_000_060_000, exitCode: 0 };
    const data = recognizeToolCall(unknownItem("meantime", { action: "wait", id: SNAPSHOT.id }, {
      details: { task: done, result_available: true },
    }));
    assert.equal(data?.tasks[0]?.state, "completed");
    assert.equal(data?.tasks[0]?.exitCode, 0);
    assert.equal(elapsedSeconds(data!.tasks[0]!), 60);
  });

  it("parses bare snapshot handles via details.id", () => {
    const data = recognizeToolCall(unknownItem("meantime", { action: "cancel", id: SNAPSHOT.id }, { details: SNAPSHOT }));
    assert.equal(data?.tasks[0]?.id, "mt_a1b2c3d4");
  });

  it("marks cancel-requested snapshots", () => {
    const data = recognizeToolCall(unknownItem("meantime", { action: "cancel" }, {
      details: { task: { ...SNAPSHOT, state: "cancel_requested", cancelRequestedAt: 1_700_000_010_000 } },
    }));
    assert.equal(data?.tasks[0]?.cancelRequested, true);
  });

  it("rejects meantime results without parseable tasks", () => {
    assert.equal(recognizeToolCall(unknownItem("meantime", { action: "list" }, { details: { tasks: [] } })), undefined);
    assert.equal(recognizeToolCall(unknownItem("meantime", { action: "list" }, { content: [{ type: "text", text: "none" }] })), undefined);
  });
});

describe("recognizeToolCall: _mt proxies", () => {
  it("recognizes background handles", () => {
    const data = recognizeToolCall(unknownItem("web_fetch_mt", { url: "https://x" }, { details: SNAPSHOT }));
    assert.equal(data?.source, "handle");
    assert.equal(data?.tasks[0]?.id, "mt_a1b2c3d4");
  });

  it("ignores foreground results", () => {
    const foreground = { ...SNAPSHOT, delivery: "foreground" };
    assert.equal(recognizeToolCall(unknownItem("web_fetch_mt", {}, { details: foreground })), undefined);
  });
});

describe("recognizeToolCall: bash background handles", () => {
  it("recovers the task id and command from the handle text", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "bash", status: "completed",
      detail: {
        type: "shell", command: "npm test", exitCode: null,
        output: `Meantime ${SNAPSHOT.id} running in background; execution continues independently. Do not restart or poll in a loop.`,
      },
    });
    assert.equal(data?.source, "handle");
    assert.deepEqual(data?.tasks[0], { id: SNAPSHOT.id, tool: "bash", state: "running", command: "npm test" });
  });

  it("ignores ordinary bash output", () => {
    assert.equal(recognizeToolCall({
      type: "tool_call", name: "bash", status: "completed",
      detail: { type: "shell", command: "ls", output: "file.txt", exitCode: 0 },
    }), undefined);
  });
});

describe("foldTimeline", () => {
  it("lets the latest mention win and sorts active first", () => {
    const started = unknownItem("web_fetch_mt", {}, { details: SNAPSHOT });
    const settled = unknownItem("meantime", { action: "wait" }, {
      details: { task: { ...SNAPSHOT, state: "failed", isError: true, endedAt: 1_700_000_030_000 } },
    });
    const other = unknownItem("web_fetch_mt", {}, {
      details: { ...SNAPSHOT, id: "mt_ffffffff", state: "running", createdAt: 1_700_000_100_000 },
    });
    const tasks = foldTimeline([{ item: started }, { item: settled }, { item: other }]);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.id, "mt_ffffffff");
    assert.equal(tasks[1]?.state, "failed");
    assert.equal(tasks[1]?.isError, true);
  });

  it("ignores non-tool items", () => {
    assert.deepEqual(foldTimeline([{ item: { type: "assistant_message", text: "hi" } }]), []);
  });
});

describe("sortTasks", () => {
  it("orders running before completed, then newest first", () => {
    const sorted = sortTasks([
      { id: "mt_00000001", tool: "bash", state: "completed", createdAt: 200 },
      { id: "mt_00000002", tool: "bash", state: "running", createdAt: 100 },
      { id: "mt_00000003", tool: "bash", state: "completed", createdAt: 300 },
    ]);
    assert.deepEqual(sorted.map(task => task.id), ["mt_00000002", "mt_00000003", "mt_00000001"]);
  });
});
