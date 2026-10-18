import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]); const states = new Map();
function log(s, event) { fs.appendFileSync(path.join(root, s, 'mock-http.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n'); }
function tasks(s) {
  try { return fs.readdirSync(path.join(root, s, 'tasks')).flatMap(owner => fs.readdirSync(path.join(root, s, 'tasks', owner))
    .filter(file => file.endsWith('.meta.json')).map(file => JSON.parse(fs.readFileSync(path.join(root, s, 'tasks', owner, file))))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const scenario = req.url.split('/')[1];
  try {
    const body = JSON.parse(raw); const state = states.get(scenario) ?? { n: 0, read: false }; states.set(scenario, state);
    const n = ++state.n; log(scenario, { event: 'request', n, body, authorizationIsLocalStub: req.headers.authorization === 'Bearer localstubkey' });
    if (n > 10) throw new Error('Too many fixture provider calls');
    let tool; let text;
    if (n === 1) tool = ['mcp__parity__cooperative_mt', { ms: 600, __meantime__: scenario.includes('_auto_') ? 'auto' : 'yes' }];
    else if (scenario.endsWith('_deny')) text = 'PERMISSION_DENIED_DONE';
    else if (tasks(scenario).some(task => task.endedAt) && !state.read) {
      state.read = true; tool = ['meantime', { action: 'result', id: tasks(scenario)[0].id }];
    } else text = state.read ? 'PERMISSION_ALLOW_DONE' : 'PERMISSION_ALLOW_WAIT';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: `chatcmpl-${scenario}-${n}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant', content: '' });
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `call_${scenario}_${n}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: text }); chunk({}, 'stop'); }
    res.write('data: [DONE]\n\n'); res.end(); log(scenario, { event: 'response', n, tool, text });
  } catch (error) { log(scenario, { event: 'error', message: String(error) }); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[3], String(server.address().port)));
