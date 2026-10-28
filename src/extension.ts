import { keyHint } from '@earendil-works/pi-coding-agent';
import { Text, getCapabilities, getImageDimensions, imageFallback, stripTerminalSequences,
  matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Config } from './config.ts';
import type { Context, EventHandler, EventMap, Json, PiHost, Result, Tool } from './protocol.ts';
import { captureSession, manageTools } from './host.ts';
import type { HostSession, ManagedCall } from './host.ts';
import { CONTROL, isRecord, projectResult } from './schema.ts';
import { renderCompletion, renderMeantimeCall, renderTaskResult, stateGlyph } from './render.ts';
import { TaskRuntime } from './runtime.ts';
import { CompletionDelivery } from './notifications.ts';
import type { Snapshot, View, TaskRecord, IndexChange } from './runtime.ts';
import { truncateUtf8 } from './store.ts';

export interface InstallOptions { config: Config; connect?: (pi: PiHost) => HostSession; codemodeExecute?: Tool['execute'] }
const RESULT_SCHEMA = {
  type: 'object', properties: { task: { type: 'object' }, result: {}, tasks: { type: 'array', items: { type: 'object' } }, pending: { type: 'array', items: { type: 'object' } }, result_available: { type: 'boolean' } },
};
function textResult(text: string, details?: unknown, isError = false): Result {
  return { content: [{ type: 'text', text }], details, isError };
}
function interactive(ctx: Context): boolean { return ctx.mode === 'tui' || ctx.mode === 'rpc'; }
function owner(ctx: Context): string {
  // Include the session file to isolate equal session IDs in different agent roots.
  return `${ctx.sessionManager.getSessionId()}\0${ctx.sessionManager.getSessionFile() ?? ''}`;
}
function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
/** Concise detached-handle attribution; explicit detach needs no reason. */
function detachReasonSuffix(reason: Snapshot['detachReason'], autoDetachMs: number): string {
  if (reason === 'timeout') return ` (${(autoDetachMs > 0 ? autoDetachMs / 1000 : 90)}s auto-detach)`;
  if (reason === 'shortcut' || reason === 'steer') return ' (detached)';
  return '';
}
function foregroundOrHandle(view: View, autoDetachMs: number): Result {
  if (view.kind === 'handle') {
    const previewTask = withCommandPreview(view.task);
    return {
      content: [{ type: 'text', text: `Meantime ${view.task.id} running in background${detachReasonSuffix(view.task.detachReason, autoDetachMs)}.` }],
      details: previewTask,
      structuredContent: { task: json(previewTask), result_available: false },
    };
  }
  if (view.thrown) throw view.thrown.error;
  return { ...view.result, isError: view.isError ?? view.result.isError ?? false };
}
/** Display preview for details payloads: line breaks inside the budget survive for multi-line views. */
function commandPreview(command: string): string {
  const cleaned = stripTerminalSequences(command).trim();
  const preview = truncateUtf8(cleaned, 120);
  return preview === cleaned ? cleaned : `${preview}…`;
}
/** Same preview flattened for single-line surfaces (receipts and TUI list rows). */
function commandOneLine(command: string): string {
  return commandPreview(command).replace(/\s+/g, ' ');
}
/** Details payloads carry display-safe snapshots; the full command stays in the runtime/index. */
function withCommandPreview<T extends { command?: string }>(task: T): T {
  return task.command === undefined ? task : { ...task, command: commandPreview(task.command) };
}
function elapsed(task: Snapshot): string {
  return `${Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.createdAt) / 1000))}s`;
}
function taskHeader(task: Snapshot): string {
  return [
    task.id,
    task.state,
    ...(task.exitCode !== undefined ? [`exit ${task.exitCode}`] : []),
    elapsed(task),
  ].join(' · ');
}
function taskReceipt(task: Snapshot): string {
  const what = task.command !== undefined ? commandOneLine(task.command) : task.tool;
  return `${taskHeader(task)} — ${what}`;
}
const TAIL_BYTES = 1024;
/** Last ~1KB of a finished task's text output, fenced as untrusted data. */
function outputTail(text: string): string {
  text = text.trimEnd();
  if (!text) return '';
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - TAIL_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const tail = bytes.subarray(start).toString('utf8');
  return `\n<untrusted-output${start > 0 ? ' truncated' : ''}>\n${tail}\n</untrusted-output>`;
}
function receipt(task: Snapshot): string {
  const command = task.command !== undefined
    ? `\n$ ${truncateUtf8(task.command.replaceAll('\n', ' ').trim(), 120)}`
    : `\n${task.tool}`;
  return `${taskHeader(task)}${command}${task.outputPath ? `\nOutput: ${task.outputPath}` : ''}`;
}
/** A running task keeps its plain receipt; a settled one has no retained result. */
function noResultReceipt(task: Snapshot): string {
  return task.localRunning ? receipt(task) : `${receipt(task)}\nNo retained result.`;
}
function storedResult(task: Snapshot, source: Result, budget?: { remaining: number }): Result {
  // A receipt will itself enter Pi's persisted toolResult pipeline. Never pass
  // unknown live details back into that append path either.
  task = withCommandPreview(task);
  source = projectResult(source);
  let inlineOmitted = false;
  const content = source.content.filter(b => b.type === 'text').map(block => {
    if (!budget) return block;
    const text = truncateUtf8(block.text, budget.remaining);
    inlineOmitted ||= text !== block.text;
    budget.remaining -= Buffer.byteLength(text);
    return { type: 'text' as const, text };
  });
  const omitted = task.recovered && task.textOnly ? 'Recovered text only (images/structured data not persisted).'
    : source.content.some(b => b.type === 'image') ? 'Images omitted from receipt; retained in task result.' : '';
  return {
    content: [{ type: 'text', text: receipt(task) }, ...content,
      ...(inlineOmitted ? [{ type: 'text' as const, text: `Truncated; use meantime(action="wait", ids=["${task.id}"], timeout=0) for full output.` }] : []),
      ...(omitted ? [{ type: 'text' as const, text: omitted }] : []),
      ...(source.persistenceOmissions?.length ? [{ type: 'text' as const, text: `Non-JSON fields omitted (${source.persistenceOmissions.join(', ')}); retained in memory.` }] : []),
    ],
    // Retrieval is not another execution: expose retained usage as metadata,
    // never as top-level usage that Pi would charge on every wait. Native
    // details stay whole under one envelope: spreading them drops legal arrays
    // and strings and let a native `task` field overwrite this receipt's own.
    details: {
      task: { ...task, output: content.map(b => b.text).join('\n') },
      ...(source.details !== undefined ? { nativeDetails: source.details } : {}),
      ...(source.usage ? { usage: source.usage } : {}), ...(source.nestedCalls ? { nestedCalls: source.nestedCalls } : {}),
      ...(source.persistenceOmissions ? { persistenceOmissions: source.persistenceOmissions } : {}),
    },
    structuredContent: { task: json(task), result_available: true,
      result: source.structuredContent ?? content.map(b => b.text).join('\n') },
    isError: task.isError ?? source.isError ?? false,
    ...(source.terminate ? { terminate: true } : {}),
  };
}

/** Runtime/UI composition. Pi-specific interception is isolated in host.ts. */
export function install(pi: PiHost, options: InstallOptions): { dispose(): Promise<void>; inspect(): unknown } {
  const { config } = options;
  let host: ReturnType<typeof manageTools> | undefined;
  // Only live public call identities may donate intent to later nested calls.
  const calls = new Map<string, { parent?: string; intent?: 'steer' | 'shortcut' }>();
  function userDetach(reason: 'steer' | 'shortcut'): number {
    for (const call of calls.values()) if (reason === 'shortcut' || call.intent !== 'shortcut') call.intent = reason;
    runtime?.releaseWaiters();
    return runtime?.detachAll(reason) ?? 0;
  }
  function inheritedDetach(id: string): 'steer' | 'shortcut' | undefined {
    let call = calls.get(id);
    while (call) {
      if (call.intent) return call.intent;
      call = call.parent ? calls.get(call.parent) : undefined;
    }
    return undefined;
  }
  const diagnostics = new Map<string, string>();
  const disposers: (() => void)[] = [];
  let runtime: TaskRuntime | undefined;
  let delivery: CompletionDelivery | undefined;
  let currentCtx: Context | undefined;
  let currentOwner: string | undefined;
  let live = false;
  let refreshPanel: (() => void) | undefined;
  let closePanel: (() => void) | undefined;

  async function taskPanel(ctx: Context): Promise<void> {
    const r = assertRuntime(ctx);
    closePanel?.();
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let selected: string | undefined, expanded: string | undefined;
      let tasks: Snapshot[] = [];
      let list: SelectList;
      let error = '', closed = false;
      const close = () => { if (closed) return; closed = true; dispose(); done(); };
      const refresh = () => {
        tasks = r.list();
        list = new SelectList(tasks.map(task => ({ value: task.id,
          label: `${stateGlyph(theme, task.state)} ${task.command !== undefined ? commandOneLine(task.command) : task.tool} · ${Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.createdAt) / 1000))}s · ${task.id}` })), 10, {
          selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text),
          description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('muted', text),
        }, {
          truncatePrimary({ text, maxWidth }) {
            // Reserve the elapsed/id facts before shortening the command preview.
            const facts = /( · \d+s · mt_[a-f0-9]{8})$/.exec(text)?.[1] ?? '';
            if (visibleWidth(facts) >= maxWidth) return truncateToWidth(facts.trimStart(), maxWidth, '');
            return truncateToWidth(text.slice(0, text.length - facts.length), maxWidth - visibleWidth(facts), '…') + facts;
          },
        });
        list.setSelectedIndex(Math.max(0, tasks.findIndex(task => task.id === selected)));
        selected = list.getSelectedItem()?.value;
        list.onSelectionChange = item => { selected = item.value; error = ''; };
        list.onSelect = item => { expanded = expanded === item.value ? undefined : item.value; };
        list.onCancel = close;
        tui.requestRender();
      };
      const timer = setInterval(refresh, 1000);
      const dispose = () => {
        clearInterval(timer);
        if (refreshPanel === refresh) { refreshPanel = undefined; closePanel = undefined; }
      };
      refreshPanel = refresh; closePanel = close;
      refresh();
      return {
        render(width) {
          const task = tasks.find(task => task.id === expanded);
          // The snapshot may carry a preview; the expanded panel shows the original command.
          const rawCommand = task ? r.tasks.get(task.id)?.meta.command ?? task.command : undefined;
          const details = task ? [
            ...(rawCommand !== undefined ? [`Command: ${stripTerminalSequences(rawCommand)}`] : []),
            ...(task.progress ? [`Progress: ${stripTerminalSequences(task.progress)}`] : []),
            ...(!task.localRunning ? [stripTerminalSequences(outputTail(r.tasks.get(task.id)?.outputTail ?? '')).trim()] : []),
            ...(task.outputPath ? [`Output: ${task.outputPath}`] : []),
          ].filter(Boolean) : [];
          return [theme.fg('accent', 'Current session tasks'), ...list.render(width),
            ...details.flatMap(line => wrapTextWithAnsi(line, width)),
            ...(error ? wrapTextWithAnsi(theme.fg('error', error), width) : []),
            ...wrapTextWithAnsi('↑/↓ select · Enter expand · c cancel · Esc/q close', width),
          ].flatMap(line => wrapTextWithAnsi(line, width));
        },
        invalidate() { list.invalidate(); },
        handleInput(data) {
          if (matchesKey(data, 'q') || matchesKey(data, 'escape')) { close(); return; }
          if (matchesKey(data, 'c')) {
            if (selected) {
              try { r.cancel(selected); error = ''; }
              catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
              refresh();
            }
          } else { list.handleInput(data); tui.requestRender(); }
        },
        dispose,
      };
    });
  }

  function assertRuntime(ctx: Context): TaskRuntime {
    if (!runtime || !live || owner(ctx) !== currentOwner) throw new Error('Background runtime is not bound to this session');
    return runtime;
  }
  function controlFeedback(ctx: Context, message: string): void {
    // Pi 1.3 info notifications reuse a mutable status closure on redraw. A
    // keyed widget deliberately replaces only the latest feedback, never history
    // or model messages, and does not take keyboard focus.
    ctx.ui.setWidget('bg-control', message.split('\n'));
  }
  function taskList(tasks: Snapshot[]): string {
    return `Current session tasks ${tasks.length || '(none)'}:\n${tasks.map(t => `${taskReceipt(t)}${t.recovered ? ' · recovered' : ''}`).join('\n')}`;
  }
  function updateStatus(): void {
    if (!live || !runtime || !currentCtx) return;
    const active = runtime.list().filter(t => t.localRunning);
    currentCtx.ui.setStatus('meantime', active.length ? `bg ${active.length}/${config.maxRunning}` : undefined);
  }
  function diagnostic(name: string, message: string): void {
    if (diagnostics.get(name) === message) return;
    diagnostics.set(name, message);
    if (diagnostics.size > 256) diagnostics.delete(diagnostics.keys().next().value!);
    try { currentCtx?.ui.notify(`meantime: ${name}: ${message}`, 'warning'); } catch {}
  }
  function on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    disposers.push(pi.on(event, handler));
  }
  function run(call: ManagedCall): Promise<Result> {
    const r = assertRuntime(call.ctx);
    return r.run({ tool: call.name, kind: call.name === 'bash' ? 'bash' : 'tool', callId: call.id,
      mode: call.mode, command: call.name === 'bash' && typeof call.args.command === 'string' ? call.args.command : undefined,
      canDetach: interactive(call.ctx) && call.canDetach, parentSignal: call.signal, onUpdate: call.update,
      userDetach: inheritedDetach(call.id), execute: call.execute,
      codemodeRootId: call.codemodeRootId, onDetach: call.onDetach, onSettled: call.onSettled,
      scope: call.scope, finalize: call.finalize,
    }).then(view => foregroundOrHandle(view, config.autoDetachMs));
  }

  pi.registerMessageRenderer('meantime-completion', (message, options, theme) => renderCompletion(message, options, theme));

  pi.registerToolRenderer((name, next) => {
    const native = next();
    if (name !== 'meantime' && !host?.names().includes(name)) return native;
    return {
      ...native,
      // The control tool gets a compact call row; managed tools keep their own call rendering.
      ...(name === 'meantime' ? { renderCall: (args: unknown, theme: Parameters<typeof renderMeantimeCall>[1]) => renderMeantimeCall(args, theme) } : {}),
      renderResult(result, renderOptions, theme, context) {
        const details = result.details;
        // Pi projects renderer input to content/details; structuredContent is
        // model/programmatic data and is not passed to this callback.
        const handle = isRecord(details) && details.delivery === 'background'
          && typeof details.id === 'string' && typeof details.createdAt === 'number';
        if (handle || name === 'meantime') return renderTaskResult(result, renderOptions, theme, context, handle);
        if (native?.renderResult) return native.renderResult(result, renderOptions, theme, context);
        // Match Pi's generic result preview for tools without a renderer.
        const blocks = result.content.filter(block => block.type === 'text').map(block =>
          stripTerminalSequences(block.text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFF9-\uFFFB\r]/g, ''));
        if (!getCapabilities().images || !context.showImages) {
          blocks.push(...result.content.filter(block => block.type === 'image').map(block =>
            imageFallback(block.mimeType, getImageDimensions(block.data, block.mimeType) ?? undefined)));
        }
        const lines = blocks.join('\n').split('\n');
        const shown = renderOptions.expanded ? lines : lines.slice(0, 10);
        const remaining = lines.length - shown.length;
        const text = shown.map(line => theme.fg('toolOutput', line)).join('\n');
        return new Text(text + (remaining ? `${theme.fg('muted', `\n... (${remaining} more lines,`)} ${keyHint('app.tools.expand', 'to expand')}${theme.fg('muted', ')')}` : ''), 0, 0);
      },
    };
  });

  pi.registerTool({
    name: 'meantime', label: 'Background tasks', exposure: 'model-only',
    description: 'List, wait on, or cancel background tasks. Tasks notify automatically when done — only call wait when blocked on a result, or with timeout: 0 to read full output.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'wait', 'cancel'] },
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32,
        description: 'Task IDs or unique prefixes. Omit in wait to wait for all pending tasks; required for cancel.' },
      mode: { type: 'string', enum: ['any', 'all'],
        description: '"all" (default, wait for all targets) or "any" (return when the first settles).' },
      timeout: { type: 'number', minimum: 0,
        description: 'Max wait in seconds (default 30; 0 returns current state/output immediately).' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 32 },
    }, required: ['action'], additionalProperties: false },
    outputSchema: RESULT_SCHEMA,
    async execute(_id, params, signal, _update, ctx): Promise<Result> {
      const r = assertRuntime(ctx);
      // Snapshots don't carry output; attach the retained tail so cards and
      // detail sheets can show it without a second round-trip.
      const withTail = <T extends { id: string }>(t: T): T & { outputTail?: string } => {
        const tail = r.tasks.get(t.id)?.outputTail;
        return tail ? { ...t, outputTail: tail } : t;
      };
      if (params.action === 'list') {
        const offset = Number.isInteger(params.offset) && Number(params.offset) >= 0 ? Number(params.offset) : 0;
        const limit = Number.isInteger(params.limit) && Number(params.limit) > 0 ? Math.min(32, Number(params.limit)) : 10;
        const all = r.list(); const tasks = all.slice(offset, offset + limit).map(t => withTail({ ...withCommandPreview(t), progress: t.progress?.slice(0, 256) }));
        const page = { tasks, next_offset: offset + limit < all.length ? offset + limit : null, total: all.length };
        const text = tasks.map(taskReceipt).join('\n') || 'No meantime tasks.';
        const result = textResult(`${text}${page.next_offset !== null ? `\nMore: offset=${page.next_offset}` : ''}`, page); result.structuredContent = json(page); return result;
      }
      const timeout = (typeof params.timeout === 'number' && params.timeout >= 0 ? params.timeout : 30) * 1000;
      if (params.action !== 'wait' && params.action !== 'cancel') throw new Error('Unknown meantime action');
      const cancel = params.action === 'cancel';
      if (!cancel && params.mode !== undefined && params.mode !== 'any' && params.mode !== 'all') throw new Error('mode must be any or all');
      let ids = params.ids as string[] | undefined;
      if (ids === undefined) {
        if (cancel) throw new Error('cancel requires ids');
        ids = r.list().filter(task => task.localRunning || task.endedAt === undefined).map(task => task.id);
        if (ids.length === 0) {
          const page = { tasks: [] as unknown[], pending: [] as unknown[] };
          const empty = textResult('No pending meantime tasks.', page); empty.structuredContent = json(page); return empty;
        }
      }
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || !ids.every(id => typeof id === 'string')) throw new Error('ids must contain 1 to 32 task ids');
      // Snapshot the targets before blocking so the streaming update can name them.
      const targets = [...new Map(ids.map(id => { const t = r.get(id); return [t.id, t] as const; })).values()];
      const previewTargets = targets.map(t => ({ ...withTail(withCommandPreview(t)), state: cancel ? 'cancel_requested' : 'waiting' }));
      try {
        _update?.({
          content: [{ type: 'text', text: targets.map(taskReceipt).join('\n') }],
          details: { tasks: previewTargets },
        });
      } catch {}
      if (ids.length === 1) {
        const { task, result } = await r.wait(ids[0]!, cancel ? config.shutdownGraceMs : timeout, signal, cancel);
        if (result) return storedResult(withTail(task), result);
        const previewTask = withTail(withCommandPreview(task));
        return {
          ...textResult(noResultReceipt(task), previewTask),
          structuredContent: { task: json(previewTask), result_available: false },
        };
      }
      const { tasks, pending } = cancel
        ? await r.cancelMany(ids, config.shutdownGraceMs, signal)
        : await r.waitMany(ids, params.mode === 'any' ? 'any' : 'all', timeout, signal);
      const budget = { remaining: 32 * 1024 };
      const views = tasks.map(({ task, result }) => result ? storedResult(task, result, budget) : textResult(noResultReceipt(task)));
      const page = { tasks: tasks.map(({ task, result }, i) => {
          const taskDetails = isRecord(views[i]!.details) && isRecord((views[i]!.details as Record<string, unknown>).task)
            ? (views[i]!.details as { task: { output?: string } }).task : undefined;
          return withTail({ ...withCommandPreview(task), ...(taskDetails?.output !== undefined ? { output: taskDetails.output } : {}),
            result_available: result !== undefined, result: (views[i]!.structuredContent as { result?: Json } | undefined)?.result });
        }),
        pending: pending.map(task => withCommandPreview(task)) };
      return {
        content: [...views.flatMap(view => view.content), { type: 'text', text: `Pending: ${pending.map(task => task.id).join(', ') || '(none)'}` }],
        details: page, structuredContent: json(page),
        isError: views.some(view => view.isError),
      };
    },
  });

  async function start(ctx: Context): Promise<void> {
    if (runtime) await stop();
    currentCtx = ctx; currentOwner = owner(ctx); live = true;
    ctx.ui.setWidget('bg-control', undefined);
    const boundOwner = currentOwner;
    const session = (options.connect ?? captureSession)(pi);
    const records = new Map<string, TaskRecord>();
    // Jobs are real side effects shared by this session's branches. Forks copy
    // entries but have a new owner, so they never adopt the original jobs.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== 'meantime-index' || !isRecord(entry.data) || entry.data.owner !== boundOwner) continue;
      const change = entry.data.change as IndexChange;
      if (change && 'task' in change) records.set(change.task.id, change.task);
      else if (change && 'completion' in change) {
        const record = records.get(change.completion.id);
        if (record) record.completion = change.completion;
      }
      else if (change && 'removed' in change) for (const id of change.removed) records.delete(id);
    }
    const created: TaskRuntime = new TaskRuntime(config, {
      notify(tasks) { return boundDelivery.send(tasks); },
      changed() { updateStatus(); refreshPanel?.(); },
      index(change) {
        if (!live || runtime !== created || currentOwner !== boundOwner) throw new Error('Stale task index target');
        if ('completion' in change && change.completion.result) {
          change = { completion: { ...change.completion, result: projectResult(change.completion.result) } };
        }
        // Preflight the WHOLE payload before Pi can advance its in-memory leaf.
        pi.appendEntry('meantime-index', json({ owner: boundOwner, change }));
        const c = 'completion' in change && change.completion.codemodeRootId
          && change.completion.toolCallId === change.completion.codemodeRootId ? change.completion : undefined;
        const usage = c?.lateScope ? c.nestedUsage : c?.result?.usage;
        if (c && usage) {
          const manager = session.sessionManager!;
          const note = `meantime:${c.id}:${c.toolCallId}${c.lateScope ? ':scope' : ''}`;
          if (!manager.getEntries().some(entry => entry.type === 'usage' && entry.note === note)) {
            manager.appendUsage('meantime', 'tools', 'codemode', usage, note);
          }
        }
      },
    }, [...records.values()]);
    runtime = created;
    const boundDelivery = new CompletionDelivery(created, session, () => currentCtx?.isIdle() ?? false, tasks => {
      if (!live || runtime !== created || currentOwner !== boundOwner) throw new Error('Stale notification target');
      const entries = tasks.map(t => {
        const tail = outputTail(created.tasks.get(t.id)?.outputTail ?? '');
        const hasMore = tail.includes('<untrusted-output truncated>') || Boolean(t.outputPath)
          || Boolean(created.tasks.get(t.id)?.result?.content.some(b => b.type !== 'text'));
        return { text: `${receipt(t)}${tail}`, hasMore };
      });
      return { customType: 'meantime-completion',
          content: `<system-reminder>\n${entries.map(e => e.text).join('\n\n')}${entries.some(e => e.hasMore) ? '\n\nUse meantime(action="wait", ids=[...], timeout=0) for full output.' : ''}\n</system-reminder>`,
          display: true, details: { taskIds: tasks.map(t => t.id),
            tasks: tasks.map(t => ({ id: t.id, tool: t.tool, state: t.state,
              ...(t.command !== undefined ? { command: commandPreview(t.command) } : {}),
              ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
              ...(t.outputPath !== undefined ? { outputPath: t.outputPath } : {}),
              ...(t.cancelRequestedAt !== undefined ? { cancelRequestedAt: t.cancelRequestedAt } : {}),
              ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
              ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
              // Untrusted output tail for display (timeline detail modal); the
              // same bytes appear in the prose receipt's untrusted-output.
              ...(created.tasks.get(t.id)?.outputTail ? { outputTail: created.tasks.get(t.id)!.outputTail } : {}) })) },
        };
    });
    delivery = boundDelivery;
    host = manageTools(session, config, run, diagnostic, options.codemodeExecute);
    updateStatus();
  }
  async function stop(): Promise<void> {
    delivery?.close(); delivery = undefined;
    closePanel?.();
    host?.closeAdmission();
    // Keep this generation's finishing hooks/index alive through cancellation
    // and drain. Only then dispose it, before Pi can select another session.
    await runtime?.close();
    host?.dispose(); host = undefined;
    live = false; runtime = undefined;
    try { currentCtx?.ui.setStatus('meantime', undefined); currentCtx?.ui.setWidget('bg-control', undefined); } catch {}
    currentCtx = undefined; currentOwner = undefined;
    calls.clear();
  }
  on('session_start', (_event, ctx) => start(ctx));
  on('session_shutdown', () => stop());
  on('session_before_tree', () => runtime?.drainCodemode());

  on('before_agent_start', async (event, ctx) => {
    if (live) {
      currentCtx = ctx; host?.refresh();
      event.systemPromptOptions.sections.meantime = `Tools with ${CONTROL} accept: "auto" (default; ${config.autoDetachMs > 0 ? 'moves to background if not finished in time' : 'never detaches on a timer'}), "yes" (run in background), or "no" (stay in foreground). Background tasks notify automatically when done — do not re-run them. Do other work while they run; only call meantime(action="wait") when blocked on a result.`;
      await delivery?.atBoundary();
    }
  });
  on('agent_settled', event => { calls.clear(); delivery?.settled(event.aborted); });
  on('turn_end', async event => {
    calls.clear();
    const staged = await delivery?.atBoundary();
    if (staged && event.outcome !== 'aborted' && event.outcome !== 'error') return { continue: true };
  });
  for (const event of ['session_compact', 'session_compact_failed', 'session_tree'] as const) {
    on(event, () => delivery?.hostReady());
  }
  on('ui_prompt_start', () => runtime?.prompt(true));
  on('ui_prompt_end', () => runtime?.prompt(false));
  on('tool_execution_start', (event, ctx) => {
    if (live && owner(ctx) === currentOwner) {
      calls.set(event.toolCallId, { parent: event.parentToolCallId });
    }
  });
  on('tool_execution_end', (event, ctx) => {
    host?.end(event.toolCallId);
    if (!live || owner(ctx) !== currentOwner) return;
    calls.delete(event.toolCallId);
    const data = event.result.structuredContent;
    const details = event.result.details;
    const task = isRecord(data) && isRecord(data.task) ? data.task
      : isRecord(details) && isRecord(details.task) ? details.task : details;
    // Task UUID prevents a late event from an old session with a reused call ID
    // from publishing a new session's task. Redacted metadata fails closed.
    if (isRecord(task) && typeof task.id === 'string') runtime?.published(event.toolCallId, task.id);
  });
  on('input', event => {
    if (config.detachOnSteer && event.streamingBehavior === 'steer') userDetach('steer');
    // No abort, no consume/resubmit, no lost images or changed queue semantics.
    return { action: 'continue' };
  });
  pi.registerShortcut('ctrl+shift+b', {
    description: 'Detach managed foreground calls without cancellation',
    handler(ctx) { assertRuntime(ctx); const count = userDetach('shortcut'); controlFeedback(ctx, `Detached ${count} call(s) to background.`); },
  });
  const meantimeCommand = { description: 'Background runtime: /meantime [detach|rescan|cancel <id>] (alias: /bg)', async handler(args: string, ctx: Context): Promise<void> {
    const [command, ...rest] = args.trim() ? args.trim().split(/\s+/) : [];
    if (command === 'cancel') {
      const r = assertRuntime(ctx);
      if (rest.length !== 1) {
        const tasks = r.list();
        controlFeedback(ctx, `Usage: /meantime cancel <id>. No task was cancelled.\n${taskList(tasks)}`);
        return;
      }
      try {
        const task = r.cancel(rest[0]!);
        const message = task.localRunning && task.cancelRequestedAt
          ? `Cancellation requested for ${task.id}. The native tool outcome is not settled yet.`
          : `Task ${task.id}: ${task.state}. No running local call was cancelled.`;
        controlFeedback(ctx, message);
      } catch (error) {
        // A session-scoped lookup/retired controller failure is visible, never a guessed target.
        ctx.ui.notify(`Cannot cancel ${rest[0]}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    } else if (!command) {
      if (ctx.mode === 'tui') { await taskPanel(ctx); return; }
      controlFeedback(ctx, `${taskList(assertRuntime(ctx).list())}\nCancel: /meantime cancel <id>; output: ask meantime(action="wait", ids=[...], timeout=0).\nManaged tools: ${host?.names().length ?? 0}; warnings: ${diagnostics.size}.`);
    } else if (rest.length) controlFeedback(ctx, 'Use /meantime [detach|rescan|cancel <id>]');
    else if (command === 'detach') {
      assertRuntime(ctx);
      const count = userDetach('shortcut');
      controlFeedback(ctx, `Detached ${count} call(s) to background.`);
    }
    else if (command === 'rescan') { host?.refresh(); controlFeedback(ctx, 'Managed tool registry refreshed. Use /meantime.'); }
    else controlFeedback(ctx, 'Use /meantime [detach|rescan|cancel <id>]');
  } };
  pi.registerCommand('meantime', meantimeCommand);
  pi.registerCommand('bg', { ...meantimeCommand, description: 'Alias for /meantime' });
  return {
    async dispose() { await stop(); for (const dispose of disposers) dispose(); },
    inspect() { return { tasks: runtime?.list() ?? [], managed: host?.names() ?? [], diagnostics: Object.fromEntries(diagnostics) }; },
  };
}
