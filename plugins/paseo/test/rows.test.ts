import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Resolve the client's .js imports as TypeScript, as the plugin bundler does.
const bundle = await build({ entryPoints: [new URL("../client/rows.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { formatElapsed, completionResult, stateCode, stateLabel, stateColor, taskStateCode, taskStateLabel, secondaryColor, frameColor, readableColor } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);

test("elapsed is a fixed snapshot, never inferred from a start alone", () => {
  const task = { id: "mt_a1b2c3d4", state: "running", createdAt: 1000 };
  assert.equal(formatElapsed(task), undefined);
  assert.equal(formatElapsed({ ...task, state: "completed" }), undefined);
  assert.equal(formatElapsed({ ...task, endedAt: 46000 }), "00:45");
  assert.equal(formatElapsed({ ...task, endedAt: 1000 }), "00:00");
  assert.equal(formatElapsed({ id: task.id, state: "completed", endedAt: 46000 }), undefined);
});

test("states remain distinct and only observed running is R", () => {
  const states = ["running", "started", "queued", "cancel_requested", "cancelled", "outcome_unknown", ""];
  assert.equal(new Set(states.map(stateCode)).size, states.length);
  assert.equal(stateLabel("started"), "STARTED");
  assert.equal(stateLabel(""), "MISSING STATE");
  const colors = { statusDanger: "danger", statusWarning: "amber", foregroundMuted: "muted" };
  assert.equal(stateColor("running", colors), "amber");
  assert.equal(stateColor("completed", colors), "muted");
  assert.equal(stateColor("cancelled", colors), "muted");
  assert.equal(stateColor("failed", colors), "danger");
});

test("terminal table cells keep supplied exit codes compact and accessible", () => {
  const task = { state: "completed", exitCode: 0 };
  assert.equal(taskStateCode(task), "X0");
  assert.equal(taskStateLabel(task), "COMPLETED · exit 0");
  assert.equal(taskStateCode({ state: "failed", exitCode: 1 }), "E1");
  assert.equal(taskStateCode({ state: "failed", exitCode: 127 }), "E127");
  assert.equal(taskStateLabel({ state: "failed", exitCode: 127 }), "FAILED · exit 127");
  assert.equal(taskStateCode({ state: "failed" }), "E");
});

test("washed-out host tokens gain contrast without using border or a fixed palette", () => {
  const colors = { surface0: "#ffffff", foreground: "#202124", foregroundMuted: "#b6b9be",
    border: "#f1f2f3", statusWarning: "#f1d9a4", statusDanger: "#eeb4ad" };
  const contrast = (color: string) => {
    const channels = color.slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255)
      .map(s => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return 1.05 / (channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722 + 0.05);
  };
  assert.ok(contrast(secondaryColor(colors)) >= 4.5);
  assert.ok(contrast(stateColor("running", colors)) >= 4.5);
  assert.ok(contrast(stateColor("failed", colors)) >= 4.5);
  assert.ok(contrast(frameColor(colors)) >= 2);
  assert.notEqual(frameColor(colors), colors.border);
  const dark = { ...colors, surface0: "#0f1114", foreground: "#e4e7ec" };
  assert.equal(readableColor("#e9b45a", dark), "#e9b45a");
});

test("sparse receipts never invent an exit code", () => {
  assert.equal(completionResult({ state: "completed" }), "completed");
  assert.equal(completionResult({ state: "failed" }), "failed");
  assert.equal(completionResult({ state: "completed", exitCode: 0 }), "completed · exit 0");
  assert.equal(completionResult({ state: "cancelled" }), "cancelled");
});
