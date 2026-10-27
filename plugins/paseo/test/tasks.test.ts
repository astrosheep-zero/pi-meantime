import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallItemLike } from "../shared/tasks.ts";
import { elapsedSeconds, foldTimeline, recognizeTimelineToolCall, recognizeToolCall, resolveWaitTask, sortTasks } from "../shared/tasks.ts";

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
    const data = recognizeToolCall(unknownItem("meantime", { action: "wait", ids: [SNAPSHOT.id] }, {
      details: { task: done, result_available: true },
    }));
    assert.equal(data?.tasks[0]?.state, "completed");
    assert.equal(data?.tasks[0]?.exitCode, 0);
    assert.equal(elapsedSeconds(data!.tasks[0]!), 60);
  });

  it("recognizes a running wait from its input before any output exists", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime", status: "running",
      detail: { type: "unknown", input: { action: "wait", ids: [SNAPSHOT.id], timeout: 60 }, output: null },
    });
    assert.equal(data?.source, "meantime");
    assert.equal(data?.action, "wait");
    assert.deepEqual(data?.tasks, [{ id: SNAPSHOT.id, state: "waiting" }]);
  });

  it("reads command and metadata from a running wait's partial details", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime", status: "running",
      detail: { type: "unknown", input: { action: "wait", ids: [SNAPSHOT.id] }, output: {
        content: [], details: { tasks: [{ id: SNAPSHOT.id, tool: "bash", state: "waiting",
          command: "npm test -- --watch", createdAt: SNAPSHOT.createdAt }] } } },
    });
    assert.equal(data?.source, "meantime");
    assert.equal(data?.action, "wait");
    // The wait observes: a partial snapshot can only ever read as waiting,
    // and its command/tool/createdAt beat the bare id from the input.
    assert.deepEqual(data?.tasks, [{ id: SNAPSHOT.id, tool: "bash", state: "waiting",
      command: "npm test -- --watch", createdAt: SNAPSHOT.createdAt }]);
  });

  it("reads a single running-wait snapshot from details.task", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime", status: "running",
      detail: { type: "unknown", input: { action: "wait", id: SNAPSHOT.id }, output: {
        content: [], details: { task: { ...SNAPSHOT, state: "running" } } } },
    });
    assert.deepEqual(data?.tasks, [{ id: SNAPSHOT.id, tool: "bash", state: "waiting",
      command: "sleep 60", createdAt: SNAPSHOT.createdAt }]);
  });

  it("falls back to requested ids when partial details carry no tasks", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime", status: "running",
      detail: { type: "unknown", input: { action: "wait", ids: [SNAPSHOT.id] },
        output: { content: [], details: { tasks: [] } } },
    });
    assert.deepEqual(data?.tasks, [{ id: SNAPSHOT.id, state: "waiting" }]);
  });

  it("recognizes batch, prefix, wait-all and historical wait inputs", () => {
    for (const [input, ids] of [
      [{ action: "wait", ids: [SNAPSHOT.id, "mt_deadbeef"] }, [SNAPSHOT.id, "mt_deadbeef"]],
      [{ action: "wait", ids: ["a1b2", "mt_dead"] }, ["a1b2", "mt_dead"]],
      [{ action: "wait" }, []],
      [{ action: "wait", id: SNAPSHOT.id }, [SNAPSHOT.id]],
    ] as const) {
      const data = recognizeTimelineToolCall({ type: "tool_call", name: "meantime", status: "running",
        detail: { type: "unknown", input, output: null } });
      assert.equal(data?.action, "wait");
      assert.deepEqual(data?.tasks, ids.map(id => ({ id, state: "waiting" })));
    }
  });

  it("leaves invalid inputs and other running actions native", () => {
    for (const input of [{ action: "wait", ids: [] }, { action: "wait", ids: "a1b2" },
      { action: "wait", ids: [123] }, { action: "wait", ids: ["not-a-task"] }, { action: "list" }]) {
      assert.equal(recognizeTimelineToolCall({ type: "tool_call", name: "meantime", status: "running",
        detail: { type: "unknown", input, output: null } }), undefined);
    }
  });

  it("retains unfinished tasks from a batch wait", () => {
    const data = recognizeToolCall(unknownItem("meantime", { action: "wait", ids: [SNAPSHOT.id] }, {
      details: { tasks: [], pending: [SNAPSHOT] },
    }));
    assert.equal(data?.tasks[0]?.state, "running");
    assert.equal(data?.tasks[0]?.command, "sleep 60");
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

  it("folds original-name managed handles without replacing their native rows", () => {
    const handle = unknownItem("read", { path: "/tmp/output" }, { details: SNAPSHOT });
    assert.equal(recognizeToolCall(handle)?.tasks[0]?.id, SNAPSHOT.id);
    assert.equal(recognizeTimelineToolCall(handle), undefined);
    assert.equal(foldTimeline([{ item: handle }])[0]?.command, SNAPSHOT.command);
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
    // Handles report "started": terminal state belongs to completion/wait/list.
    assert.deepEqual(data?.tasks[0], { id: SNAPSHOT.id, tool: "bash", state: "started", command: "npm test" });
  });

  it("ignores ordinary bash output", () => {
    assert.equal(recognizeToolCall({
      type: "tool_call", name: "bash", status: "completed",
      detail: { type: "shell", command: "ls", output: "file.txt", exitCode: 0 },
    }), undefined);
  });
});

describe("recognizeToolCall: completion messages", () => {
  it("reads structured snapshots from metadata.details, command included", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime-completion", status: "completed",
      detail: { type: "plain_text", text: "Meantime mt_a1b2c3d4 completed (exit 0)\nAutomated background completion" },
      metadata: { details: { taskIds: ["mt_a1b2c3d4"],
        tasks: [{ id: "mt_a1b2c3d4", tool: "bash", state: "completed", command: "npm test",
          exitCode: 0, createdAt: 1000, endedAt: 46000, outputTail: "108 passing" }] } },
    });
    assert.equal(data?.source, "completion");
    assert.deepEqual(data?.tasks, [{ id: "mt_a1b2c3d4", tool: "bash", state: "completed",
      command: "npm test", exitCode: 0, createdAt: 1000, endedAt: 46000, outputTail: "108 passing" }]);
  });

  it("reads batched completions and failures", () => {
    const data = recognizeToolCall({
      type: "tool_call", name: "meantime-completion", status: "completed",
      detail: { type: "plain_text", text: "Meantime mt_00000001 completed (exit 0)" },
      metadata: { details: { tasks: [
        { id: "mt_00000001", tool: "bash", state: "completed", exitCode: 0 },
        { id: "mt_00000002", tool: "bash", state: "failed", exitCode: 3, command: "make verify" },
      ] } },
    });
    assert.deepEqual(data?.tasks, [
      { id: "mt_00000001", tool: "bash", state: "completed", exitCode: 0 },
      { id: "mt_00000002", tool: "bash", state: "failed", exitCode: 3, command: "make verify" },
    ]);
  });

  it("ignores rows without structured details — the receipt prose is never parsed", () => {
    assert.equal(recognizeToolCall({
      type: "tool_call", name: "meantime-completion", status: "completed",
      detail: { type: "plain_text", text: "Meantime mt_a1b2c3d4 completed (exit 0)" },
    }), undefined);
    assert.equal(recognizeToolCall({
      type: "tool_call", name: "meantime-completion", status: "completed",
      detail: { type: "plain_text", text: "Meantime mt_a1b2c3d4 completed (exit 0)" },
      metadata: { details: { taskIds: ["mt_a1b2c3d4"] } },
    }), undefined);
  });
});

describe("timeline transformer gate", () => {
  it("keeps original tool invocations native but renders meantime queries and completion notifications", () => {
    const handle = unknownItem("web_fetch_mt", {}, { details: SNAPSHOT });
    const list = unknownItem("meantime", { action: "list" }, { details: { tasks: [SNAPSHOT] } });
    const bash = {
      type: "tool_call" as const, name: "bash", status: "completed" as const,
      detail: { type: "shell", command: "sleep 60", output: `Meantime ${SNAPSHOT.id} running in background; execution continues independently.` },
    };
    const completion = {
      type: "tool_call" as const, name: "meantime-completion", status: "completed" as const,
      detail: { type: "plain_text", text: `Meantime ${SNAPSHOT.id} completed (exit 0)` },
      metadata: { details: { tasks: [{ id: SNAPSHOT.id, tool: "bash", state: "completed", exitCode: 0 }] } },
    };
    assert.equal(recognizeTimelineToolCall(handle), undefined);
    assert.equal(recognizeTimelineToolCall(list)?.source, "meantime");
    assert.equal(recognizeTimelineToolCall({
      type: "tool_call", name: "meantime", status: "running",
      detail: { type: "unknown", input: { action: "wait", ids: [SNAPSHOT.id] }, output: null },
    })?.tasks[0]?.state, "waiting");
    assert.equal(recognizeTimelineToolCall(bash), undefined);
    assert.equal(recognizeTimelineToolCall(completion)?.source, "completion");
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

  it("merges completion receipts into the handle instead of erasing it", () => {
    const started = unknownItem("web_fetch_mt", {}, { details: SNAPSHOT });
    const completion = {
      type: "tool_call" as const, name: "meantime-completion", status: "completed" as const,
      detail: { type: "plain_text", text: `Meantime ${SNAPSHOT.id} completed (exit 0)` },
      metadata: { details: { tasks: [{ id: SNAPSHOT.id, tool: "bash", state: "completed", exitCode: 0 }] } },
    };
    const tasks = foldTimeline([{ item: started }, { item: completion }]);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0], {
      id: SNAPSHOT.id, tool: "bash", state: "completed",
      command: "sleep 60", createdAt: SNAPSHOT.createdAt, exitCode: 0,
    });
  });

  it("keeps the waited command when a running wait is folded after its handle", () => {
    const started = unknownItem("web_fetch_mt", {}, { details: SNAPSHOT });
    const waiting = {
      type: "tool_call" as const, name: "meantime", status: "running" as const,
      detail: { type: "unknown", input: { action: "wait", ids: [SNAPSHOT.id] }, output: null },
    };
    const tasks = foldTimeline([{ item: started }, { item: waiting }]);
    assert.deepEqual(tasks[0], {
      id: SNAPSHOT.id, tool: "bash", state: "running",
      command: "sleep 60", createdAt: SNAPSHOT.createdAt,
    });
  });

  it("ignores non-tool items", () => {
    assert.deepEqual(foldTimeline([{ item: { type: "assistant_message", text: "hi" } }]), []);
  });
});

describe("resolveWaitTask", () => {
  it("resolves full and short ids without copying later task state or output", () => {
    const known = new Map([[SNAPSHOT.id, { ...SNAPSHOT, state: "completed", outputTail: "later output" }]]);
    for (const id of [SNAPSHOT.id, "a1b2", "mt_a1b2"]) {
      assert.deepEqual(resolveWaitTask({ id, state: "waiting" }, known), {
        id: SNAPSHOT.id, state: "waiting", tool: "bash", command: "sleep 60",
      });
    }
  });

  it("does not guess missing or ambiguous prefixes", () => {
    const known = new Map([
      [SNAPSHOT.id, SNAPSHOT],
      ["mt_a1b2ffff", { ...SNAPSHOT, id: "mt_a1b2ffff", command: "other command" }],
    ]);
    for (const id of ["a1b2", "dead"]) {
      const target = { id, state: "waiting" };
      assert.equal(resolveWaitTask(target, known), target);
    }
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
