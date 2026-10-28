import { Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import { keyHint } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { isRecord } from './schema.ts';
import { truncateUtf8 } from './store.ts';

/** Task-shaped display data; details payloads arrive as plain JSON. */
export interface TaskDisplay {
  id: string; tool: string; state: string; command?: string;
  createdAt?: number; endedAt?: number; exitCode?: number;
  outputPath?: string; outputTail?: string; cancelRequestedAt?: number;
  detachReason?: string;
  isError?: boolean;
}
export type RenderTheme = Pick<Theme, 'fg'>;
interface ResultLike { content: { type: string; text?: string }[] }
interface RenderOptions { expanded?: boolean; isPartial?: boolean }

// One semantic channel: the glyph carries state, color only supports it.
const GLYPHS: Record<string, [glyph: string, color: ThemeColor]> = {
  running: ['●', 'accent'],
  waiting: ['●', 'accent'],
  cancel_requested: ['●', 'warning'],
  completed: ['✓', 'success'],
  failed: ['✕', 'error'],
  cancelled: ['⊘', 'muted'],
  outcome_unknown: ['?', 'warning'],
};
export function stateGlyph(theme: RenderTheme, state: string): string {
  const [glyph, color] = GLYPHS[state] ?? ['·', 'muted'];
  return theme.fg(color, glyph);
}

/** Display text must never carry terminal control from tool output. */
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFF9-\uFFFB\r]/g, '');
}
function commandLabel(task: TaskDisplay): string {
  return task.command !== undefined
    ? truncateUtf8(clean(task.command).replace(/\s+/g, ' ').trim(), 96) : task.tool;
}
export function elapsedText(task: TaskDisplay): string {
  if (task.createdAt === undefined) return '';
  return `${Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.createdAt) / 1000))}s`;
}
function meta(task: TaskDisplay, withId: boolean): string {
  return [
    ...(task.exitCode !== undefined ? [`exit ${task.exitCode}`] : []),
    ...(elapsedText(task) ? [elapsedText(task)] : []),
    ...(withId ? [task.id] : []),
  ].join(' · ');
}
/** Collapsed row: glyph, what it is, then dim facts. */
export function taskLine(task: TaskDisplay, theme: RenderTheme, withId = true): string {
  const facts = meta(task, withId);
  return `${stateGlyph(theme, task.state)} ${commandLabel(task)}${facts ? theme.fg('dim', ` · ${facts}`) : ''}`;
}
function tailLines(tail: string): string[] {
  return clean(tail).trimEnd().split('\n').filter(line => line.trim().length > 0);
}
function detailBlock(task: TaskDisplay, theme: RenderTheme, tail: string[] | undefined, tailBudget: number): string[] {
  const lines = [taskLine(task, theme),
    theme.fg('dim', `  ${task.tool}`)];
  if (task.outputPath) lines.push(theme.fg('muted', `  Output: ${task.outputPath}`));
  if (task.cancelRequestedAt !== undefined) lines.push(theme.fg('warning', '  Cancellation was requested; the native outcome may not be settled.'));
  if (tail?.length) lines.push(...tail.slice(-tailBudget).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`)));
  return lines;
}

/** Chat card for a persisted completion notice. Model-directed boilerplate in
 * message.content is deliberately not shown; display answers what finished,
 * how it ended and what it produced. */
export function renderCompletion(message: { details?: unknown }, options: RenderOptions, theme: RenderTheme): Text | undefined {
  const details = isRecord(message.details) ? message.details : undefined;
  const tasks = (Array.isArray(details?.tasks) ? details.tasks : []).filter(isRecord) as unknown as TaskDisplay[];
  if (!tasks.length) return undefined;
  const blocks: string[] = [];
  for (const task of tasks) {
    const tail = typeof task.outputTail === 'string' ? tailLines(task.outputTail) : [];
    if (options.expanded) blocks.push(...detailBlock(task, theme, tail, 40));
    else {
      blocks.push(taskLine(task, theme));
      // A tail glimpse only helps when one task owns the card.
      if (tasks.length === 1 && tail.length) blocks.push(...tail.slice(-2).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`)));
    }
  }
  return new Text(blocks.join('\n'), 0, 0);
}

/** Extract task snapshots from a result's control details, in display order.
 * Native details live under `nativeDetails`, so no native key reads as a task. */
function resultTasks(details: unknown): { tasks: TaskDisplay[]; page: boolean } {
  if (!isRecord(details)) return { tasks: [], page: false };
  if (Array.isArray(details.tasks)) return { tasks: details.tasks.filter(isRecord) as unknown as TaskDisplay[], page: true };
  if (isRecord(details.task)) return { tasks: [details.task as unknown as TaskDisplay], page: true };
  if (typeof details.id === 'string' && typeof details.state === 'string') return { tasks: [details as unknown as TaskDisplay], page: false };
  return { tasks: [], page: false };
}
/** Remove machine receipt lines, model-only directives and untrusted-data fences;
 * the glyph header replaces the receipt visually. */
function resultBody(result: ResultLike): string[] {
  const text = result.content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => clean(block.text!)).join('\n');
  return text
    .replace(/^Meantime mt_[a-f0-9]{8}[^\n]*$/gm, '')
    .replace(/^(?:No retained result\.|Result is not available\. Do not relaunch the operation\.)$/gm, '')
    .replace(/^Pending: .*$/gm, '')
    .replace(/^<\/?untrusted-output[^>]*>$/gm, '')
    .split('\n')
    .filter(line => line.trim().length > 0);
}

/** Result rendering for meantime itself and for managed tools that returned a
 * background handle. Everything else belongs to the native renderer. */
export function renderTaskResult(result: ResultLike & { details?: unknown }, options: RenderOptions & { expanded: boolean },
  theme: RenderTheme, context: { args?: unknown }, isHandle: boolean): Text {
  const details = isRecord(result.details) ? result.details : undefined;
  const { tasks, page } = resultTasks(details);
  if (isHandle && tasks[0]) {
    const task = tasks[0];
    const reason = task.detachReason === 'timeout' ? ' (90s auto-detach)'
      : task.detachReason === 'shortcut' || task.detachReason === 'steer' ? ' (detached)' : '';
    // The native call header already renders the command; don't repeat it here.
    if (!options.expanded) return new Text(`${stateGlyph(theme, task.state)} ${theme.fg('dim', `background${reason} · ${task.id}`)}`, 0, 0);
    return new Text(detailBlock(task, theme, undefined, 0).join('\n'), 0, 0);
  }
  const isWait = isRecord(context.args) && context.args.action === 'wait';
  const lines: string[] = [];
  if (isWait && tasks.length) {
    for (const task of tasks) lines.push(taskLine(task, theme));
    // A streaming update has no new body yet; showing the receipt prose would
    // duplicate the task rows above it.
    if (!options.isPartial) {
      const body = resultBody(result);
      const shown = options.expanded ? body : body.slice(0, 10);
      lines.push(...shown.map(line => theme.fg('toolOutput', line)));
      const remaining = body.length - shown.length;
      if (remaining > 0) lines.push(theme.fg('muted', `… ${remaining} more lines, ${keyHint('app.tools.expand', 'to expand')}`));
    }
  } else if (page && tasks.length) {
    if (!options.expanded) lines.push(...tasks.map(task => taskLine(task, theme)));
    else for (const task of tasks) {
      const tail = typeof task.outputTail === 'string' ? tailLines(task.outputTail) : [];
      lines.push(...detailBlock(task, theme, tail, 40));
    }
  }
  if (isRecord(details) && details.next_offset != null) lines.push(theme.fg('muted', `More: offset=${details.next_offset}`));
  if (!lines.length) lines.push(...resultBody(result).map(line => theme.fg('toolOutput', line)));
  return new Text(lines.join('\n'), 0, 0);
}

/** Compact call row: `wait mt_a, mt_b · 30s` instead of raw JSON arguments. */
export function renderMeantimeCall(args: unknown, theme: RenderTheme): Text {
  const action = isRecord(args) && typeof args.action === 'string' ? args.action : 'list';
  const ids = isRecord(args) && Array.isArray(args.ids) ? args.ids.filter(id => typeof id === 'string').join(', ') : '';
  const timeout = isRecord(args) && typeof args.timeout === 'number' ? ` · ${args.timeout}s` : '';
  return new Text(`${theme.fg('accent', action)}${ids ? ` ${ids}` : ''}${theme.fg('dim', timeout)}`, 0, 0);
}
