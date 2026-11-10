import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ stdin: { contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MeantimeTaskCard, ListCard} from './client/task-card.tsx';
import {TaskLine} from './client/task-view.tsx';
const theme = {colors:{surface0:'#fff',surface1:'#f4f5f4',foreground:'#111',foregroundMuted:'#777',border:'#ccc',statusWarning:'#b7791f',statusDanger:'#c2412d'}};
const layout = {compact:true,platform:'web'};
export function render(data) {
 return renderToStaticMarkup(<MeantimeTaskCard item={{data}} theme={theme} layout={layout}/>);
}
// The list card answers collapsed; this renders its pressed-open state.
export function renderList(data, openTask = false) {
 return renderToStaticMarkup(<ListCard data={data} colors={theme.colors} layout={layout} defaultOpen openTask={openTask}/>);
}
// Node renders statically: no press can be dispatched, so the same row is
// rendered in its expanded state to exercise the inline drawer.
export function renderLine(task) {
 return renderToStaticMarkup(<TaskLine task={task} colors={theme.colors} layout={layout} defaultOpen/>);
}`, loader: "tsx", resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true, write: false, platform: "node", format: "cjs", alias: { "react-native": "react-native-web" },
  plugins: [{ name: "host-rn-stub", setup(b) {
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({ path: new URL("./stubs/paseo-react-native.js", import.meta.url).pathname }));
  }}],
  define: { "process.env.NODE_ENV": '"production"' } });
// Bundled CJS keeps React's node builtins available without writing build artifacts.
const { createRequire } = await import("node:module");
const module = { exports: {} as {
  render?: (data: unknown) => string;
  renderList?: (data: unknown, openTask?: boolean) => string;
  renderLine?: (task: unknown) => string;
} };
new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
const render = module.exports.render!;
const renderList = module.exports.renderList!;
const renderLine = module.exports.renderLine!;

test("wait cards retain every supplied target and its outcome", () => {
  const html = render({ source: "meantime", action: "wait", tasks: [
    { id: "mt_a1b2c3d4", state: "completed", command: "npm test", exitCode: 0 },
    { id: "mt_deadbeef", state: "failed", command: "make test", exitCode: 2 },
  ] });
  assert.match(html, /npm/);
  assert.match(html, /make/);
  assert.match(html, />exit 2</);
});
test("wait-all shows the supplied task count and an empty list remains an answer", () => {
  assert.match(render({ source: "meantime", action: "wait", tasks: [], total: 0 }), /0.*tasks/);
  assert.match(render({ source: "meantime", action: "list", tasks: [] }), /No background tasks/);
});
test("collapsed lists summarize all outcome groups including inactive and single-task pages", () => {
  const tasks = [
    { id: "mt_11111111", state: "queued" }, { id: "mt_22222222", state: "waiting" },
    { id: "mt_33333333", state: "completed" }, { id: "mt_44444444", state: "failed" },
    { id: "mt_55555555", state: "cancelled" },
  ];
  const html = render({ source: "meantime", action: "list", tasks });
  for (const text of ["2 active", "1 ✓", "1 ✕", "1 other"]) assert.ok(html.includes(text));
  assert.match(render({ source: "meantime", action: "list", tasks: [tasks[2]] }), /1 ✓/);
});
test("opened list rows expose task details and remaining count", () => {
  const html = renderList({ source: "meantime", action: "list", tasks: [
    { id: "mt_deadbeef", state: "failed", command: "make test", output: "failure output" },
  ], total: 25, moreOffset: 1 }, true);
  for (const text of ["mt_deadbeef", "failure output", "+24 more"]) assert.ok(html.includes(text));
});
test("a launch receipt names the started observation", () => {
  assert.match(render({ source: "handle", tasks: [{ id: "mt_deadbeef", state: "running", command: "npm test" }] }), />started</);
});
test("opening a task exposes complete command, output and identity together", () => {
  const command = "const x = 1;\nreturn x;";
  const html = renderLine({ id: "mt_deadbeef", tool: "codemode", code: command, state: "completed", output: "result 1", outputPath: "/tmp/result.log" });
  for (const text of [command, "result 1", "mt_deadbeef", "/tmp/result.log"]) assert.ok(html.includes(text));
});
test("task output selects final result, then tail, then progress", () => {
  for (const fields of [{ output: "chosen", outputTail: "tail" }, { outputTail: "chosen", progress: "progress" }, { progress: "chosen" }]) {
    assert.match(renderLine({ id: "mt_deadbeef", state: "running", ...fields }), /chosen/);
  }
});
test("wait outcomes annotate active siblings while settled results retain their outcome", () => {
  for (const outcome of ["timeout", "interrupted"]) {
    const html = render({ source: "meantime", action: "wait", waitOutcome: outcome, waitedSeconds: 72, tasks: [
      { id: "mt_11111111", state: "completed", command: "echo done", createdAt: 0, endedAt: 3000 },
      { id: "mt_22222222", state: "running", command: "npm watch" },
    ] });
    assert.match(html, new RegExp(`>${outcome}<`));
    assert.match(html, /waited /);
    assert.match(html, /1:12/);
    assert.match(html, /0:03/);
  }
});
test("actual call errors remain readable call-error cards", () => {
  assert.match(render({ source: "meantime", tasks: [], call: "meantime cancel", error: "cancel requires ids" }), /cancel requires ids/);
});
