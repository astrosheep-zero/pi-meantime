import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

// Resolve the client's .js imports as TypeScript, as the plugin bundler does.
const bundle = await build({ entryPoints: [new URL("../client/rows.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { formatElapsed, stateLabel, stateColor, doneColor, taskStateLabel, secondaryColor, frameColor, readableColor } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);

// Cards render through react-native-web so the markup the timeline receives —
// paddings, opacity, bounded boxes — is what the assertions below read.
const surfaces = await build({ stdin: { contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskCommand, TaskLine, TaskTable} from './client/task-view.tsx';
import {MeantimeTaskCard} from './client/task-card.tsx';
const theme = {colors:{surface0:'#fff',surface1:'#f4f5f4',foreground:'#111',foregroundMuted:'#777',border:'#ccc',statusWarning:'#b7791f',statusDanger:'#c2412d'}};
const layout = {compact:true,platform:'web'};
const draw = (element) => renderToStaticMarkup(element);
export const row = (task) => draw(<TaskLine task={task} colors={theme.colors} layout={layout}/>);
export const detail = (task) => draw(<TaskLine task={task} colors={theme.colors} layout={layout} defaultOpen/>);
export const openRow = (task) => draw(<TaskLine task={task} colors={theme.colors} layout={layout} defaultOpen/>);
export const table = (tasks) => draw(<TaskTable tasks={tasks} colors={theme.colors} layout={layout}/>);
export const emptyWait = () => draw(<MeantimeTaskCard item={{data:{source:'meantime',action:'wait',tasks:[]}}} theme={theme} layout={layout}/>);`,
  loader: "tsx", resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true, write: false, platform: "node", format: "cjs", alias: { "react-native": "react-native-web" },
  plugins: [{ name: "host-rn-stub", setup(b) {
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({ path: new URL("./stubs/paseo-react-native.js", import.meta.url).pathname }));
  }}],
  define: { "process.env.NODE_ENV": '"production"' } });
const ui = { exports: {} as {
  row: (task: unknown) => string;
  detail: (task: unknown) => string;
  openRow: (task: unknown) => string;
  table: (tasks: unknown[]) => string;
  emptyWait: () => string;
} };
// Bundled CJS keeps React's node builtins available without writing build artifacts.
const { createRequire } = await import("node:module");
new Function("require", "module", "exports", surfaces.outputFiles[0]!.text)(createRequire(import.meta.url), ui, ui.exports);
const { row, detail, openRow, table, emptyWait } = ui.exports;

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

test("a collapsed row flattens newlines; an open row shows the full script in the drawer", () => {
  const task = { id: "mt_a1b2c3d4", state: "running", command: "npm test\n  --  --watch" };
  const collapsed = row(task);
  assert.match(collapsed, /npm<span[^>]*> test -- --watch<\/span>/);
  assert.doesNotMatch(collapsed, /npm test\n/);
  const open = openRow({ ...task, progress: "2/5" });
  // The header keeps the flattened one-liner; the script unfolds once, in the drawer.
  assert.match(open, /npm<span[^>]*> test -- --watch<\/span>/);
  assert.equal(open.match(/npm test\n  --  --watch/g)?.length, 1);
  assert.match(open, /2\/5/);

});

test("the meter always names the state and pairs the elapsed time when known", () => {
  for (const state of ["running", "started", "waiting", "queued"]) assert.match(row({ id: "mt_a1b2c3d4", state, command: "npm test" }), new RegExp(`>${state}<`));
  const timed = row({ id: "mt_a1b2c3d4", state: "running", command: "npm test", createdAt: 0, endedAt: 45_000 });
  assert.match(timed, />running</);
  assert.match(timed, />00:45</);
  assert.match(row({ id: "mt_a1b2c3d4", state: "completed", exitCode: 2, command: "npm test" }), />exit 2</);
  assert.match(row({ id: "mt_a1b2c3d4", state: "cancelled", command: "npm test" }), />cancelled</);
});

test("the drawer shows output directly and keeps a tail-only fallback", () => {
  const task = { id: "mt_a1b2c3d4", state: "completed", command: "npm test", outputTail: "108 passing\n" };
  const tail = detail(task);
  assert.match(tail, /108 passing/);
  assert.doesNotMatch(tail, /Output tail|>Output</);
  const full = detail({ ...task, output: "start\n108 passing\n" });
  assert.match(full, /start\n108 passing/);
});

test("the drawer caps direct oversized output as well as projected timeline data", () => {
  const drawer = detail({ id: "mt_a1b2c3d4", state: "completed",
    output: "START\n" + "x".repeat(1_000_000) + "\nEND" });
  assert.match(drawer, /START/);
  assert.match(drawer, /END/);
  assert.match(drawer, /middle is hidden/);
  assert.ok(drawer.length < 40_000);
});
