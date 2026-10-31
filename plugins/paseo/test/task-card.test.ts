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

test("wait rows let the lamp carry ordinary status and spell out failures", () => {
  for (const task of [
    { id: "mt_a1b2c3d4", state: "waiting", command: "sleep 60" },
    { id: "mt_a1b2c3d4", state: "running", command: "sleep 60" },
    { id: "mt_a1b2c3d4", state: "completed", command: "sleep 60", exitCode: 0 },
  ]) {
    const html = render({ source: "meantime", action: "wait", tasks: [task] });
    assert.match(html, /sleep.*60/);
    assert.doesNotMatch(html, /still running/);
  }
  assert.match(render({ source: "meantime", action: "wait", tasks: [
    { id: "mt_a1b2c3d4", state: "failed", command: "sleep 60", exitCode: 2 },
  ] }), />exit 2</);
});

test("wait-all renders a waiting lamp without inventing task identities", () => {
  const html = render({ source: "meantime", action: "wait", tasks: [] });
  assert.match(html, />All pending tasks</);
  assert.doesNotMatch(html, /mt_|No output|Finished waiting|>waiting</);
});

test("a completed empty list renders a no-tasks card without fake completion status", () => {
  const html = render({ source: "meantime", action: "list", tasks: [] });
  assert.match(html, /No background tasks/);
  assert.match(html, />none</);
  assert.doesNotMatch(html, />done<|mt_|All pending tasks|No output/);
});

test("list answers collapsed: header and count only, rows stay folded until pressed", () => {
  const html = render({ source: "meantime", action: "list", total: 10, tasks: [
    { id: "mt_a1b2c3d4", state: "failed", command: "make test", exitCode: 3, outputTail: "boom" },
    { id: "mt_deadbeef", state: "completed", command: "npm test", exitCode: 0, notification: "observed" },
    { id: "mt_feedface", state: "completed", command: "npm run lint", exitCode: 0, notification: "delivered" },
  ] });
  assert.match(html, />Background tasks</);
  // Only the running count is reported; the total stays out of the answer.
  assert.doesNotMatch(html, /10 tasks/);
  // Collapsed: no task rows, commands or ids leak into the one-line answer.
  assert.doesNotMatch(html, /aria-label="mt_|make test|npm|boom/);
});

test("pressed-open list exposes short ids and hides notification bookkeeping", () => {
  const html = renderList({ source: "meantime", action: "list", total: 10, tasks: [
    { id: "mt_a1b2c3d4", state: "failed", command: "make test", exitCode: 3, outputTail: "boom" },
    { id: "mt_deadbeef", state: "completed", command: "npm test", exitCode: 0, notification: "observed" },
    { id: "mt_feedface", state: "completed", command: "npm run lint", exitCode: 0, notification: "delivered" },
  ] });
  assert.match(html, />Background tasks</);
  assert.doesNotMatch(html, /10 tasks/);
  assert.match(html, /aria-label="mt_a1b2c3d4"/);
  assert.match(html, /aria-label="mt_deadbeef"/);
  assert.match(html, />a1b2</);
  assert.match(html, />dead</);
  assert.match(html, />exit 3</);
  assert.doesNotMatch(html, />observed<|>delivered</);
  // List rows stay one line each: output only appears inside a task's own drawer.
  assert.doesNotMatch(html, /boom/);
  assert.doesNotMatch(html, /Output tail|Output file|All pending tasks/);
});

test("a task row inside an open list unfolds its own output drawer", () => {
  const html = renderList({ source: "meantime", action: "list", tasks: [
    { id: "mt_a1b2c3d4", state: "failed", command: "make test", exitCode: 3, outputTail: "boom" },
  ] }, true);
  assert.match(html, /boom/);
});

test("batch wait renders every target", () => {
  const html = render({ source: "meantime", action: "wait", tasks: [
    { id: "mt_a1b2c3d4", state: "waiting", command: "sleep 60" },
    { id: "dead", state: "waiting" },
  ] });
  assert.match(html, /sleep.*60/);
  assert.match(html, /dead/);
});

test("a launch handle says it started, not that it is still running", () => {
  const html = render({ source: "handle", tasks: [{ id: "mt_a1b2c3d4", state: "running", command: "npm test", createdAt: 1000 }] });
  assert.match(html, /aria-label="STARTED"/);
  assert.match(html, />started</);
  assert.doesNotMatch(html, /RUNNING|>running<|00:01|meantime|mt_a1b2c3d4/);
  assert.match(html, /npm/);
});

test("actual sparse completion renders id and only the supplied result", () => {
  const html = render({ source: "completion", tasks: [{ id: "mt_deadbeef", state: "failed" }] });
  assert.match(html, /mt_deadbeef/);
  assert.equal(html.match(/mt_deadbeef/g)?.length, 1);
  assert.match(html, /failed/);
  assert.doesNotMatch(html, /exit [01]|seen |00:00|bash/);
});

test("timeline tables lead with commands and keep bookkeeping out of the way", () => {
  const html = render({ source: "meantime", tasks: [
    { id: "mt_a1b2c3d4", state: "completed", command: "npm test", exitCode: 0 },
    { id: "mt_deadbeef", state: "failed", command: "make test", exitCode: 1 },
  ] });
  assert.match(html, /aria-label="COMPLETED · exit 0"/);
  assert.match(html, /aria-label="FAILED · exit 1"/);
  assert.match(html, />exit 1<\/div>/);
  assert.doesNotMatch(html, />X0<\/div>|>E1<\/div>|meantime|snapshots|mt_a1b2c3d4|mt_deadbeef/);
});

test("command highlighting keeps env assignments with the executable word", () => {
  const html = render({ source: "meantime", tasks: [
    { id: "mt_a1b2c3d4", state: "running", command: "FOO=bar BAZ=2 npm test -- --watch" },
  ] });
  // The whole prefix stays foreground; only the arguments recede.
  assert.match(html, />FOO=bar BAZ=2 npm<span[^>]*style="color:[^"]*"> test -- --watch<\/span>/);
  assert.doesNotMatch(html, />FOO=bar<span/);
});

test("batch wait renders separate glass cards", () => {
  const html = render({ source: "meantime", action: "wait", tasks: [
    { id: "mt_a1b2c3d4", state: "waiting", command: "sleep 60" },
    { id: "dead", state: "waiting", command: "npm run watch" },
  ] });
  // Each task gets its own glass panel (background-image is the one chassis).
  assert.equal(html.match(/background-image:/g)?.length, 2);
  assert.match(html, /npm<span[^>]*> run watch<\/span>/);
});

test("task rows keep their details closed until pressed", () => {
  const html = render({ source: "meantime", tasks: [
    { id: "mt_a1b2c3d4", state: "running", command: "npm test", outputTail: "108 passing" },
  ] });
  assert.match(html, /npm/);
  assert.doesNotMatch(html, /Output tail|Output file|role="dialog"/);
});

test("pressing a row expands details inline instead of opening a modal", async () => {
  const html = renderLine({ id: "mt_a1b2c3d4", state: "running", command: "npm test -- --watch",
    outputTail: "108 passing\n", outputPath: "/tmp/mt_a1b2c3d4.log", createdAt: 1_700_000_000_000 });
  // The header unfolds in place; the drawer holds only output and facts.
  assert.equal(html.match(/> test -- --watch</g)?.length, 1);
  assert.match(html, /108 passing/);
  assert.doesNotMatch(html, />Command<|>Output<|>Output tail</);
  assert.match(html, /mt_a1b2c3d4/);
  assert.match(html.replace(/<[^>]+>/g, ""), /mt_a1b2c3d4 · .*\/tmp\/mt_a1b2c3d4\.log/);
  assert.doesNotMatch(html, /role="dialog"/);
  // The host Modal renders null everywhere the tests can run, so the source
  // is what proves the row owns a drawer rather than an overlay.
  const source = await readFile(new URL("../client/task-view.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Modal/);
});

test("collapsed cards are one uniform line; output stays in the drawer", () => {
  for (const state of ["running", "waiting", "started", "cancel_requested"]) {
    const html = render({ source: "meantime", action: "wait", tasks: [
      { id: "mt_a1b2c3d4", state, command: "npm test", progress: "duplicate progress",
        outputTail: "discarded first\n\n  build 2\nbuild 3\n\n build 4\nbuild 5\nlatest line\n \n" },
    ] });
    assert.match(html, /npm/);
    assert.doesNotMatch(html, /build|latest line|duplicate progress/);
    const open = renderLine({ id: "mt_a1b2c3d4", state, command: "npm test", progress: "duplicate progress",
      outputTail: "discarded first\n\n  build 2\nbuild 3\n\n build 4\nbuild 5\nlatest line\n \n" });
    assert.match(open, /latest line/);
    assert.match(open, /discarded first/);
  }
  const fallback = renderLine({ id: "mt_a1b2c3d4", state: "running", command: "npm test", progress: "fallback progress\nnewest" });
  assert.match(fallback, /fallback progress\nnewest/);
});

test("drawers prefer the final output over stale live tails", () => {
  for (const state of ["completed", "failed", "cancelled", "outcome_unknown"]) {
    const open = renderLine({ id: "mt_a1b2c3d4", state, command: "npm test", output: "old final\n\nlast result\nfinished\n",
      outputTail: "stale tail", progress: "stale progress" });
    assert.match(open, /last result\nfinished/);
    assert.match(open, /old final/);
    assert.doesNotMatch(open, /stale tail|stale progress/);
  }
});

test("expanded rows show full output once instead of a collapsed preview", () => {
  const output = "first line\n\n" + Array.from({ length: 8 }, (_, i) => `output ${i}`).join("\n");
  const html = renderLine({ id: "mt_a1b2c3d4", state: "running", command: "npm test", output,
    outputTail: "hidden tail", progress: "hidden progress", outputPath: "/tmp/result.log" });
  assert.ok(html.includes(output));
  assert.equal(html.match(/output 7/g)?.length, 1);
  assert.doesNotMatch(html, /LIVE OUTPUT|>OUTPUT<|hidden tail|hidden progress/);
  assert.match(html.replace(/<[^>]+>/g, ""), /mt_a1b2c3d4 · \/tmp\/result\.log/);
});

test("inline output falls back from final output to live tail to progress", () => {
  const task = { id: "mt_a1b2c3d4", state: "running", command: "npm test" };
  for (const [fields, expected] of [
    [{ progress: "live fallback\nlatest" }, "live fallback"],
    [{ progress: "hidden progress", outputTail: "live tail" }, "live tail"],
    [{ progress: "hidden progress", outputTail: "hidden tail", output: "final output" }, "final output"],
  ] as const) {
    const html = renderLine({ ...task, ...fields });
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /hidden tail/);
  }
});

test("inline details leave an empty output tail out entirely", () => {
  const html = renderLine({ id: "mt_a1b2c3d4", state: "running", command: "sleep 60", outputTail: "  \n" });
  assert.match(html, /sleep.*60/);
  assert.doesNotMatch(html, /Output tail|Output file/);
});


test("wait outcomes display their own duration on still-active targets without overriding settled siblings", () => {
  for (const outcome of ["timeout", "interrupted"]) {
    const html = render({ source: "meantime", action: "wait", waitOutcome: outcome, waitedSeconds: 72,
      tasks: [
        { id: "mt_11111111", state: "completed", command: "echo done", exitCode: 0, createdAt: 0, endedAt: 3000 },
        { id: "mt_a1b2c3d4", state: "running", command: "npm test", outputTail: "latest" },
      ] });
    assert.equal(html.match(new RegExp(`>${outcome}<`, "g"))?.length, 1);
    assert.match(html, /00:03/);
    assert.match(html, /waited /); assert.match(html, /01:12/);
    // Collapsed: output stays folded away.
    assert.doesNotMatch(html, /latest/);
    const open = renderLine({ id: "mt_a1b2c3d4", state: "running", command: "npm test", outputTail: "latest", waitOutcome: outcome, waitedSeconds: 72 });
    assert.match(open, /latest/);
    assert.doesNotMatch(html, /LIVE OUTPUT|>OUTPUT</);
  }
});
