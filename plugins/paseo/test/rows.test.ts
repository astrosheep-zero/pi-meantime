import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Resolve the client's .js imports as TypeScript, as the plugin bundler does.
const bundle = await build({ entryPoints: [new URL("../client/rows.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { formatElapsed, completionResult, stateCode, stateLabel, stateColor, taskStateCode, taskStateLabel } =
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

test("sparse receipts never invent an exit code", () => {
  assert.equal(completionResult({ state: "completed" }), "completed");
  assert.equal(completionResult({ state: "failed" }), "failed");
  assert.equal(completionResult({ state: "completed", exitCode: 0 }), "completed · exit 0");
  assert.equal(completionResult({ state: "cancelled" }), "cancelled");
});
