import { Box, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { keyHint } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { isRecord } from './schema.ts';
import { truncateUtf8 } from './store.ts';

export interface TaskDisplay {
  id: string; tool: string; state: string; command?: string; code?: string; args?: Record<string, unknown>;
  createdAt?: number; endedAt?: number; exitCode?: number;
  output?: string; outputPath?: string; outputTail?: string; progress?: string; cancelRequestedAt?: number;
  detachReason?: string; notification?: string; notificationError?: string; isError?: boolean; recovered?: boolean;
}
export type RenderTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;
interface ResultLike { content: { type: string; text?: string }[] }
interface RenderOptions { expanded?: boolean; isPartial?: boolean; outputPad?: number }
interface WaitDisplay { waitOutcome?: unknown; waitedMs?: unknown }
const GLYPHS: Record<string, [glyph: string, color: ThemeColor]> = {
  running: ['●', 'warning'], waiting: ['●', 'warning'], queued: ['●', 'warning'], started: ['●', 'warning'], cancel_requested: ['●', 'warning'],
  completed: ['✓', 'success'], failed: ['✕', 'error'], cancelled: ['⊘', 'dim'], outcome_unknown: ['?', 'dim'],
};
export function stateGlyph(theme: RenderTheme, state: string): string {
  const [glyph, color] = GLYPHS[state] ?? ['?', 'dim'];
  return theme.fg(color, glyph);
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
function active(task: TaskDisplay): boolean { return ['running', 'waiting', 'queued', 'started', 'cancel_requested'].includes(task.state); }
export function elapsedText(task: TaskDisplay): string {
  if (task.createdAt === undefined || (!active(task) && task.endedAt === undefined)) return '';
  return formatDuration(((task.endedAt ?? Date.now()) - task.createdAt) / 1000);
}
/** Use only display data already present in the snapshot; never infer arguments. */
export function taskCommand(task: TaskDisplay): string | undefined {
  const arg = task.args?.code ?? Object.values(task.args ?? {})[0];
  return task.command ?? task.code ?? (typeof arg === 'string' ? arg : arg === undefined ? undefined : JSON.stringify(arg));
}
export function taskLine(task: TaskDisplay, theme: RenderTheme, width = 100, wait: WaitDisplay = {}): string {
  const state = task.state === 'cancel_requested' ? 'cancelling' : ['running', 'completed', 'failed'].includes(task.state) ? ''
    : ['waiting', 'queued', 'started', 'cancelled'].includes(task.state) ? task.state : 'unknown';
  const outcome = active(task) && (wait.waitOutcome === 'timeout' || wait.waitOutcome === 'interrupted') ? [wait.waitOutcome,
    typeof wait.waitedMs === 'number' ? `waited ${formatDuration(wait.waitedMs / 1000)}` : ''] : [];
  const facts = [state, task.exitCode !== undefined && task.exitCode !== 0 ? `exit ${task.exitCode}` : '', elapsedText(task), ...outcome].filter(Boolean).join(' · ');
  const suffix = facts ? `  ${facts}` : '';
  const parts = clean(taskCommand(task) ?? '').split('\n');
  const title = [task.command === undefined ? task.tool : '', parts[0]!.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ');
  const hint = parts.length > 1 ? ` +${parts.length - 1} lines` : '';
  const command = truncateToWidth(title, Math.max(1, width - visibleWidth(suffix + hint) - 2), theme.fg('dim', '…')) + theme.fg('dim', hint);
  return truncateToWidth(`${stateGlyph(theme, task.exitCode ? 'failed' : task.state)} ${command}${theme.fg('dim', suffix)}`, width, '…');
}
export function commandBlock(task: TaskDisplay, theme: RenderTheme, width: number, wait: WaitDisplay = {}): string[] {
  const raw = taskCommand(task);
  if (raw === undefined || (!clean(raw).includes('\n') && !stripTerminalSequences(taskLine(task, theme, width, wait)).includes('…'))) return [];
  return clean(raw).split('\n').map(line => theme.fg('toolOutput', `  ${line}`));
}
function tailLines(tail: string): string[] { return clean(tail).trimEnd().split('\n').filter(line => line.trim().length > 0); }
function footer(task: TaskDisplay): string {
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  return [task.id, task.createdAt === undefined ? '' : task.endedAt === undefined ? `started ${clock(task.createdAt)}` : `${clock(task.createdAt)} → ${clock(task.endedAt)}`,
    task.outputPath, task.recovered ? 'recovered' : '', task.isError && task.state !== 'failed' ? 'error reported' : '', task.notificationError ?? (task.notification === 'failed' ? 'notification failed' : '')].filter(Boolean).join(' · ');
}
function detailBlock(task: TaskDisplay, theme: RenderTheme, width: number, output = '', wait: WaitDisplay = {}): string[] {
  return [taskLine(task, theme, width, wait), ...commandBlock(task, theme, width, wait),
    ...tailLines(output).slice(-40).map(line => theme.fg('toolOutput', `  ${line}`)),
    ...(task.state === 'cancel_requested' ? [theme.fg('warning', '  cancel requested; outcome not settled yet')] : []),
    theme.fg('dim', `  ${footer(task)}`)];
}
export function panelDetails(task: TaskDisplay, theme: RenderTheme, width: number, output: string): string[] {
  return detailBlock(task, theme, width, output).slice(1);
}
export function listHeading(tasks: TaskDisplay[], theme: RenderTheme): string {
  const groups = [[tasks.filter(active).length, 'active'], [tasks.filter(t => !active(t) && t.state === 'completed' && !t.exitCode).length, '✓'],
    [tasks.filter(t => !active(t) && (t.state === 'failed' || Boolean(t.exitCode))).length, '✕'],
    [tasks.filter(t => !active(t) && t.state !== 'completed' && t.state !== 'failed' && !t.exitCode).length, 'other']];
  return `Background tasks${theme.fg('dim', groups.filter(([n]) => n).map(([n, label]) => ` · ${n} ${label}`).join(''))}`;
}
/** Rows are measured at the real available width; expanded blocks alone wrap. */
function textAtWidth(build: (width: number) => string): Text {
  const text = new Text('', 0, 0), render = text.render.bind(text);
  text.render = width => { text.setText(build(width)); return render(width); };
  return text;
}
export function renderCompletion(message: { details?: unknown }, options: RenderOptions, theme: RenderTheme): Box | undefined {
  const details = isRecord(message.details) ? message.details : undefined;
  const tasks = (Array.isArray(details?.tasks) ? details.tasks : []).filter(isRecord) as unknown as TaskDisplay[];
  if (!tasks.length) return undefined;
  const box = new Box(0, 1, text => theme.bg('customMessageBg', text));
  box.addChild(textAtWidth(width => tasks.map(task => {
    const tail = typeof task.outputTail === 'string' ? task.outputTail : '';
    return options.expanded ? detailBlock(task, theme, width, tail).join('\n') : [taskLine(task, theme, width),
      ...(tasks.length === 1 ? tailLines(tail).slice(-2).map(line => theme.fg('toolOutput', `  ${truncateUtf8(line, 200)}`)) : [])].join('\n');
  }).join(options.expanded ? '\n\n' : '\n')));
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
        : `${stateGlyph(theme, task.exitCode ? 'failed' : task.state)} ${theme.fg('dim', `${task.state === 'running' ? 'running in background' : 'background'}${detachReasonSuffix(task.detachReason, autoDetachMs)}`)}`}`;
    }
    const isWait = isRecord(context.args) && context.args.action === 'wait', lines: string[] = [];
    if (tasks.length && (isWait || page)) {
      const isCancel = isRecord(context.args) && context.args.action === 'cancel';
      if (!isWait && !isCancel) lines.push(listHeading(tasks, theme));
      if (options.expanded) lines.push(tasks.map(task => detailBlock(task, theme, width,
        isWait ? options.isPartial ? task.outputTail ?? task.progress : task.output : task.outputTail, isWait ? details : undefined).join('\n')).join('\n\n'));
      else {
        lines.push(...tasks.map(task => taskLine(task, theme, width, isWait ? details : undefined)));
        if (isWait) {
          const body = tasks.flatMap(task => tailLines(options.isPartial ? task.outputTail ?? task.progress ?? '' : task.output ?? ''));
          const shown = options.isPartial ? body.slice(-5) : body.slice(0, 10);
          if (shown.length) lines.push('', ...shown.map(line => theme.fg('toolOutput', line)));
          if (body.length > shown.length && !options.isPartial) lines.push(theme.fg('dim', `… ${body.length - shown.length} more lines, ${keyHint('app.tools.expand', 'to expand')}`));
        }
      }
    }
    if (typeof details?.next_offset === 'number' && typeof details.total === 'number') {
      const more = Math.max(0, details.total - details.next_offset);
      if (more) lines.push(theme.fg('dim', `+${more} more`));
    }
    if (!lines.length) lines.push(...result.content.filter(b => b.type === 'text' && typeof b.text === 'string').flatMap(b => tailLines(b.text!)).map(line => theme.fg('toolOutput', line)));
    return `\n${lines.join('\n')}`;
  });
}
export function renderMeantimeCall(args: unknown, theme: RenderTheme): Text {
  const action = isRecord(args) && typeof args.action === 'string' ? args.action : 'list';
  const timeout = isRecord(args) && typeof args.timeout === 'number' ? ` · ${formatDuration(args.timeout)}` : '';
  return new Text(`${theme.fg('toolTitle', theme.bold('meantime'))} ${theme.fg('accent', action)}${theme.fg('dim', timeout)}`, 0, 0);
}
