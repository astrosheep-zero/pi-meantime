import { Box, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { keyHint } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { isRecord } from './schema.ts';
import { truncateUtf8 } from './store.ts';

export interface TaskDisplay {
  id: string; tool: string; state: string; command?: string; code?: string; args?: Record<string, unknown>;
  createdAt?: number; endedAt?: number; exitCode?: number;
  output?: string; outputPath?: string; outputTail?: string; progress?: string; cancelRequestedAt?: number;
  detachReason?: string; notification?: string; notificationError?: string; isError?: boolean;
}
export type RenderTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;
interface ResultLike { content: { type: string; text?: string }[] }
interface RenderOptions { expanded?: boolean; isPartial?: boolean; outputPad?: number }
const GLYPHS: Record<string, [glyph: string, color: ThemeColor]> = {
  running: ['●', 'accent'], waiting: ['●', 'accent'], cancel_requested: ['●', 'warning'],
  completed: ['✓', 'success'], failed: ['✕', 'error'], cancelled: ['⊘', 'muted'], outcome_unknown: ['?', 'warning'],
};
export function stateGlyph(theme: RenderTheme, state: string, quiet = false): string {
  const [glyph, color] = GLYPHS[state] ?? ['·', 'muted'];
  return theme.fg(quiet ? 'muted' : color, glyph);
}
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFF9-\uFFFB\r]/g, '');
}
export function shortId(id: string): string { return id.replace(/^mt_/, '').slice(0, 4); }
export function formatDuration(seconds: number): string {
  seconds = Math.max(0, Math.floor(seconds));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
}
function active(task: TaskDisplay): boolean { return ['running', 'waiting', 'cancel_requested'].includes(task.state); }
export function elapsedText(task: TaskDisplay): string {
  if (task.createdAt === undefined || (!active(task) && task.endedAt === undefined)) return '';
  return formatDuration(((task.endedAt ?? Date.now()) - task.createdAt) / 1000);
}
/** Use only display data already present in the snapshot; never infer arguments. */
export function taskCommand(task: TaskDisplay): string | undefined {
  const arg = task.args?.code ?? Object.values(task.args ?? {})[0];
  return task.command ?? task.code ?? (typeof arg === 'string' ? arg : arg === undefined ? undefined : JSON.stringify(arg));
}
function commandLabel(task: TaskDisplay, theme: RenderTheme, width: number): string {
  const raw = clean(taskCommand(task) ?? ''), parts = raw.split('\n');
  const title = [task.command === undefined ? task.tool : '', parts[0]!.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ');
  const hint = parts.length > 1 ? ` …+${parts.length - 1} lines` : '';
  return truncateToWidth(title, Math.max(1, width - visibleWidth(hint)), '…') + theme.fg('dim', hint);
}
export function taskLine(task: TaskDisplay, theme: RenderTheme, withId = true, quiet = false, width = 100): string {
  const facts = [task.exitCode !== undefined && (task.exitCode !== 0 || task.state !== 'completed') ? `exit ${task.exitCode}` : '',
    elapsedText(task), withId ? shortId(task.id) : '', task.state === 'waiting' ? 'waiting' : task.state === 'cancel_requested' ? 'cancelling' : '',
    task.notificationError ?? (task.notification === 'failed' ? 'notification failed' : '')].filter(Boolean).join(' · ');
  const suffix = facts ? ` · ${facts}` : '';
  return truncateToWidth(`${stateGlyph(theme, task.state, quiet)} ${commandLabel(task, theme, width - visibleWidth(suffix) - 2)}${theme.fg('dim', suffix)}`, width, '…');
}
/** Full, mono command block, optionally only when the collapsed header hides text. */
export function commandBlock(task: TaskDisplay, theme: RenderTheme, width: number, onlyHidden = false): string[] {
  const raw = taskCommand(task);
  if (raw === undefined || (onlyHidden && !clean(raw).includes('\n') && !stripTerminalSequences(taskLine(task, theme, true, false, width)).includes('…'))) return [];
  return clean(raw).split('\n').map(line => theme.fg('toolOutput', `  ${line}`));
}
function tailLines(tail: string): string[] { return clean(tail).trimEnd().split('\n').filter(line => line.trim().length > 0); }
function detailBlock(task: TaskDisplay, theme: RenderTheme, width: number, tail: string[] = []): string[] {
  return [taskLine(task, theme, true, false, width), ...commandBlock(task, theme, width), theme.fg('dim', `  ${task.id}`),
    ...(task.outputPath ? [theme.fg('muted', `  Output: ${task.outputPath}`)] : []),
    ...(task.state === 'cancel_requested' ? [theme.fg('warning', '  Cancellation was requested; the native outcome may not be settled.')] : []),
    ...tail.slice(-40).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`))];
}
/** Build rows at the actual available width; only expanded blocks may wrap. */
function textAtWidth(build: (width: number) => string): Text {
  const text = new Text('', 0, 0), render = text.render.bind(text);
  text.render = width => { text.setText(build(width)); return render(width); };
  return text;
}
export function renderCompletion(message: { details?: unknown }, options: RenderOptions, theme: RenderTheme): Box | undefined {
  const details = isRecord(message.details) ? message.details : undefined;
  const tasks = (Array.isArray(details?.tasks) ? details.tasks : []).filter(isRecord) as unknown as TaskDisplay[];
  if (!tasks.length) return undefined;
  const box = new Box(options.outputPad ?? 1, 1, text => theme.bg('customMessageBg', text));
  box.addChild(textAtWidth(width => tasks.flatMap(task => {
    const tail = typeof task.outputTail === 'string' ? tailLines(task.outputTail) : [];
    return options.expanded ? detailBlock(task, theme, width, tail) : [taskLine(task, theme, true, false, width),
      ...(tasks.length === 1 ? tail.slice(-2).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`)) : [])];
  }).join('\n')));
  return box;
}
function resultTasks(details: unknown): { tasks: TaskDisplay[]; page: boolean } {
  if (!isRecord(details)) return { tasks: [], page: false };
  const raws = [...(Array.isArray(details.tasks) ? details.tasks : isRecord(details.task) ? [details.task] : typeof details.id === 'string' && typeof details.state === 'string' ? [details] : []),
    ...(Array.isArray(details.pending) ? details.pending : [])].filter(isRecord) as unknown as TaskDisplay[];
  return { tasks: [...new Map(raws.map(task => [task.id, task])).values()], page: Array.isArray(details.tasks) || isRecord(details.task) };
}
export function detachReasonSuffix(reason: string | undefined, autoDetachMs: number): string {
  return reason === 'timeout' ? ` (${autoDetachMs / 1000}s timeout)` : reason === 'shortcut' ? ' (manual detach)' : reason === 'steer' ? ' (steered)' : '';
}
export function renderTaskResult(result: ResultLike & { details?: unknown }, options: RenderOptions & { expanded: boolean },
  theme: RenderTheme, context: { args?: unknown }, isHandle: boolean, autoDetachMs = 0): Text {
  const details = isRecord(result.details) ? result.details : undefined;
  const { tasks, page } = resultTasks(details);
  return textAtWidth(width => {
    if (isHandle && tasks[0]) {
      const task = tasks[0];
      return `\n${options.expanded ? detailBlock(task, theme, width).join('\n')
        : `${stateGlyph(theme, task.state)} ${theme.fg('dim', `${task.state === 'running' ? 'running in background' : 'background'}${detachReasonSuffix(task.detachReason, autoDetachMs)} · ${shortId(task.id)}`)}`}`;
    }
    const isWait = isRecord(context.args) && context.args.action === 'wait', lines: string[] = [];
    if (isWait && tasks.length) {
      for (const task of tasks) {
        lines.push(...(options.expanded ? detailBlock(task, theme, width) : [taskLine(task, theme, true, false, width)]));
        if (active(task) && (details?.waitOutcome === 'timeout' || details?.waitOutcome === 'interrupted')) lines.push(theme.fg('dim',
          `  ${details.waitOutcome}${typeof details.waitedMs === 'number' ? ` · waited ${Math.max(0, Math.floor(details.waitedMs / 1000))}s` : ''}`));
      }
      const body = tasks.flatMap(task => { const output = options.isPartial ? task.outputTail ?? task.progress : task.output; return typeof output === 'string' ? tailLines(output) : []; });
      const shown = options.isPartial ? body.slice(-(options.expanded ? 20 : 5)) : options.expanded ? body : body.slice(0, 10);
      if (shown.length) lines.push('', ...shown.map(line => theme.fg('toolOutput', line)));
      if (body.length > shown.length && !options.isPartial) lines.push(theme.fg('muted', `… ${body.length - shown.length} more lines, ${keyHint('app.tools.expand', 'to expand')}`));
    } else if (page && tasks.length) {
      const isCancel = isRecord(context.args) && context.args.action === 'cancel';
      if (!isCancel) lines.push(theme.fg('muted', `Background tasks (${typeof details?.total === 'number' ? details.total : tasks.length})`));
      for (const task of tasks) lines.push(...(options.expanded ? detailBlock(task, theme, width, typeof task.outputTail === 'string' ? tailLines(task.outputTail) : [])
        : [taskLine(task, theme, true, !isCancel && !active(task), width)]));
    }
    if (typeof details?.next_offset === 'number' && typeof details.total === 'number') {
      const more = Math.max(0, details.total - details.next_offset);
      if (more) lines.push(theme.fg('muted', `+${more} more`));
    }
    if (!lines.length) lines.push(...result.content.filter(b => b.type === 'text' && typeof b.text === 'string').flatMap(b => tailLines(b.text!)).map(line => theme.fg('toolOutput', line)));
    return `\n${lines.join('\n')}`;
  });
}
export function renderMeantimeCall(args: unknown, theme: RenderTheme): Text {
  const action = isRecord(args) && typeof args.action === 'string' ? args.action : 'list';
  const ids = isRecord(args) && Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string').map(shortId).join(', ') : '';
  const timeout = isRecord(args) && typeof args.timeout === 'number' ? ` · ${formatDuration(args.timeout)}` : '';
  return new Text(`${theme.fg('toolTitle', theme.bold('meantime'))} ${theme.fg('accent', action)}${ids ? ` ${ids}` : ''}${theme.fg('dim', timeout)}`, 0, 0);
}
