import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Text } from '@earendil-works/pi-tui';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import { renderCompletion, renderMeantimeCall, renderTaskResult, stateGlyph } from '../src/render.ts';
import type { TaskDisplay } from '../src/render.ts';
import { FakePi, fixtureBash } from './host.ts';

/** Records the semantic color of every fragment: `[color]text`. */
function recordingTheme() {
  return { fg: (color: string, text: string) => `[${color}]${text}`, bg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Parameters<typeof renderCompletion>[2];
}
const plain = { fg: (_color: string, text: string) => text, bg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Parameters<typeof renderCompletion>[2];
const render = (component: { render(width: number): string[] } | undefined) =>
  component?.render(200).map(line => line.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '') ?? '';

const done: TaskDisplay = { id: 'mt_a1b2c3d4', tool: 'bash', state: 'completed', command: 'npm test',
  exitCode: 0, createdAt: 1_000, endedAt: 13_000, outputTail: '…\n✓ 42 passing', outputPath: '/tmp/out.txt' };
const failed: TaskDisplay = { id: 'mt_e5f60718', tool: 'bash', state: 'failed', command: 'make release',
  exitCode: 2, createdAt: 0, endedAt: 61_000 };
const cancelled: TaskDisplay = { id: 'mt_19202122', tool: 'bash', state: 'cancelled', command: 'sleep 99',
  cancelRequestedAt: 5, createdAt: 0, endedAt: 5_000 };

test('glyphs are the single state channel with semantic colors', () => {
  const theme = recordingTheme();
  assert.equal(stateGlyph(theme, 'completed'), '[success]✓');
  assert.equal(stateGlyph(theme, 'failed'), '[error]✕');
  assert.equal(stateGlyph(theme, 'cancelled'), '[muted]⊘');
  assert.equal(stateGlyph(theme, 'running'), '[accent]●');
  assert.equal(stateGlyph(theme, 'waiting'), '[accent]●');
  assert.equal(stateGlyph(theme, 'cancel_requested'), '[warning]●');
  assert.equal(stateGlyph(theme, 'outcome_unknown'), '[warning]?');
});

test('completion card answers what finished, how it ended and what it produced', () => {
  const message = { customType: 'meantime-completion', role: 'custom', display: true, timestamp: 0,
    content: 'Meantime mt_a1b2c3d4 completed (exit 0)\nAutomated background completion — not user input or approval.',
    details: { taskIds: [done.id], tasks: [done] } };
  const collapsed = render(renderCompletion(message, { expanded: false }, plain));
  assert.match(collapsed, /✓ npm test · exit 0 · 12s · mt_a1b2c3d4/);
  assert.match(collapsed, /✓ 42 passing/, 'a single-task card shows a tail glimpse');
  assert.doesNotMatch(collapsed, /Automated background completion/, 'model-directed boilerplate is not displayed');
  assert.doesNotMatch(collapsed, /untrusted-output/);
  assert.doesNotMatch(collapsed, /Output:/, 'collapsed card omits the output path');

  const expanded = render(renderCompletion(message, { expanded: true }, plain));
  assert.doesNotMatch(expanded, /^\s*bash$/m, 'a bash task needs no tool label under its command');
  assert.match(expanded, /Output: \/tmp\/out\.txt/);
});

test('multi-task completion cards stay one line per task; failure and cancellation read at a glance', () => {
  const message = { details: { taskIds: [done.id, failed.id, cancelled.id], tasks: [done, failed, cancelled] } };
  const collapsed = render(renderCompletion(message as never, { expanded: false }, recordingTheme()));
  assert.match(collapsed, /\[success\]✓/);
  assert.match(collapsed, /\[error\]✕ make release/);
  assert.doesNotMatch(collapsed, /✓ 42 passing/, 'no tails compete in a batch card');
  const expanded = render(renderCompletion(message as never, { expanded: true }, recordingTheme()));
  assert.match(expanded, /\[warning\] +Cancellation was requested/);
  assert.match(expanded, /exit 2 · 61s/);
});

test('completion renderer declines messages without task metadata', () => {
  assert.equal(renderCompletion({ details: undefined }, { expanded: false }, plain), undefined);
  assert.equal(renderCompletion({ details: { taskIds: [] } }, { expanded: false }, plain), undefined);
});

test('meantime call rows summarize the action instead of raw JSON', () => {
  assert.equal(render(renderMeantimeCall({ action: 'wait', ids: ['mt_a', 'mt_b'], timeout: 30 }, plain)), 'meantime wait mt_a, mt_b · 30s');
  assert.equal(render(renderMeantimeCall({ action: 'cancel', ids: ['mt_a'] }, plain)), 'meantime cancel mt_a');
  assert.equal(render(renderMeantimeCall({}, plain)), 'meantime list');
});

test('install registers the completion message renderer', async () => {
  const pi = new FakePi();
  pi.registerTool(fixtureBash(process.cwd()));
  const instance = install(pi, { config: validateConfig({}), connect: () => pi });
  try {
    assert.equal(typeof pi.messageRenderers.get('meantime-completion'), 'function');
  } finally { await instance.dispose(); }
});

test('handle and list results keep one scannable line per task', () => {
  const handle = renderTaskResult({ content: [{ type: 'text', text: 'Meantime mt_a1b2c3d4 running in background…' }],
    details: { id: done.id, tool: done.tool, state: 'running', command: done.command,
      delivery: 'background', createdAt: Date.now() - 12_000 } }, { expanded: false }, plain, {}, true);
  assert.equal(render(handle), '● running in background · mt_a1b2c3d4',
    'the native call header already shows the command');
  const expanded = renderTaskResult({ content: [], details: { id: done.id, tool: done.tool, state: 'running',
    command: done.command, delivery: 'background', createdAt: Date.now() - 12_000 } }, { expanded: true }, plain, {}, true);
  assert.match(render(expanded), /● npm test · \d+s · mt_a1b2c3d4/, 'expanding still reveals the command');

  const list = renderTaskResult({ content: [{ type: 'text', text: 'Current session tasks…' }],
    details: { tasks: [{ ...done, notification: 'observed' }, { ...failed, notification: 'delivered' }], total: 10, pending: [], next_offset: 40 } }, { expanded: false }, recordingTheme(), {}, false);
  const text = render(list);
  assert.match(text, /\[muted\]Background tasks \(10\)/);
  assert.match(text, /\[muted\]✓ npm test\[dim\] · exit 0 · 12s · observed · mt_a1b2c3d4/);
  assert.match(text, /\[muted\]✕ make release\[dim\] · exit 2 · 61s · delivered · mt_e5f60718/);
  assert.match(text, /More: offset=40/);
});

test('collapsed list rows stay one line per task while expanded rows use detail blocks', () => {
  const result = { content: [{ type: 'text', text: 'Current session tasks…' }],
    details: { tasks: [done, failed], pending: [], next_offset: 0 } };
  const collapsed = render(renderTaskResult(result, { expanded: false }, plain, {}, false));
  assert.equal(collapsed.split('\n').filter(line => line.includes('mt_a1b2c3d4')).length, 1, 'one row per task');
  assert.doesNotMatch(collapsed, /42 passing/, 'collapsed rows carry no output tail');
  assert.doesNotMatch(collapsed, /Output:/, 'collapsed rows carry no output path');

  const expanded = render(renderTaskResult(result, { expanded: true }, plain, {}, false));
  assert.match(expanded, /✓ npm test · exit 0 · 12s · mt_a1b2c3d4\n  Output: \/tmp\/out\.txt\n  …\n  ✓ 42 passing/,
    'expanded rows render the output path and tail per task');
  assert.match(expanded, /✕ make release · exit 2 · 61s · mt_e5f60718/, 'every task gets its own detail block');
});

test('wait results show the glyph header plus the structured output from details without regex scraping', () => {
  const wait = renderTaskResult({ content: [
    { type: 'text', text: 'mt_a1b2c3d4 · completed · exit 0 · 12s\n$ npm test' },
    { type: 'text', text: '✓ 42 passing\n✓ all good' },
  ], details: { ...done, output: '✓ 42 passing\n✓ all good' } }, { expanded: false }, plain, { args: { action: 'wait' } }, false);
  const text = render(wait);
  assert.match(text, /✓ npm test · exit 0 · 12s · mt_a1b2c3d4/);
  assert.match(text, /✓ 42 passing/);
  assert.doesNotMatch(text, /\$ npm test/, 'the receipt header is not duplicated');
});

test('multi-task waits render each task row and its structured output from details', () => {
  const wait = renderTaskResult({ content: [
    { type: 'text', text: 'mt_a1b2c3d4 · completed · exit 0 · 12s\n$ npm test\n✓ 42 passing' },
    { type: 'text', text: 'mt_e5f60718 · failed · exit 2 · 61s\n$ make release\nNo retained result.' },
    { type: 'text', text: 'Pending: (none)' },
  ], details: { tasks: [{ ...done, output: '✓ 42 passing' }, { ...failed }, { ...cancelled, output: 'FINAL' }], pending: [] } },
  { expanded: false }, plain, { args: { action: 'wait' } }, false);
  const text = render(wait);
  assert.equal(text, ['✓ npm test · exit 0 · 12s · mt_a1b2c3d4', '✕ make release · exit 2 · 61s · mt_e5f60718',
    '⊘ sleep 99 · 5s · mt_19202122', '', '✓ 42 passing', 'FINAL'].join('\n'), 'a blank line separates status rows from output');
});

test('partial wait results render task rows without receipt prose when no output exists', () => {
  const streaming: TaskDisplay = { id: 'mt_a1b2c3d4', tool: 'bash', state: 'waiting',
    command: 'npm test', createdAt: Date.now() - 12_000 };
  const partial = renderTaskResult({ content: [{ type: 'text', text: 'Meantime mt_a1b2c3d4 waiting — npm test' }],
    details: { tasks: [streaming] } },
  { expanded: false, isPartial: true }, plain, { args: { action: 'wait' } }, false);
  assert.equal(render(partial), '● npm test · 12s · mt_a1b2c3d4', 'streaming rows do not repeat the receipt prose');
});

test('partial wait results show a bounded live tail with progress fallback and sanitized output', () => {
  const tail = Array.from({ length: 25 }, (_, index) => `live ${index + 1}`).join('\n');
  const task: TaskDisplay = { id: 'mt_a1b2c3d4', tool: 'bash', state: 'waiting', command: 'npm test',
    outputTail: '\u001b[2J' + tail, progress: 'older progress', output: 'final output' };
  const partial = (expanded: boolean, entry = task) => render(renderTaskResult({ content: [], details: { tasks: [entry] } },
    { expanded, isPartial: true }, plain, { args: { action: 'wait' } }, false));
  assert.equal(partial(false), ['● npm test · mt_a1b2c3d4', '', ...tail.split('\n').slice(-5)].join('\n'));
  assert.equal(partial(true), ['● npm test · mt_a1b2c3d4', '', ...tail.split('\n').slice(-20)].join('\n'));
  assert.match(partial(false, { ...task, outputTail: undefined, progress: 'fallback\nnewest' }), /fallback\nnewest$/);
  const final = render(renderTaskResult({ content: [], details: { tasks: [task] } },
    { expanded: false }, plain, { args: { action: 'wait' } }, false));
  assert.match(final, /final output$/);
});

test('collapsed handle rows attribute the detach trigger concisely', () => {
  const row = (detachReason?: string) => render(renderTaskResult({ content: [],
    details: { id: done.id, tool: 'bash', state: 'running', command: 'npm test', delivery: 'background',
      createdAt: Date.now() - 12_000, ...(detachReason ? { detachReason } : {}) } }, { expanded: false }, plain, {}, true));
  assert.equal(row(undefined), '● running in background · mt_a1b2c3d4');
  assert.equal(row('explicit'), '● running in background · mt_a1b2c3d4');
  assert.equal(row('timeout'), '● running in background (90s auto-detach) · mt_a1b2c3d4');
  assert.equal(row('shortcut'), '● running in background (detached) · mt_a1b2c3d4');
  assert.equal(row('steer'), '● running in background (detached) · mt_a1b2c3d4');
});

test('a settled receipt without a retained result has no machine prose left to display', () => {
  const wait = renderTaskResult({ content: [{ type: 'text', text: 'Meantime mt_e5f60718 failed (exit 2) — make release\nNo retained result.' }],
    details: { tasks: [{ ...failed }], pending: [] } }, { expanded: false }, plain, { args: { action: 'wait' } }, false);
  assert.equal(render(wait), '✕ make release · exit 2 · 61s · mt_e5f60718');
});

test('terminal control bytes in commands and tails never reach the terminal', () => {
  const hostile: TaskDisplay = { id: 'mt_deadbeef', tool: 'bash', state: 'completed',
    command: 'printf \u001b[2J\u001b[31mRED', outputTail: 'line\u001b[7mREVERSED' };
  const out = render(renderCompletion({ details: { taskIds: [hostile.id], tasks: [hostile] } }, { expanded: true }, plain));
  assert.ok(!out.includes('\u001b'), 'no escape bytes survive');
  assert.match(out, /printf/);
});
