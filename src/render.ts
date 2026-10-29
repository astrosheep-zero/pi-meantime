import { Box, Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import { keyHint } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { isRecord } from './schema.ts';
import { truncateUtf8 } from './store.ts';

/** Task-shaped display data; details payloads arrive as plain JSON. */
export interface TaskDisplay {
  id: string; tool: string; state: string; command?: string;
  createdAt?: number; endedAt?: number; exitCode?: number;
  output?: string; outputPath?: string; outputTail?: string; cancelRequestedAt?: number;
  detachReason?: string;
  notification?: string;
  isError?: boolean;
}
export type RenderTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;
interface ResultLike { content: { type: string; text?: string }[] }
interface RenderOptions { expanded?: boolean; isPartial?: boolean; outputPad?: number }

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
export function stateGlyph(theme: RenderTheme, state: string, quiet = false): string {
  const [glyph, color] = GLYPHS[state] ?? ['·', 'muted'];
  return theme.fg(quiet ? 'muted' : color, glyph);
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
function isAcknowledged(task: TaskDisplay): boolean {
  return task.notification === 'observed' || task.notification === 'delivered';
}
function meta(task: TaskDisplay, withId: boolean, showAck = false): string {
  return [
    ...(task.exitCode !== undefined ? [`exit ${task.exitCode}`] : []),
    ...(elapsedText(task) ? [elapsedText(task)] : []),
    ...(showAck && isAcknowledged(task) ? [task.notification!] : []),
    ...(withId ? [task.id] : []),
  ].join(' · ');
}
/** Collapsed row: glyph, what it is, then dim facts. */
export function taskLine(task: TaskDisplay, theme: RenderTheme, withId = true, quiet = false): string {
  const facts = meta(task, withId, quiet);
  return `${stateGlyph(theme, task.state, quiet)} ${commandLabel(task)}${facts ? theme.fg('dim', ` · ${facts}`) : ''}`;
}
function tailLines(tail: string): string[] {
  return clean(tail).trimEnd().split('\n').filter(line => line.trim().length > 0);
}
function detailBlock(task: TaskDisplay, theme: RenderTheme, tail: string[] | undefined, tailBudget: number): string[] {
  const lines = [taskLine(task, theme)];
  // The row already names a command-less tool; bash needs no label at all.
  if (task.command !== undefined && task.tool !== 'bash') lines.push(theme.fg('dim', `  ${task.tool}`));
  if (task.outputPath) lines.push(theme.fg('muted', `  Output: ${task.outputPath}`));
  if (task.cancelRequestedAt !== undefined) lines.push(theme.fg('warning', '  Cancellation was requested; the native outcome may not be settled.'));
  if (tail?.length) lines.push(...tail.slice(-tailBudget).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`)));
  return lines;
}

/** Chat card for a persisted completion notice. Model-directed boilerplate in
 * message.content is deliberately not shown; display answers what finished,
 * how it ended and what it produced. */
export function renderCompletion(message: { details?: unknown }, options: RenderOptions, theme: RenderTheme): Box | undefined {
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
  // Same chrome as Pi's own custom messages: padded, on the message background.
  const box = new Box(options.outputPad ?? 1, 1, text => theme.bg('customMessageBg', text));
  box.addChild(new Text(blocks.join('\n'), 0, 0));
  return box;
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
    const what = task.state === 'running' ? 'running in background' : 'background';
    if (!options.expanded) return new Text(`\n${stateGlyph(theme, task.state)} ${theme.fg('dim', `${what}${reason} · ${task.id}`)}`, 0, 0);
    return new Text(`\n${detailBlock(task, theme, undefined, 0).join('\n')}`, 0, 0);
  }
  const isWait = isRecord(context.args) && context.args.action === 'wait';
  const lines: string[] = [];
  if (isWait && tasks.length) {
    for (const task of tasks) lines.push(taskLine(task, theme));
    if (!options.isPartial) {
      const body = tasks.flatMap(task => typeof task.output === 'string' ? tailLines(task.output) : []);
      const shown = options.expanded ? body : body.slice(0, 10);
      // A blank line keeps the status rows apart from the process's own output.
      if (shown.length) lines.push('', ...shown.map(line => theme.fg('toolOutput', line)));
      const remaining = body.length - shown.length;
      if (remaining > 0) lines.push(theme.fg('muted', `… ${remaining} more lines, ${keyHint('app.tools.expand', 'to expand')}`));
    }
  } else if (page && tasks.length) {
    const isCancel = isRecord(context.args) && context.args.action === 'cancel';
    if (!isCancel) {
      const total = typeof details?.total === 'number' ? details.total : tasks.length;
      lines.push(theme.fg('muted', `Background tasks (${total})`));
    }
    if (!options.expanded) lines.push(...tasks.map(task => taskLine(task, theme, true, !isCancel && task.state !== 'running' && task.state !== 'waiting' && task.state !== 'cancel_requested')));
    else for (const task of tasks) {
      const tail = typeof task.outputTail === 'string' ? tailLines(task.outputTail) : [];
      lines.push(...detailBlock(task, theme, tail, 40));
    }
  }
  if (isRecord(details) && details.next_offset != null) lines.push(theme.fg('muted', `More: offset=${details.next_offset}`));
  if (!lines.length) {
    const fallback = result.content.filter(b => b.type === 'text' && typeof b.text === 'string').flatMap(b => tailLines(b.text!));
    lines.push(...fallback.map(line => theme.fg('toolOutput', line)));
  }
  return new Text(`\n${lines.join('\n')}`, 0, 0);
}

/** Call header in Pi's tool language: **meantime** `wait mt_a, mt_b · 30s`, not raw JSON. */
export function renderMeantimeCall(args: unknown, theme: RenderTheme): Text {
  const action = isRecord(args) && typeof args.action === 'string' ? args.action : 'list';
  const ids = isRecord(args) && Array.isArray(args.ids) ? args.ids.filter(id => typeof id === 'string').join(', ') : '';
  const timeout = isRecord(args) && typeof args.timeout === 'number' ? ` · ${args.timeout}s` : '';
  return new Text(`${theme.fg('toolTitle', theme.bold('meantime'))} ${theme.fg('accent', action)}${ids ? ` ${ids}` : ''}${theme.fg('dim', timeout)}`, 0, 0);
}
