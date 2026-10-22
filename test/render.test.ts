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
  return { fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Parameters<typeof renderCompletion>[2];
}
const plain = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderCompletion>[2];
const render = (component: { render(width: number): string[] } | undefined) =>
  component?.render(200).map(line => line.trimEnd()).join('\n') ?? '';

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
  assert.doesNotMatch(collapsed, /untrusted-output-tail/);
  assert.doesNotMatch(collapsed, /Output:/, 'collapsed card omits the output path');

  const expanded = render(renderCompletion(message, { expanded: true }, plain));
  assert.match(expanded, /bash · mt_a1b2c3d4/);
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
  assert.equal(render(renderMeantimeCall({ action: 'wait', ids: ['mt_a', 'mt_b'], timeout: 30 }, plain)), 'wait mt_a, mt_b · 30s');
  assert.equal(render(renderMeantimeCall({ action: 'cancel', ids: ['mt_a'] }, plain)), 'cancel mt_a');
  assert.equal(render(renderMeantimeCall({}, plain)), 'list');
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
  assert.match(render(handle), /● npm test · \d+s · mt_a1b2c3d4\n +background — \/meantime to inspect/);

  const list = renderTaskResult({ content: [{ type: 'text', text: 'Current session tasks…' }],
    details: { tasks: [done, failed], pending: [], next_offset: 40 } }, { expanded: false }, plain, {}, false);
  const text = render(list);
  assert.match(text, /✓ npm test · exit 0 · 12s · mt_a1b2c3d4/);
  assert.match(text, /✕ make release · exit 2 · 61s · mt_e5f60718/);
  assert.match(text, /More: offset=40/);
});

test('wait results show the glyph header plus the result body without the receipt line', () => {
  const wait = renderTaskResult({ content: [
    { type: 'text', text: 'Meantime mt_a1b2c3d4 completed (exit 0) — npm test' },
    { type: 'text', text: '✓ 42 passing\n✓ all good' },
  ], details: { ...done } }, { expanded: false }, plain, { args: { action: 'wait' } }, false);
  const text = render(wait);
  assert.match(text, /✓ npm test · exit 0 · 12s · mt_a1b2c3d4/);
  assert.match(text, /✓ 42 passing/);
  assert.doesNotMatch(text, /Meantime mt_a1b2c3d4 completed/, 'the receipt sentence is replaced by the header');
});

test('terminal control bytes in commands and tails never reach the terminal', () => {
  const hostile: TaskDisplay = { id: 'mt_deadbeef', tool: 'bash', state: 'completed',
    command: 'printf \u001b[2J\u001b[31mRED', outputTail: 'line\u001b[7mREVERSED' };
  const out = render(renderCompletion({ details: { taskIds: [hostile.id], tasks: [hostile] } }, { expanded: true }, plain));
  assert.ok(!out.includes('\u001b'), 'no escape bytes survive');
  assert.match(out, /printf/);
});
