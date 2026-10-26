/** Deterministic public-contract host double. It is deliberately named FakePi:
 * this is not an assertion that the real Pi UI/provider lifecycle was exercised. */
import { spawn } from 'node:child_process';
import type { Context, EventMap, Loadout, Outcome, PiHost, Result, Schema, Tool, ToolContext, ToolInfo, Update } from '../src/protocol.ts';
import { isRecord } from '../src/schema.ts';
import { runToolCall } from '@earendil-works/pi-agent-core';
import type { AfterToolCallContext, AgentToolCall, BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { HostSession } from '../src/host.ts';
import { ok } from './helpers.ts';

type Handler = (event: unknown, ctx: Context) => unknown | Promise<unknown>;
export function validate(schema: Schema, value: unknown): void {
  if (schema.type === 'object') {
    if (!isRecord(value)) throw new Error('Expected object');
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) throw new Error(`Missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validate(properties[key], item);
      else if (schema.additionalProperties === false) throw new Error(`Unexpected ${key}`);
    }
  }
  if (schema.type === 'string' && typeof value !== 'string') throw new Error('Expected string');
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Expected number');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error('Value is outside enum');
}

export class FakePi implements PiHost, HostSession {
  readonly renderers: Parameters<PiHost['registerToolRenderer']>[0][] = [];
  registerToolRenderer(resolver: Parameters<PiHost['registerToolRenderer']>[0]): void { this.renderers.push(resolver); }
  readonly messageRenderers = new Map<string, unknown>();
  registerMessageRenderer: PiHost['registerMessageRenderer'] = (customType, renderer) => { this.messageRenderers.set(customType, renderer); };
  readonly definitions = new Map<string, Tool>();
  readonly active = new Set<string>();
  readonly handlers = new Map<string, Handler[]>();
  readonly shortcuts = new Map<string, (ctx: Context) => void | Promise<void>>();
  readonly commands = new Map<string, (args: string, ctx: Context) => void | Promise<void>>();
  readonly notifications: { content: string; details?: unknown }[] = [];
  readonly journal: unknown[] = [];
  readonly entries: { type: string; customType?: string; data?: unknown }[] = [];
  readonly uiMessages: string[] = [];
  readonly uiWidgets = new Map<string, string[]>();
  readonly trace: { type: string; name?: string; id?: string; args?: unknown }[] = [];
  readonly updates: Result[] = [];
  readonly after: ((name: string, result: Result) => Result)[] = [];
  hidden = new Set<string>();
  registrations = 0;
  abortCalls = 0;
  sequence = 0;
  sequentialNested = false;
  ctx: Context;
  constructor(session = 'A', mode: Context['mode'] = 'tui') {
    this.ctx = { cwd: process.cwd(), mode, hasUI: mode === 'tui' || mode === 'rpc',
      signal: undefined, isIdle: () => true,
      sessionManager: { getSessionId: () => session, getSessionFile: () => `/sessions/${session}.jsonl`, getEntries: () => [...this.entries] },
      ui: { custom: async () => { throw new Error('Custom UI must be stubbed by the test'); }, notify: text => { this.uiMessages.push(text); }, setStatus: () => {}, setWidget: (key, lines) => { if (lines) { this.uiWidgets.set(key, [...lines]); this.uiMessages.push(lines.join('\n')); } else this.uiWidgets.delete(key); } },
    };
    this.registerTool(fixtureBash(process.cwd()));
  }
  registerTool(tool: Tool): void {
    const old = this.definitions.get(tool.name);
    this.definitions.set(tool.name, tool); this.registrations++;
    if (tool.exposure === 'hidden') this.active.delete(tool.name);
    else if (tool.defaultActive !== false && ['direct', 'model-only'].includes(tool.exposure ?? 'direct')
      && (!old || !['direct', 'model-only'].includes(old.exposure ?? 'direct'))) this.active.add(tool.name);
    this.refresh();
  }
  isStreaming = false;
  get agent() { return { toolExecution: this.sequentialNested ? 'sequential' as const : 'parallel' as const, hasQueuedMessages: () => false }; }
  readonly extensionRunner = { createToolContext: (id: string, signal?: AbortSignal): ToolContext => {
    let child = 0;
    return Object.defineProperties({ ...this.ctx, signal }, {
      tools: { get: () => this.callable() },
      executeTool: { value: (name: string, args: unknown, options?: { signal?: AbortSignal; onUpdate?: Update }) =>
        this.dispatch(name, args as Record<string, unknown>, `${id}/${++child}`, id, options?.signal ?? signal, options?.onUpdate) },
    }) as ToolContext;
  } };
  readonly runtime = { refreshTools: () => this.buildLoadout() };
  readonly resourceLoader = { getExtensions: () => ({ runtime: this.runtime }) };
  getToolDefinition(name: string): Tool | undefined { return this.definitions.get(name); }
  refresh(): void { this.runtime.refreshTools(); }
  private buildLoadout(): void {
    this.hidden = new Set();
    const declared = [...this.definitions.values()].filter(t => this.active.has(t.name));
    const loadout: Loadout = { declared, registered: [...this.definitions.values()], callable: this.callable(),
      getExposure: name => this.definitions.get(name)?.exposure ?? 'direct',
      getPromptGuidelines: name => this.definitions.get(name)?.promptGuidelines ?? [],
    };
    for (const tool of declared) {
      const changes = tool.prepareLoadout?.(loadout);
      for (const name of changes?.hiddenDeclarations ?? []) this.hidden.add(name);
    }
  }
  callable(): Tool[] {
    return [...this.definitions.values()].filter(t => {
      const exposure = t.exposure ?? 'direct';
      return exposure === 'codemode' || exposure === 'deferred' || (exposure === 'direct' && this.active.has(t.name));
    });
  }
  modelTools(): string[] { this.refresh(); return [...this.active].filter(name => !this.hidden.has(name)); }
  getAllTools(): ToolInfo[] {
    return [...this.definitions.values()].map(t => ({
      name: t.name, description: t.description, parameters: t.parameters, exposure: t.exposure ?? 'direct',
      namespace: t.namespace, annotations: t.annotations, promptGuidelines: t.promptGuidelines,
      sourceInfo: t.sourceInfo,
    }));
  }
  getActiveTools(): string[] { return [...this.active]; }
  getSettings(): Record<string, unknown> { return {}; }
  on<K extends keyof EventMap>(name: K, handler: (event: EventMap[K], ctx: Context) => unknown | Promise<unknown>): () => void {
    const fn = handler as Handler; const list = this.handlers.get(name) ?? []; list.push(fn); this.handlers.set(name, list);
    return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
  }
  private listeners = new Set<(event: { type: string; toolCallId?: string; message?: { role: string; customType?: string; details?: unknown } }) => void>();
  subscribe(listener: (event: { type: string; toolCallId?: string; message?: { role: string; customType?: string; details?: unknown } }) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async emit<K extends keyof EventMap>(name: K, event: EventMap[K], ctx = this.ctx): Promise<unknown[]> {
    const output: unknown[] = [];
    for (const handler of [...(this.handlers.get(name) ?? [])]) output.push(await handler(event, ctx));
    for (const listener of this.listeners) listener(event);
    return output;
  }
  registerShortcut(name: string, options: { handler: (ctx: Context) => void | Promise<void> }): void { this.shortcuts.set(name, options.handler); }
  registerCommand(name: string, options: { handler: (args: string, ctx: Context) => void | Promise<void> }): void { this.commands.set(name, options.handler); }
  async sendCustomMessage(message: Parameters<HostSession['sendCustomMessage']>[0]): Promise<void> {
    this.notifications.push({ ...message, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
    // Deterministic fixture receipt; real SDK persistence is tested separately.
    for (const listener of this.listeners) listener({ type: 'message_end', message: { role: 'custom', ...message } });
  }
  appendEntry(customType: string, data?: unknown): void {
    this.journal.push(data); this.entries.push({ type: 'custom', customType, data: structuredClone(data) });
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome> {
    const id = `call_${++this.sequence}`;
    return this.dispatch(name, args, id, undefined, signal);
  }
  async _beforeToolCall(context: BeforeToolCallContext, parentId?: string) {
    const decisions = await this.emit('tool_call', { type: 'tool_call', toolName: context.toolCall.name,
      toolCallId: context.toolCall.id, parentToolCallId: parentId, input: context.args as Record<string, unknown> });
    return decisions.find(d => isRecord(d) && d.block === true) as { block: boolean; reason: string } | undefined;
  }
  async _afterToolCall(context: AfterToolCallContext, _parentId?: string) {
    let result: Result = context.result;
    for (const after of this.after) result = after(context.toolCall.name, result);
    return this.after.length ? { ...result, isError: result.isError === true } : undefined;
  }
  private async dispatch(name: string, args: Record<string, unknown>, id: string, parent: string | undefined,
    signal?: AbortSignal, onUpdate?: Update): Promise<Outcome> {
    this.trace.push({ type: 'start', name, id });
    await this.emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: id, toolName: name, args, parentToolCallId: parent });
    const definition = this.definitions.get(name);
    const toolCall: AgentToolCall = { type: 'toolCall', id, name, arguments: args as AgentToolCall['arguments'] };
    const assistantMessage = { role: 'assistant' as const, content: [toolCall], api: 'openai-completions' as const, provider: 'fake', model: 'fake',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse' as const, timestamp: Date.now() };
    const ctx = this.extensionRunner.createToolContext(id, signal);
    const tools = definition && definition.exposure !== 'hidden' && (!parent || this.callable().some(t => t.name === name)) ? [{ ...definition,
      execute: async (_id: string, input: unknown, s?: AbortSignal, update?: Update) => {
        this.trace.push({ type: 'execute', name, id, args: structuredClone(input) });
        return definition.execute(id, input as Record<string, unknown>, s, update, ctx);
      } }] : [];
    const outcome = await runToolCall(toolCall, { tools, assistantMessage, context: { messages: [assistantMessage], tools }, signal,
      beforeToolCall: context => this._beforeToolCall(context, parent),
      afterToolCall: context => this._afterToolCall(context, parent),
      onUpdate: partial => { this.updates.push(partial); onUpdate?.(partial); },
    });
    this.trace.push({ type: 'end', name, id });
    await this.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: id, parentToolCallId: parent,
      toolName: name, result: outcome.result, isError: outcome.isError });
    return outcome;
  }
}

export function basicTool(name: string, execute: Tool['execute'] = async () => ok().result, extra: Partial<Tool> = {}): Tool {
  return { name, label: name, description: `Fixture ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false }, exposure: 'direct', execute, ...extra };
}
/** Real local shell fixture. Production uses Pi's own Bash factory, not this. */
export function fixtureBash(cwd: string): Tool {
  return basicTool('bash', async (_id, args, signal, update) => {
    const command = String(args.command);
    return new Promise<Result>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let timer: ReturnType<typeof setTimeout> | undefined;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      if (signal?.aborted) kill(); else signal?.addEventListener('abort', kill, { once: true });
      if (typeof args.timeout === 'number') timer = setTimeout(kill, args.timeout * 1000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
        output = (output + String(b)).slice(-32 * 1024); update?.(ok(output).result);
      });
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', kill);
        if (signal?.aborted) reject(new Error('aborted'));
        else if (code !== 0) reject(new Error(`exit ${code}: ${output}`));
        else resolve(ok(output).result);
      });
    });
  }, { sourceInfo: { path: 'builtin:bash' }, parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'], additionalProperties: false } });
}
