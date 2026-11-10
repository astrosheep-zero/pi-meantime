import assert from 'node:assert/strict';
import { test } from 'node:test';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { elapsedText, formatDuration, renderCompletion, renderMeantimeCall, renderTaskResult, stateGlyph } from '../src/render.ts';
import type { TaskDisplay } from '../src/render.ts';
import { FakePi } from './host.ts';
const plain = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text };
const render = (component: { render(width: number): string[] } | undefined, width = 100) => component?.render(width).map(line => line.trimEnd()).join('\n').trim() ?? '';
const done: TaskDisplay = { id: 'mt_a1b2c3d4', tool: 'bash', state: 'completed', command: 'npm test', createdAt: 1000, endedAt: 73000, exitCode: 0, output: '✔ all passed', outputTail: '✔ all passed', outputPath: '/tmp/result.log' };
const running: TaskDisplay = { id: 'mt_deadbeef', tool: 'bash', state: 'running', command: 'npm watch' };
const result = (details: unknown, action = 'list', expanded = false, isPartial = false) => render(renderTaskResult({ content: [], details }, { expanded, isPartial }, plain, { args: { action } }, false));

test('state glyphs distinguish outcomes and active states', () => {
  assert.deepEqual(['running', 'waiting', 'cancel_requested', 'completed', 'failed', 'cancelled', 'outcome_unknown'].map(state => stateGlyph(plain, state)), ['●', '●', '●', '✓', '✕', '⊘', '?']);
});
test('durations use seconds, minutes and hours without inventing recovered runtime', () => {
  assert.deepEqual([42, 72, 3720].map(formatDuration), ['42s', '1m12s', '1h02m']);
  assert.equal(elapsedText({ ...running, state: 'outcome_unknown', createdAt: 1 }), '');
});
test('completion and list cards retain task identity and output in expanded details', () => {
  assert.match(render(renderCompletion({ details: { tasks: [done] } }, { expanded: false }, plain)), /✓ npm test · 1m12s · a1b2\n\s+✔ all passed/);
  const expanded = render(renderCompletion({ details: { tasks: [done] } }, { expanded: true }, plain));
  for (const text of [done.id, done.command!, done.outputPath!, done.output!]) assert.ok(expanded.includes(text));
  assert.equal(renderCompletion({}, {}, plain), undefined);
});
test('call headers summarize actions and ids', () => {
  assert.equal(render(renderMeantimeCall({ action: 'wait', ids: [done.id], timeout: 30 }, plain)), 'meantime wait a1b2 · 30s');
});
test('installed handle renderer uses the configured timeout and distinct detach reasons', () => {
  const pi = new FakePi(), app = install(pi, { config: validateConfig({ autoDetachMs: 120000 }), connect: () => pi });
  const renderer = pi.renderers[0]!('meantime', () => undefined)!;
  for (const [reason, suffix] of [['timeout', ' (120s timeout)'], ['shortcut', ' (manual detach)'], ['steer', ' (steered)'], ['explicit', '']]) {
    const text = render(renderer.renderResult!({ content: [], details: { ...running, delivery: 'background', createdAt: 1, detachReason: reason } }, { expanded: false, isPartial: false }, plain as never, {} as never));
    assert.equal(text, `● running in background${suffix} · dead`);
  }
  void app.dispose();
});
test('pending siblings render alongside settled rows with wait outcomes', () => {
  const text = result({ tasks: [done], pending: [running], waitOutcome: 'timeout', waitedMs: 72000 }, 'wait');
  for (const fragment of ['✓ npm test', '● npm watch', 'timeout · waited 72s', '✔ all passed']) assert.ok(text.includes(fragment));
  assert.match(result({ tasks: [running], waitOutcome: 'interrupted', waitedMs: 2000 }, 'wait'), /interrupted · waited 2s/);
});
test('waiting and cancellation requests have readable active state labels', () => {
  assert.match(result({ tasks: [{ ...running, state: 'waiting' }] }), /waiting/);
  const text = result({ tasks: [{ ...running, state: 'cancel_requested' }] }, 'cancel', true);
  assert.match(text, /cancelling/);
  assert.match(text, /Cancellation was requested/);
  assert.match(result({ tasks: [{ ...done, state: 'cancelled', cancelRequestedAt: 1 }] }, 'cancel', true), /⊘ npm test/);
});
test('collapsed commands advertise hidden lines and expanded commands preserve the whole script', () => {
  const command = 'printf first\n  printf second\n' + 'long argument '.repeat(30);
  const task = { ...done, command };
  assert.match(result({ tasks: [task] }), /…\+2 lines/);
  const expanded = render(renderTaskResult({ content: [], details: { tasks: [task] } }, { expanded: true }, plain, { args: { action: 'list' } }, false), 1000);
  for (const line of command.split('\n')) assert.ok(expanded.includes(line.trimEnd()));
  assert.match(result({ tasks: [{ ...done, command: 'argument '.repeat(80) }] }), /…/);
});
test('existing non-shell code and args provide titles and complete details', () => {
  for (const fields of [{ tool: 'codemode', command: undefined, code: 'const x = 1;\nreturn x;' }, { tool: 'square', command: undefined, args: { square: 'fixture-square' } }]) {
    const text = result({ tasks: [{ ...done, ...fields }] }, 'list', true);
    assert.ok(text.includes(fields.tool));
    for (const line of (fields.code ?? 'fixture-square').split('\n')) assert.ok(text.includes(line));
  }
});
test('list pagination and notification failures remain actionable', () => {
  const text = result({ tasks: [{ ...done, notification: 'failed', notificationError: 'Delivery retry exhausted' }], total: 31, next_offset: 7 });
  assert.match(text, /\+24 more/);
  assert.match(text, /Delivery retry exhausted/);
});
test('streaming waits retain bounded latest output and progress fallback', () => {
  const tail = Array.from({ length: 25 }, (_, i) => `live ${i + 1}`).join('\n');
  assert.ok(result({ tasks: [{ ...running, outputTail: tail }] }, 'wait', false, true).endsWith(tail.split('\n').slice(-5).join('\n')));
  assert.ok(result({ tasks: [{ ...running, outputTail: tail }] }, 'wait', true, true).endsWith(tail.split('\n').slice(-20).join('\n')));
  assert.match(result({ tasks: [{ ...running, progress: 'latest update' }] }, 'wait', false, true), /latest update/);
});
test('text-only errors and terminal sanitization remain readable', () => {
  assert.equal(render(renderTaskResult({ content: [{ type: 'text', text: 'Unknown task' }] }, { expanded: false }, plain, {}, false)), 'Unknown task');
  assert.match(result({ tasks: [{ ...done, command: 'printf \u001b[2JSAFE' }] }), /printf SAFE/);
});
