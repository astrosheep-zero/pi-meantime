// Local-only actual RN-web component preview; no Paseo server/reload required.
// node scripts/render-a4.mjs [output-dir]
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? `${tmpdir()}/pi-meantime-a4`);
await mkdir(out, { recursive: true });
// Only the board's host API is stubbed. Both views and styles are real components.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MeantimeTaskCard} from './client/task-card.tsx';
import {MeantimeBoard} from './client/board.tsx';
const layout={compact:true,platform:'web'};
const tasks=[
 {id:'mt_9cec1234',tool:'bash',state:'running',command:'npm test -- --watch',createdAt:1000},
 {id:'mt_a1b21234',tool:'bash',state:'completed',command:'sleep 45 && echo done',createdAt:1000,endedAt:46000,exitCode:0},
 {id:'mt_dead1234',tool:'web_fetch',state:'failed',command:'curl https://api.example.com/v2/endpoint',createdAt:1000,endedAt:4000,exitCode:1},
 {id:'mt_beef1234',state:'started',command:'sleep 60'},
 {id:'mt_aaaa1234',state:'queued',command:'npm run build'},
 {id:'mt_bbbb1234',state:'cancelled',command:'sleep 120'},
 {id:'mt_cccc1234',state:'outcome_unknown',command:'make verify'}];
globalThis.previewTasks=tasks.filter(task=>task.state!=='queued');
const dark=new URLSearchParams(location.search).get('theme')==='dark';
const colors=dark?{surface0:'#0f1114',foreground:'#e4e7ec',foregroundMuted:'#899097',border:'#3a3c40',statusWarning:'#e9b45a',statusDanger:'#ef7d6b'}:
// Approximate washed-out host tokens, not measured screenshot samples.
 {surface0:'#ffffff',foreground:'#202124',foregroundMuted:'#b6b9be',border:'#f1f2f3',statusWarning:'#f1d9a4',statusDanger:'#eeb4ad'};
const theme={colors};
document.body.style.cssText='margin:0;background:'+colors.surface0+';color:'+colors.foreground+';font:10px monospace';
const card=(source,ts)=><MeantimeTaskCard item={{data:{source,tasks:ts,phase:'complete'}}} theme={theme} layout={layout}/>;
createRoot(document.getElementById('root')).render(<div style={{width:390,boxSizing:'border-box',padding:'24px'}}>
 <p>B5 · completion cards</p>{card('completion',tasks.slice(1,3))}
 <p>B5 · actual sparse receipts</p>{card('completion',[{id:'mt_a1b2c3d4',state:'completed',exitCode:0},{id:'mt_deadbeef',state:'failed'},{id:'mt_1234abcd',state:'cancelled'}])}
 <p>Board · actual component / stub timeline transport</p><MeantimeBoard agentId="preview" theme={theme} layout={layout}/>
</div>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root },
  outfile: `${out}/app.js`, bundle: true, platform: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "react-native": "react-native-web" },
  plugins: [{ name: "preview-host", setup(b) {
    b.onResolve({ filter: /^@getpaseo\/plugin\/client(?:\/react-native)?$/ }, args => ({ path: args.path, namespace: "preview" }));
    b.onLoad({ filter: /.*/, namespace: "preview" }, args => ({ loader: "js", resolveDir: root,
      contents: args.path.endsWith("react-native") ? `export {ScrollView} from 'react-native-web';` : `
const host={agents:{ref:()=>({timeline:{refetch:async()=>({entries:globalThis.previewTasks.map(task=>({item:{type:'tool_call',name:'meantime',status:'completed',detail:{type:'unknown',output:{details:{task:{tool:'bash',...task}}}}}})),hasOlder:false,error:null}),subscribe:()=>Object.assign(()=>{},{ready:Promise.resolve()})}})}};
export function usePaseo(){return host;}` }));
  }}] });
// shoot.ts uses a file URL; theme is baked into each document before loading JS.
for (const theme of ["light", "dark"]) {
  await writeFile(`${out}/${theme}.html`, `<!doctype html><meta charset="utf-8"><div id="root"></div><script>history.replaceState(null,'','?theme=${theme}')</script><script src="app.js"></script>`);
  const shot = spawnSync(process.execPath, ["scripts/shoot.ts", `${out}/${theme}.html`, `${out}/${theme}-390.png`, "390"], { cwd: root, encoding: "utf8" });
  if (shot.status !== 0) throw new Error(shot.stderr);
  console.log(shot.stdout.trim());
}
