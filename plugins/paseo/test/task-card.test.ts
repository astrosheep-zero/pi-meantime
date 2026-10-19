import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ stdin: { contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MeantimeTaskCard} from './client/task-card.tsx';
export function render(data) {
 return renderToStaticMarkup(<MeantimeTaskCard item={{data}} theme={{colors:{surface0:'#fff',foreground:'#111',foregroundMuted:'#777',border:'#ccc',statusWarning:'#b7791f',statusDanger:'#c2412d'}}} layout={{compact:true,platform:'web'}}/>);
}`, loader: "tsx", resolveDir: new URL("..", import.meta.url).pathname },
  bundle: true, write: false, platform: "node", format: "cjs", alias: { "react-native": "react-native-web" },
  define: { "process.env.NODE_ENV": '"production"' } });
// Bundled CJS keeps React's node builtins available without writing build artifacts.
const { createRequire } = await import("node:module");
const module = { exports: {} as { render?: (data: unknown) => string } };
new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
const render = module.exports.render!;

test("actual handle card says started even if launch snapshot said running", () => {
  const html = render({ source: "handle", phase: "complete", tasks: [{ id: "mt_a1b2c3d4", state: "running", command: "npm test", createdAt: 1000 }] });
  assert.match(html, />started</);
  assert.doesNotMatch(html, /RUNNING|1 R|seen |LIVE|00:01|meantime|snapshots|mt_a1b2c3d4/);
  assert.match(html, /npm/);
});

test("actual sparse completion renders id and only the supplied result", () => {
  const html = render({ source: "completion", phase: "complete", tasks: [{ id: "mt_deadbeef", state: "failed" }] });
  assert.match(html, /mt_deadbeef/);
  assert.equal(html.match(/mt_deadbeef/g)?.length, 1);
  assert.match(html, /failed/);
  assert.doesNotMatch(html, /exit [01]|seen |00:00|bash/);
});

test("timeline tables lead with commands and keep bookkeeping out of the way", () => {
  const html = render({ source: "meantime", phase: "complete", tasks: [
    { id: "mt_a1b2c3d4", state: "completed", command: "npm test", exitCode: 0 },
    { id: "mt_deadbeef", state: "failed", command: "make test", exitCode: 1 },
  ] });
  assert.match(html, /aria-label="COMPLETED · exit 0"/);
  assert.match(html, /aria-label="FAILED · exit 1"/);
  assert.match(html, />done<\/div>/);
  assert.match(html, />failed<\/div>/);
  assert.doesNotMatch(html, />X0<\/div>|>E1<\/div>|meantime|snapshots|mt_a1b2c3d4|mt_deadbeef/);
});
