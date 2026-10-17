import { resolve } from 'node:path';
import type { Config } from './config.ts';
import type { BashTool, Context, EventHandler, EventMap, Json, Loadout, PiHost, Result, Tool, ToolContext, ToolInfo } from './protocol.ts';
import { CONTROL, MARKER, decorateSchema, fingerprint, isRecord, matches, proxyName, splitControl } from './schema.ts';
import { TaskRuntime } from './runtime.ts';
import type { Snapshot, View } from './runtime.ts';
import { TaskStore, cleanText, truncateUtf8 } from './store.ts';

export interface InstallOptions { config: Config; baseBash?: BashTool; makeBash(cwd: string): BashTool }
interface Pair { original: string; name: string; signature: string; definition: Tool; enabled: boolean }
interface Ticket { original: string; started: boolean; runtime: TaskRuntime }
const RESULT_SCHEMA = {
  type: 'object', properties: { task: { type: 'object' }, result: {}, tasks: { type: 'array', items: { type: 'object' } }, result_available: { type: 'boolean' } },
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
function foregroundOrHandle(view: View, nested: boolean): Result {
  if (view.kind === 'handle') return {
    content: [{ type: 'text', text: `Task ${view.task.id}: ${view.task.state}; execution continues independently of this wait. Do not restart or poll in a loop. Completion will be announced. In the TUI use /bg status or /bg cancel ${view.task.id}; the model can use bg_task for status/result/cancel.` }],
    details: view.task,
    structuredContent: { task: json(view.task), result_available: false },
  };
  if (view.thrown) throw view.thrown.error;
  if (!nested) return view.result;
  // Pi already aggregates nested usage. Preserve the hook's authoritative flag
  // without double-counting usage or exposing our task bookkeeping.
  const { usage: _usage, ...result } = view.result;
  return { ...result, isError: view.isError ?? result.isError ?? false };
}
function storedResult(task: Snapshot, source: Result): Result {
  // Bounded context, persisted original, including structured/image data when it
  // fits the configured retention cap. Do not silently lose where full data lives.
  let budget = 32 * 1024;
  const content = source.content.flatMap(block => {
    if (block.type !== 'text') return []; // Images stay in the result file; no accidental huge prompts.
    const text = truncateUtf8(cleanText(block.text), budget);
    budget -= Buffer.byteLength(text);
    return text ? [{ type: 'text' as const, text }] : [];
  });
  content.unshift({ type: 'text', text: `Task ${task.id}: ${task.state}. ${task.cancelRequestedAt ? 'A cancellation was requested; the native outcome is shown below. ' : ''}Result file: ${task.resultPath ?? 'unavailable'}.` });
  const hadImages = source.content.some(b => b.type === 'image');
  const rawTextBytes = Buffer.byteLength(source.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  if (hadImages || rawTextBytes > 32 * 1024) content.push({ type: 'text', text: 'Inline view omits image blocks or excess text. The stored result contains retained original blocks and structured data.' });
  return {
    content, details: { task },
    structuredContent: {
      task: json(task), result_available: true,
      // Keep programmatic output bounded too; larger data remains in the result file.
      result: source.structuredContent !== undefined
        ? (Buffer.byteLength(JSON.stringify(source.structuredContent)) <= 32 * 1024 ? source.structuredContent : null)
        : truncateUtf8(source.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), 32 * 1024),
    },
    // New records retain Pi's final Outcome flag. Older records only had result.isError.
    isError: task.isError ?? source.isError ?? false,
    ...(source.terminate ? { terminate: true } : {}),
  };
}

/** Pure extension composition. No private host fields, prototype patches or
 * direct invocation of another extension's execute implementation. */
export function install(pi: PiHost, options: InstallOptions): { dispose(): Promise<void>; inspect(): unknown } {
  const { config } = options;
  const pairs = new Map<string, Pair>();
  const tickets = new Map<string, Ticket>();
  const diagnostics = new Map<string, string>();
  const capabilities = new Map<string, 'parallel' | 'sequential' | undefined>();
  const disposers: (() => void)[] = [];
  let runtime: TaskRuntime | undefined;
  let currentCtx: Context | undefined;
  let currentOwner: string | undefined;
  let scanner: ReturnType<typeof setInterval> | undefined;
  let reconcilerQueued = false;
  let reconciling = false;
  let installed = true;
  let live = false;

  function assertRuntime(ctx: Context): TaskRuntime {
    if (!runtime || !live || owner(ctx) !== currentOwner) throw new Error('Background runtime is not bound to this session');
    return runtime;
  }
  function controlFeedback(ctx: Context, message: string): void {
    // Pi 1.3 info notifications reuse a mutable status closure on redraw. A
    // keyed widget deliberately replaces only the latest feedback, never history
    // or model messages, and does not take keyboard focus.
    ctx.ui.setWidget('bg-control', ['Latest background control:', ...message.split('\n')]);
  }
  function taskPage(tasks: Snapshot[], offset = 0): string {
    const sorted = [...tasks].sort((a, b) => Number(b.localRunning) - Number(a.localRunning) || b.createdAt - a.createdAt);
    const page = sorted.slice(offset, offset + 3);
    return `Current session tasks ${tasks.length ? `${offset + 1}-${offset + page.length} of ${tasks.length}` : '(none)'}:\n${page.map(t => `${t.id} | ${t.tool} | ${t.state}${t.cancelRequestedAt ? ' | cancel requested' : ''}${t.recovered ? ' | recovered' : ''}`).join('\n')}${offset + 3 < tasks.length ? `\nMore: /bg status ${offset + 3}` : ''}`;
  }
  function updateStatus(): void {
    if (!live || !runtime || !currentCtx) return;
    const active = runtime.list().filter(t => t.localRunning);
    currentCtx.ui.setStatus('bg-poc', active.length ? `bg ${active.length}/${config.maxRunning}` : undefined);
  }
  function diagnostic(name: string, message: string): void {
    if (diagnostics.get(name) === message) return;
    diagnostics.set(name, message);
    if (diagnostics.size > 256) diagnostics.delete(diagnostics.keys().next().value!);
    try { currentCtx?.ui.notify(`bg-poc: ${name}: ${message}`, 'warning'); } catch {}
  }
  function on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    disposers.push(pi.on(event, handler));
  }
  function capture(loadout: Loadout): void {
    capabilities.clear();
    for (const tool of loadout.registered) capabilities.set(tool.name, tool.executionMode);
    queueReconcile();
  }
  function queueReconcile(): void {
    if (reconcilerQueued || !live || reconciling) return;
    reconcilerQueued = true;
    queueMicrotask(() => { reconcilerQueued = false; if (live && installed) reconcile(); });
  }
  function hideDeclarations(loadout: Loadout): { hiddenDeclarations: string[] } {
    capture(loadout);
    const active = new Set(loadout.declared.map(t => t.name));
    const callable = new Set(loadout.callable.map(t => t.name));
    return { hiddenDeclarations: [...pairs.values()].filter(p => p.enabled && active.has(p.name) && callable.has(p.original)).map(p => p.original) };
  }
  function registerProxy(info: ToolInfo, name: string, signature: string): Tool {
    const original = info.name;
    return {
      name, label: name,
      description: `${MARKER} ${info.description}\nThe ${CONTROL} field is Pi-only execution control. Default auto. The original tool is ${original}; use this proxy instead of calling it directly.`,
      // Discovery metadata lacks outputSchema; native output or a handle is
      // unknown, not the old task envelope promised for every invocation.
      parameters: decorateSchema(info.parameters), outputSchema: {},
      exposure: info.exposure ?? 'direct', defaultActive: (info.exposure ?? 'direct') === 'direct',
      // Preserve Pi's exposure policy: indirect MCP proxies stay indirect.
      // Sequential tools are not accepted by discovery. Never silently override
      // the original tool's sequential contract just to enable detachment.
      executionMode: 'parallel',
      namespace: info.namespace, annotations: info.annotations,
      promptSnippet: `Managed ${original}; supports cooperative background execution.`,
      promptGuidelines: [...(info.promptGuidelines ?? []), 'A returned task ID means work is already running. Do not repeat side effects. Await completion notification or explicitly inspect bg_task.'],
      reachesTools: () => [original],
      async execute(callId, params, signal, update, ctx) {
        const r = assertRuntime(ctx);
        const source = pi.getAllTools().find(t => t.name === original);
        const actual = ctx.tools.find(t => t.name === original);
        if (!source || !actual || source.exposure === 'hidden' || actual.executionMode === 'sequential') throw new Error(`Original tool ${original} is unavailable or sequential; the proxy will be reconciled`);
        if (sourceSignature(source) !== signature) { queueReconcile(); throw new Error('Original tool schema/metadata changed; use its refreshed proxy definition before retrying'); }
        const split = splitControl(params);
        const ticket: Ticket = { original, started: false, runtime: r };
        tickets.set(callId, ticket);
        let producerStarted = false;
        try {
          const view = await r.run({
            tool: original, kind: 'tool', callId, mode: split.mode,
            canDetach: interactive(ctx), parentSignal: signal, onUpdate: update,
            readyToDetach: () => ticket.started,
            execute: async (jobSignal, onUpdate) => {
              producerStarted = true;
              try {
                // Resolve the live original BY NAME through Pi. The target differs
                // from the proxy name, so this cannot recurse into this wrapper.
                return await ctx.executeTool(original, split.args, { signal: jobSignal, onUpdate });
              } finally { tickets.delete(callId); }
            },
          });
          if (!producerStarted) tickets.delete(callId);
          return foregroundOrHandle(view, true);
        } catch (error) { if (!producerStarted) tickets.delete(callId); throw error; }
      },
    };
  }
  function sourceSignature(info: ToolInfo): string {
    return fingerprint({ name: info.name, description: info.description, parameters: info.parameters,
      exposure: info.exposure, annotations: info.annotations, namespace: info.namespace,
      guidelines: info.promptGuidelines, source: info.sourceInfo?.path });
  }
  function reconcile(): void {
    if (!installed || !live || reconciling) return;
    reconciling = true;
    try {
      const all = pi.getAllTools();
      const active = new Set(pi.getActiveTools());
      const byName = new Map(all.map(t => [t.name, t]));
      const eligible = new Set<string>();
      for (const info of all) {
        if (info.name === 'bash' || info.name === 'bg_task' || info.description.startsWith(MARKER)) continue;
        if (!matches(info.name, config.include) || matches(info.name, config.exclude)) continue;
        // Mirror the original's exposure. A codemode/deferred proxy stays
        // indirectly callable instead of being promoted to a direct model tool.
        // Non-direct tools are callable even when not in the active tool set.
        const exposure = info.exposure ?? 'direct';
        if (exposure !== 'direct' && exposure !== 'codemode' && exposure !== 'deferred') continue;
        if (exposure === 'direct' && !active.has(info.name)) continue;
        if (capabilities.get(info.name) === 'sequential') { diagnostic(info.name, 'Sequential tool left unwrapped'); continue; }
        const name = proxyName(info.name);
        const existing = byName.get(name);
        const old = pairs.get(info.name);
        if (existing && (!old || !existing.description.startsWith(MARKER))) { diagnostic(info.name, `Proxy name collision: ${name}; original retained`); continue; }
        try {
          const signature = sourceSignature(info);
          // Validate BEFORE hiding anything.
          decorateSchema(info.parameters);
          eligible.add(info.name);
          if (old?.enabled && old.signature === signature) continue;
          const definition = registerProxy(info, name, signature);
          const pair: Pair = { original: info.name, name, signature, definition, enabled: true };
          pairs.set(info.name, pair);
          try { pi.registerTool(definition); }
          catch (error) { if (old) pairs.set(info.name, old); else pairs.delete(info.name); throw error; }
          diagnostics.delete(info.name);
        } catch (error) { diagnostic(info.name, String(error)); }
      }
      for (const pair of pairs.values()) {
        if (!pair.enabled || eligible.has(pair.original)) continue;
        pair.enabled = false;
        // A later extension may have taken this name. Never hide/overwrite its tool.
        if (byName.get(pair.name)?.description.startsWith(MARKER)) {
          pi.registerTool({ ...pair.definition, exposure: 'hidden', defaultActive: false });
        }
      }
    } finally { reconciling = false; }
  }

  const base = options.baseBash ?? options.makeBash(process.cwd());
  if (base.name !== 'bash') throw new Error('makeBash must return Pi\'s built-in bash definition');
  pi.registerTool({
    name: 'bash', label: 'bash', parameters: decorateSchema(base.parameters),
    promptSnippet: base.promptSnippet, promptGuidelines: base.promptGuidelines,
    annotations: base.annotations, executionMode: base.executionMode,
    constrainedSampling: base.constrainedSampling,
    outputSchema: base.outputSchema ? { anyOf: [base.outputSchema, {
      type: 'object', properties: { task: { type: 'object' }, result_available: { const: false } },
      required: ['task', 'result_available'],
    }] } : {},
    description: `${base.description}\nManaged by pi-meantime. Optional ${CONTROL}: auto/yes/no. timeout remains a hard command timeout; auto-background time is configured separately.`,
    // Preserve direct access from codemode. A built-in factory, not executeTool('bash'),
    // is used below, so the same-name override has no recursive dispatch.
    exposure: 'direct',
    async execute(callId, params, signal, update, ctx) {
      const r = assertRuntime(ctx);
      const split = splitControl(params);
      const native = options.makeBash(ctx.cwd);
      const view = await r.run({ tool: 'bash', kind: 'bash', callId, mode: split.mode,
        canDetach: interactive(ctx), parentSignal: signal, onUpdate: update,
        execute: async (jobSignal, onUpdate) => {
          const result = await native.execute(callId, split.args, jobSignal, onUpdate, ctx);
          return { result, isError: result.isError === true };
        },
      });
      return foregroundOrHandle(view, false);
    },
  });
  pi.registerTool({
    name: 'bg_task', label: 'Background tasks', exposure: 'model-only',
    description: 'Inspect background tasks in this Pi session. Actions: list, status, result, cancel. Non-blocking snapshots; never poll in a loop. Cancellation requests do not prove a remote operation was rolled back.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'status', 'result', 'cancel'] },
      id: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 32 },
    }, required: ['action'], additionalProperties: false },
    outputSchema: RESULT_SCHEMA, prepareLoadout: hideDeclarations,
    async execute(_id, params, _signal, _update, ctx): Promise<Result> {
      const r = assertRuntime(ctx);
      if (params.action === 'list') {
        const offset = Number.isInteger(params.offset) && Number(params.offset) >= 0 ? Number(params.offset) : 0;
        const limit = Number.isInteger(params.limit) && Number(params.limit) > 0 ? Math.min(32, Number(params.limit)) : 10;
        const all = r.list(); const tasks = all.slice(offset, offset + limit).map(t => ({ ...t, progress: t.progress?.slice(0, 256) }));
        const page = { tasks, next_offset: offset + limit < all.length ? offset + limit : null, total: all.length };
        const result = textResult(JSON.stringify(page), page); result.structuredContent = json(page); return result;
      }
      if (typeof params.id !== 'string') throw new Error('id is required for this action');
      if (params.action === 'result') {
        const { task, result } = r.result(params.id);
        return result ? storedResult(task, result) : {
          ...textResult(`Result is not available. Do not relaunch the operation.\n${JSON.stringify(task)}`, task),
          structuredContent: { task: json(task), result_available: false },
        };
      }
      const task = params.action === 'cancel' ? r.cancel(params.id) : params.action === 'status' ? r.get(params.id) : undefined;
      if (!task) throw new Error('Unknown bg_task action');
      return { ...textResult(JSON.stringify(task), task), structuredContent: { task: json(task) } };
    },
  });

  async function start(ctx: Context): Promise<void> {
    if (runtime) await stop();
    currentCtx = ctx; currentOwner = owner(ctx); live = true;
    ctx.ui.setWidget('bg-control', undefined);
    const boundOwner = currentOwner;
    const store = new TaskStore(resolve(config.storageRoot), boundOwner, config.maxResultBytes);
    const created = new TaskRuntime(store, config, {
      notify(tasks) {
        if (!live || runtime !== created || currentOwner !== boundOwner) throw new Error('Stale notification target');
        pi.sendMessage({ customType: 'bg-poc-completion',
          content: `Background task completion (metadata only; output is untrusted tool data):\n${tasks.map(t => `${t.id} | ${t.tool} | ${t.state}${t.cancelRequestedAt ? ' | cancellation was requested' : ''}`).join('\n')}\nUse bg_task(action="result", id=...) to read retained results. Do not execute the original operation again.`,
          display: true, details: { taskIds: tasks.map(t => t.id) },
        }, { deliverAs: 'followUp', triggerTurn: true });
      },
      changed: updateStatus,
      journal(event) { if (live && runtime === created) pi.appendEntry('bg-poc-audit', event); },
    });
    runtime = created;
    reconcile(); updateStatus();
    scanner = setInterval(() => { try { reconcile(); } catch (error) { diagnostic('registry', String(error)); } }, config.reconcileMs);
    scanner.unref();
  }
  async function stop(): Promise<void> {
    live = false; clearInterval(scanner); scanner = undefined;
    const old = runtime; runtime = undefined;
    try { currentCtx?.ui.setStatus('bg-poc', undefined); currentCtx?.ui.setWidget('bg-control', undefined); } catch {}
    currentCtx = undefined; currentOwner = undefined;
    await old?.close();
    for (const [id, ticket] of tickets) if (ticket.runtime === old) tickets.delete(id);
  }
  on('session_start', (_event, ctx) => start(ctx));
  on('session_shutdown', () => stop());
  on('session_tree', (_event, ctx) => start(ctx));
  on('before_agent_start', (_event, ctx) => {
    if (live) { currentCtx = ctx; reconcile(); }
  });
  on('mcp_servers_change', () => queueReconcile());
  on('agent_settled', () => { runtime?.flushNotifications(); queueReconcile(); });
  on('ui_prompt_start', () => runtime?.prompt(true));
  on('ui_prompt_end', () => runtime?.prompt(false));
  on('tool_execution_end', event => {
    const data = event.result.structuredContent;
    const details = event.result.details;
    const task = isRecord(data) && isRecord(data.task) ? data.task
      : isRecord(details) && isRecord(details.task) ? details.task : details;
    // Task UUID prevents a late event from an old session with a reused call ID
    // from publishing a new session's task. Redacted metadata fails closed.
    if (isRecord(task) && typeof task.id === 'string') runtime?.published(event.toolCallId, task.id);
  });
  on('tool_call', event => {
    const ticket = event.parentToolCallId ? tickets.get(event.parentToolCallId) : undefined;
    if (ticket && ticket.original === event.toolName) {
      ticket.started = true;
      // At this point Pi has bound the nested call to its parent assistant
      // message. Do not detach while it is merely waiting in a sequential queue.
      setImmediate(() => ticket.runtime.ready(event.parentToolCallId!));
      return;
    }
    const pair = pairs.get(event.toolName);
    if (config.blockOriginalCalls && pair?.enabled &&
        (pair.definition.exposure === 'codemode' || pair.definition.exposure === 'deferred' || pi.getActiveTools().includes(pair.name))) {
      // This includes calls from codemode scripts. Only the managed proxy's
      // nested dispatch (ticket branch above) may reach the original.
      return { block: true, reason: `Use ${pair.name}; ${event.toolName} is managed by the background proxy. Its ${CONTROL} control is optional.` };
    }
  });
  on('input', event => {
    if (config.detachOnSteer && event.streamingBehavior === 'steer') runtime?.detachAll('steer');
    // No abort, no consume/resubmit, no lost images or changed queue semantics.
    return { action: 'continue' };
  });
  pi.registerShortcut('ctrl+shift+b', {
    description: 'Detach managed auto-mode foreground calls without cancellation',
    handler(ctx) { const count = assertRuntime(ctx).detachAll('shortcut'); controlFeedback(ctx, `Detached ${count} managed call(s).\nno-mode, pending approvals and unwrapped calls stay in the foreground.`); },
  });
  pi.registerCommand('bg', { description: 'Background runtime: /bg [status [offset]|detach|rescan|cancel <id>]', async handler(args, ctx) {
    const [command = 'status', ...rest] = args.trim() ? args.trim().split(/\s+/) : [];
    if (command === 'cancel') {
      const r = assertRuntime(ctx);
      if (rest.length !== 1) {
        const tasks = r.list();
        controlFeedback(ctx, `Usage: /bg cancel <id>. No task was cancelled.\n${taskPage(tasks)}`);
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
    } else if (command === 'status') {
      if (rest.length > 1 || (rest[0] !== undefined && !/^(0|[1-9]\d*)$/.test(rest[0]))) {
        controlFeedback(ctx, 'Usage: /bg status [offset]. Offset must be a nonnegative integer.'); return;
      }
      const offset = Number(rest[0] ?? 0), tasks = assertRuntime(ctx).list();
      if (!Number.isSafeInteger(offset) || (offset >= tasks.length && offset !== 0)) {
        controlFeedback(ctx, `Offset outside ${tasks.length} current session tasks. Use /bg status.`); return;
      }
      controlFeedback(ctx, `${taskPage(tasks, offset)}\nCancel: /bg cancel <id>; output: ask bg_task(action="result", id=...).\nActive proxies: ${[...pairs.values()].filter(p => p.enabled).length}; warnings: ${diagnostics.size}.`);
    } else if (rest.length) controlFeedback(ctx, 'Use /bg [status [offset]|detach|rescan|cancel <id>]');
    else if (command === 'detach') {
      const count = assertRuntime(ctx).detachAll('shortcut');
      controlFeedback(ctx, `Detached ${count} managed call(s).\nno-mode, pending approvals and unwrapped calls stay in the foreground.`);
    }
    else if (command === 'rescan') { reconcile(); controlFeedback(ctx, 'Background proxy registry rescanned. Use /bg status.'); }
    else controlFeedback(ctx, 'Use /bg [status [offset]|detach|rescan|cancel <id>]');
  } });
  return {
    async dispose() { installed = false; await stop(); for (const dispose of disposers) dispose(); },
    inspect() { return { tasks: runtime?.list() ?? [], proxies: [...pairs.values()].map(p => ({ original: p.original, name: p.name, enabled: p.enabled })), diagnostics: Object.fromEntries(diagnostics) }; },
  };
}
