import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2], counts = new Map();
const append = (file, obj) => fs.appendFileSync(path.join(dir, file), JSON.stringify({ at: Date.now(), ...obj }) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function tasks() {
  try { return fs.readdirSync(path.join(dir, 'tasks')).flatMap(owner => fs.readdirSync(path.join(dir, 'tasks', owner)).filter(f => f.endsWith('.meta.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, 'tasks', owner, f))))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function completedTask() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const found = tasks().find(t => t.state === 'completed'); if (found) return found; await sleep(10); }
  throw new Error('Completed control did not reach disk');
}
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  try {
    const body = JSON.parse(raw);
    if (req.url === '/work') {
      const { kind, id, phase } = body;
      if (!['completed', 'unfinished'].includes(kind)) throw new Error('Invalid synthetic work kind');
      append('tool-http.jsonl', { event: 'work_started', phase, id, kind, body });
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        append('tool-http.jsonl', { event: 'work_finished', phase, id, kind });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: kind === 'completed' ? 'RESTART_CONTROL_RESULT_V014' : 'UNEXPECTED_UNFINISHED_RESULT', synthetic: true, kind }));
      }, kind === 'completed' ? 100 : 120000);
      res.on('close', () => { clearTimeout(timer); append('tool-http.jsonl', { event: 'connection_closed', phase, id, kind, finished }); });
      return;
    }
    const phase = req.url.split('/')[1];
    if (!['before', 'after'].includes(phase)) throw new Error('Invalid provider phase');
    const n = (counts.get(phase) || 0) + 1; counts.set(phase, n);
    append('mock-http.jsonl', { event: 'request', phase, n, authorizationIsLocalStub: req.headers.authorization === 'Bearer localstubkey', body });
    if (n > 12) throw new Error('Request safety limit exceeded');
    let tool, text;
    if (phase === 'before') {
      if (n === 1) tool = ['fixture_restart_bg', { kind: 'completed', __background__: 'yes' }];
      else if (n === 2) tool = ['bg_task', { action: 'result', id: (await completedTask()).id }];
      else if (n === 3) tool = ['fixture_restart_bg', { kind: 'unfinished', __background__: 'yes' }];
      else text = 'READY_FOR_PLANNED_PROCESS_CRASH';
    } else {
      const all = tasks(), incomplete = all.find(t => !t.endedAt), complete = all.find(t => t.state === 'completed');
      if (!incomplete || !complete) throw new Error('Missing persisted control/incomplete records');
      if (n === 1) tool = ['bg_task', { action: 'list' }];
      else if (n === 2) tool = ['bg_task', { action: 'status', id: incomplete.id }];
      else if (n === 3) tool = ['bg_task', { action: 'result', id: incomplete.id }];
      else if (n === 4) tool = ['bg_task', { action: 'cancel', id: incomplete.id }];
      else if (n === 5) tool = ['bg_task', { action: 'result', id: complete.id }];
      else if (n === 6) tool = ['bg_task', { action: 'status', id: incomplete.id }];
      else text = 'RESTART_PROBES_DONE';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const base = { id: `chatcmpl-restart-${phase}-${n}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    chunk({ role: 'assistant', content: '' });
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `restart_${phase}_${n}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: text }); chunk({}, 'stop'); }
    res.write('data: [DONE]\n\n'); res.end();
    append('mock-http.jsonl', { event: 'response', phase, n, tool, text });
  } catch (error) {
    append('mock-http.jsonl', { event: 'error', message: String(error) });
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'mock-port.txt'), String(server.address().port)));
