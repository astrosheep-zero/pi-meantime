/** Deterministic public-contract host double. It is deliberately named FakePi:
 * this is not an assertion that the real Pi UI/provider lifecycle was exercised. */
import { spawn } from 'node:child_process';
import type { Context, EventMap, Loadout, Outcome, PiHost, Result, Schema, Tool, ToolContext, ToolInfo, Update } from '../src/protocol.ts';
import { isRecord } from '../src/schema.ts';
import { ok, errorResult } from './helpers.ts';

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

export class FakePi implements PiHost {
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
  private queue: Promise<void> = Promise.resolve();
  ctx: Context;
  constructor(session = 'A', mode: Context['mode'] = 'tui') {
    this.ctx = { cwd: process.cwd(), mode, hasUI: mode === 'tui' || mode === 'rpc',
      signal: undefined, isIdle: () => true,
      sessionManager: { getSessionId: () => session, getSessionFile: () => `/sessions/${session}.jsonl`, getEntries: () => [...this.entries] },
      ui: { custom: async () => { throw new Error('Custom UI must be stubbed by the test'); }, notify: text => { this.uiMessages.push(text); }, setStatus: () => {}, setWidget: (key, lines) => { if (lines) { this.uiWidgets.set(key, [...lines]); this.uiMessages.push(lines.join('\n')); } else this.uiWidgets.delete(key); } },
    };
  }
  registerTool(tool: Tool): void {
    const old = this.definitions.get(tool.name);
    this.definitions.set(tool.name, tool); this.registrations++;
    if (tool.exposure === 'hidden') this.active.delete(tool.name);
    else if (tool.defaultActive !== false && ['direct', 'model-only'].includes(tool.exposure ?? 'direct')
      && (!old || !['direct', 'model-only'].includes(old.exposure ?? 'direct'))) this.active.add(tool.name);
    this.refresh();
  }
  refresh(): void {
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
  async emit<K extends keyof EventMap>(name: K, event: EventMap[K], ctx = this.ctx): Promise<unknown[]> {
    const output: unknown[] = [];
    for (const handler of [...(this.handlers.get(name) ?? [])]) output.push(await handler(event, ctx));
    return output;
  }
  registerShortcut(name: string, options: { handler: (ctx: Context) => void | Promise<void> }): void { this.shortcuts.set(name, options.handler); }
  registerCommand(name: string, options: { handler: (args: string, ctx: Context) => void | Promise<void> }): void { this.commands.set(name, options.handler); }
  sendMessage(message: { content: string; details?: unknown }): void { this.notifications.push(message); }
  appendEntry(customType: string, data?: unknown): void {
    this.journal.push(data); this.entries.push({ type: 'custom', customType, data: structuredClone(data) });
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome> {
    const id = `call_${++this.sequence}`;
    return this.dispatch(name, args, id, undefined, signal);
  }
  private async dispatch(name: string, args: Record<string, unknown>, id: string, parent: string | undefined,
    signal?: AbortSignal, onUpdate?: Update): Promise<Outcome> {
    this.trace.push({ type: 'start', name, id });
    const definition = this.definitions.get(name);
    let result: Result;
    let release: (() => void) | undefined;
    try {
      if (!definition || definition.exposure === 'hidden') throw new Error('Unknown tool');
      if (parent && !this.callable().some(t => t.name === name)) throw new Error('Tool is not callable');
      if (parent && (this.sequentialNested || definition.executionMode === 'sequential')) {
        const before = this.queue; this.queue = new Promise(resolve => { release = resolve; }); await before;
      }
      if (signal?.aborted) throw new Error('aborted');
      validate(definition.parameters, args);
      const decisions = await this.emit('tool_call', { type: 'tool_call', toolName: name, toolCallId: id, parentToolCallId: parent, input: args });
      const block = decisions.find(d => isRecord(d) && d.block === true) as Record<string, unknown> | undefined;
      if (block) throw new Error(String(block.reason));
      if (signal?.aborted) throw new Error('aborted');
      let childIndex = 0;
      const baseCtx = this.ctx;
      const host = this;
      const ctx: ToolContext = { ...baseCtx, signal, get tools() { return host.callable(); },
        executeTool: (target, input, opts) => this.dispatch(target, input as Record<string, unknown>, `${id}/${++childIndex}`, id, opts?.signal ?? signal, opts?.onUpdate),
      };
      this.trace.push({ type: 'execute', name, id, args: structuredClone(args) });
      result = await definition.execute(id, args, signal, partial => { this.updates.push(partial); onUpdate?.(partial); }, ctx);
    } catch (error) { result = errorResult(String(error)); }
    finally { release?.(); }
    for (const after of this.after) result = after(name, result);
    const isError = result.isError === true;
    this.trace.push({ type: 'end', name, id });
    await this.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: id, parentToolCallId: parent, toolName: name, result, isError });
    return { result, isError, toolCall: { id, name, arguments: args } };
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
  }, { parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'], additionalProperties: false } });
}
