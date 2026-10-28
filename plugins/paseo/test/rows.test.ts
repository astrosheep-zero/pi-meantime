import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

// Resolve the client's .js imports as TypeScript, as the plugin bundler does.
const bundle = await build({ entryPoints: [new URL("../client/rows.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { formatElapsed, completionResult, stateLabel, stateColor, doneColor, taskStateLabel, secondaryColor, frameColor, readableColor } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);

// Cards render through react-native-web so the markup the timeline receives —
// paddings, opacity, bounded boxes — is what the assertions below read.
const surfaces = await build({ stdin: { contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskDetailInline, TaskGlyph, TaskLine, TaskTable} from './client/task-view.tsx';
import {MeantimeTaskCard} from './client/task-card.tsx';
const theme = {colors:{surface0:'#fff',surface1:'#f4f5f4',foreground:'#111',foregroundMuted:'#777',border:'#ccc',statusWarning:'#b7791f',statusDanger:'#c2412d'}};
const layout = {compact:true,platform:'web'};
const draw = (element) => renderToStaticMarkup(element);
export const glyph = (state) => draw(<TaskGlyph task={{state}} colors={theme.colors}/>);
export const row = (task) => draw(<TaskLine task={task} colors={theme.colors} layout={layout}/>);
export const detail = (task) => draw(<TaskDetailInline task={task} colors={theme.colors} layout={layout}/>);
export const table = (tasks) => draw(<TaskTable tasks={tasks} colors={theme.colors} layout={layout}/>);
export const emptyWait = () => draw(<MeantimeTaskCard item={{data:{source:'meantime',action:'wait',tasks:[]}}} theme={theme} layout={layout}/>);`,
  loader: "tsx", resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true, write: false, platform: "node", format: "cjs", alias: { "react-native": "react-native-web" },
  plugins: [{ name: "host-rn-stub", setup(b) {
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({ path: new URL("./stubs/paseo-react-native.js", import.meta.url).pathname }));
  }}],
  define: { "process.env.NODE_ENV": '"production"' } });
const ui = { exports: {} as {
  glyph: (state: string) => string;
  row: (task: unknown) => string;
  detail: (task: unknown) => string;
  table: (tasks: unknown[]) => string;
  emptyWait: () => string;
} };
// Bundled CJS keeps React's node builtins available without writing build artifacts.
const { createRequire } = await import("node:module");
new Function("require", "module", "exports", surfaces.outputFiles[0]!.text)(createRequire(import.meta.url), ui, ui.exports);
const { glyph, row, detail, table, emptyWait } = ui.exports;

test("elapsed is a fixed snapshot, never inferred from a start alone", () => {
  const task = { id: "mt_a1b2c3d4", state: "running", createdAt: 1000 };
  assert.equal(formatElapsed(task), undefined);
  assert.equal(formatElapsed({ ...task, state: "completed" }), undefined);
  assert.equal(formatElapsed({ ...task, endedAt: 46000 }), "00:45");
  assert.equal(formatElapsed({ ...task, endedAt: 1000 }), "00:00");
  assert.equal(formatElapsed({ id: task.id, state: "completed", endedAt: 46000 }), undefined);
});

test("state labels and colors stay distinct", () => {
  assert.equal(stateLabel("started"), "STARTED");
  assert.equal(stateLabel(""), "MISSING STATE");
  const colors = { statusDanger: "danger", statusWarning: "amber", statusSuccess: "green", foregroundMuted: "muted" };
  assert.equal(stateColor("running", colors), "amber");
  assert.equal(stateColor("completed", colors), "muted");
  assert.equal(stateColor("cancelled", colors), "muted");
  assert.equal(stateColor("failed", colors), "danger");
  assert.equal(doneColor(colors), "green");
  assert.equal(doneColor({ foregroundMuted: "muted" }), "#7fb26a");
});

test("terminal table labels keep supplied exit codes compact and accessible", () => {
  const task = { state: "completed", exitCode: 0 };
  assert.equal(taskStateLabel(task), "COMPLETED · exit 0");
  assert.equal(taskStateLabel({ state: "failed", exitCode: 1 }), "FAILED · exit 1");
  assert.equal(taskStateLabel({ state: "failed", exitCode: 127 }), "FAILED · exit 127");
  assert.equal(taskStateLabel({ state: "failed" }), "FAILED");
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

test("a collapsed row flattens preserved newlines while the drawer keeps them", () => {
  const task = { id: "mt_a1b2c3d4", state: "running", command: "npm test\n  --  --watch" };
  const collapsed = row(task);
  assert.match(collapsed, /npm<span[^>]*> test -- --watch<\/span>/);
  assert.doesNotMatch(collapsed, /npm test\n/);
  const drawer = detail(task);
  assert.match(drawer, /npm test\n  --  --watch/);
});

test("live dots breathe while parked rings hold steady ink", async () => {
  for (const state of ["running", "started"]) {
    assert.match(glyph(state), /opacity:/, `${state} dot carries the pulse value`);
  }
  for (const state of ["waiting", "queued", "cancel_requested"]) {
    const ring = glyph(state);
    assert.doesNotMatch(ring, /opacity:/, `${state} ring must not pulse`);
    assert.match(ring, /border-top-width:1\.5px/, `${state} is a hollow ring`);
  }
  // Node cannot run effects, so the shape of the cycle is pinned from source:
  // two legs at 1000ms each, one loop, no sawtooth snap back to full ink.
  const source = await readFile(new URL("../client/task-view.tsx", import.meta.url), "utf8");
  assert.match(source, /sequence\(\[leg\(target, 0\.35\), leg\(target, 1\)\]\)/);
  assert.match(source, /const BREATHE_MS = 1000;/);
  assert.match(source, /loop\(cycle\)/);
  assert.match(source, /EASING\.inOut\(EASING\.sin\)/);
  assert.doesNotMatch(source, /toValue: 0\.4/);
});

test("the drawer prefers projected output and keeps a tail-only fallback", () => {
  const task = { id: "mt_a1b2c3d4", state: "completed", command: "npm test", outputTail: "108 passing\n" };
  assert.match(detail(task), /Output tail/);
  assert.match(detail(task), /108 passing/);
  const full = detail({ ...task, output: "start\n108 passing\n" });
  assert.match(full, />Output</);
  assert.match(full, /start\n108 passing\n/);
});

test("the drawer caps direct oversized output as well as projected timeline data", () => {
  const drawer = detail({ id: "mt_a1b2c3d4", state: "completed",
    output: "START\n" + "x".repeat(1_000_000) + "\nEND" });
  assert.match(drawer, /START/);
  assert.match(drawer, /END/);
  assert.match(drawer, /middle is hidden/);
  assert.ok(drawer.length < 40_000);
});

test("cards and rows drop the jump triggers and align notes in the command column", () => {
  const html = table([{ id: "mt_a1b2c3d4", state: "running", command: "npm test", progress: "2/5" }]);
  assert.doesNotMatch(html, /overflow/);
  assert.doesNotMatch(html, /margin-top:4px/);
  assert.doesNotMatch(html, /padding-left:34px/);
  assert.match(html, /padding-right:12px;padding-left:12px;padding-top:9px;padding-bottom:9px/);
  // Notes share the command's column, so they inherit its left edge.
  assert.match(html, /flex:1;min-width:0px;gap:3px">[\s\S]*?2\/5/);
  const empty = emptyWait();
  assert.doesNotMatch(empty, /margin-top:4px/);
  assert.match(empty, /padding-right:12px;padding-left:12px;padding-top:9px;padding-bottom:9px/);
});

test("completion receipts never invent an exit code", () => {
  assert.equal(completionResult({ state: "completed" }), "done");
  assert.equal(completionResult({ state: "failed" }), "failed");
  assert.equal(completionResult({ state: "completed", exitCode: 0 }), "done");
  assert.equal(completionResult({ state: "completed", exitCode: 2 }), "done · exit 2");
  assert.equal(completionResult({ state: "failed", exitCode: 1 }), "failed · exit 1");
  assert.equal(completionResult({ state: "cancelled" }), "cancelled");
  assert.equal(completionResult({ state: "outcome_unknown" }), "status unknown");
});
