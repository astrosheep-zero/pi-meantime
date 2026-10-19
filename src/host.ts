import { AgentSession } from '@earendil-works/pi-coding-agent';
import { runToolCall } from '@earendil-works/pi-agent-core';
import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import type { Config } from './config.ts';
import type { Mode, Outcome, PiHost, Result, Tool, ToolContext, Update } from './protocol.ts';
import { decorateSchema, isRecord, matches, splitControl } from './schema.ts';

/** Pi 1.3 port: only the shared before/after methods are private seams. */
export interface HostSession {
  getAllTools: PiHost['getAllTools'];
  getToolDefinition(name: string): Tool | undefined;
  readonly agent: { toolExecution?: 'parallel' | 'sequential' };
  readonly extensionRunner: { createToolContext(id: string, signal?: AbortSignal): ToolContext };
  readonly resourceLoader: { getExtensions(): { runtime: { refreshTools(): void } } };
  subscribe(listener: (event: { type: string; toolCallId?: string }) => void): () => void;
  _beforeToolCall(context: BeforeToolCallContext, parentId?: string): Promise<BeforeToolCallResult | undefined>;
  _afterToolCall(context: AfterToolCallContext, parentId?: string): Promise<AfterToolCallResult | undefined>;
}
export function captureSession(pi: PiHost, Session = AgentSession): HostSession {
  const original = Session.prototype.getAllTools;
  let captured: AgentSession | undefined;
  const intercept: typeof original = function (this: AgentSession) { captured = this; return original.call(this); };
  try {
    Session.prototype.getAllTools = intercept;
    pi.getAllTools(); // same-module, synchronous capture
  } finally { if (Session.prototype.getAllTools === intercept) Session.prototype.getAllTools = original; }
  if (!captured) throw new Error('pi-meantime requires the Pi 1.3 current-session bridge');
  return captured as unknown as HostSession;
}
export interface ManagedCall {
  name: string; id: string; args: Record<string, unknown>; mode: Mode;
  signal?: AbortSignal; update?: Update; ctx: ToolContext; canDetach: boolean;
  execute(signal: AbortSignal, update: Update): Promise<Outcome>;
}
const FIELDS = ['parameters', 'prepareArguments', 'execute', 'outputSchema'] as const;
type Field = typeof FIELDS[number];
type Patch = Map<Field, { saved?: PropertyDescriptor; value: unknown }>;
const HANDLE_SCHEMA = { type: 'object', properties: { task: { type: 'object' }, result_available: { const: false } }, required: ['task', 'result_available'] };

// One fence per session, not per runner. Weak tags never retain retired runners.
const FENCE = Symbol.for('pi-meantime.result-fence');
type After = HostSession['_afterToolCall'];
interface Fence {
  native: After; hook: After; owner?: object;
  calls: WeakMap<object, object>; pending: Map<string, object>;
  end(id?: string, call?: object): void;
}
function resultFence(session: HostSession): Fence {
  const existing = (session._afterToolCall as After & { [FENCE]?: Fence })[FENCE];
  if (existing) return existing;
  const fence: Fence = { native: session._afterToolCall, hook: undefined!, calls: new WeakMap(), pending: new Map(),
    end(id, call) {
      if (id !== undefined && (!call || fence.pending.get(id) === call)) fence.pending.delete(id);
      if (!fence.owner && !fence.pending.size) {
        if (session._afterToolCall === fence.hook) session._afterToolCall = fence.native;
        unsubscribe();
      }
    } };
  fence.hook = async function (context, parentId) {
    const owner = fence.calls.get(context.toolCall);
    const skip = owner !== undefined && owner !== fence.owner;
    fence.end(context.toolCall.id, context.toolCall);
    return skip ? undefined : fence.native.call(this, context, parentId);
  };
  Object.defineProperty(fence.hook, FENCE, { value: fence });
  const unsubscribe = session.subscribe(event => { if (event.type === 'tool_execution_end') fence.end(event.toolCallId!); });
  session._afterToolCall = fence.hook;
  return fence;
}

export function manageTools(session: HostSession, config: Config, run: (call: ManagedCall) => Promise<Result>, diagnostic: (name: string, message: string) => void) {
  const runner = session.extensionRunner, loaderRuntime = session.resourceLoader.getExtensions().runtime;
  const before = session._beforeToolCall, refresh = loaderRuntime.refreshTools;
  const fence = resultFence(session), token = {}; fence.owner = token;
  const patches = new Map<Tool, Patch>(), frames = new Map<string, { context: BeforeToolCallContext; parentId?: string; mode: Mode }>();
  const modes = new WeakMap<object, Mode>();
  // Copied definitions may contain our wrappers; unwrap exact identities only.
  const origins = new WeakMap<object, unknown>();
  const active = () => fence.owner === token && session.extensionRunner === runner && session.resourceLoader.getExtensions().runtime === loaderRuntime;
  const assertActive = () => { if (!active()) throw new Error('Managed tool session has retired'); };
  function restore(definition: Tool, patch: Patch): void {
    for (const [key, { saved, value }] of patch) if (definition[key] === value) {
      if (saved) Object.defineProperty(definition, key, saved);
      else delete definition[key];
    }
  }
  function decorate(definition: Tool): void {
    for (const key of FIELDS) {
      const value = definition[key];
      if (value && (typeof value === 'object' || typeof value === 'function') && origins.has(value)) {
        Object.defineProperty(definition, key, { ...Object.getOwnPropertyDescriptor(definition, key), value: origins.get(value) });
      }
    }
    const exposure = definition.exposure ?? 'direct';
    if (definition.name === 'meantime' || (definition.name !== 'bash' && (!matches(definition.name, config.include) || matches(definition.name, config.exclude)))
      || !['direct', 'codemode', 'deferred'].includes(exposure) || definition.executionMode === 'sequential') return;
    for (const key of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(definition, key);
      if (descriptor?.configurable === false || (!descriptor && !Object.isExtensible(definition))) throw new Error(`Cannot decorate readonly tool property: ${key}`);
    }
    const parameters = decorateSchema(definition.parameters);
    const nativeExecute = definition.execute, prepare = definition.prepareArguments;
    const patch: Patch = new Map();
    const values = {
      parameters,
      prepareArguments(raw: unknown) {
        // Preserve primitive native repair; transport mode defaults to auto.
        const split = isRecord(raw) ? splitControl(raw) : undefined;
        if (split) modes.set(raw as object, split.mode);
        return prepare ? prepare.call(definition, split ? split.args : raw) : split ? split.args : raw;
      },
      outputSchema: definition.outputSchema ? { anyOf: [definition.outputSchema, HANDLE_SCHEMA] } : {},
      async execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: Update | undefined, ctx: ToolContext): Promise<Result> {
        assertActive();
        const frame = frames.get(id); frames.delete(id);
        if (!frame) throw new Error('Managed tool execution requires the native permission pipeline');
        const view = run({ name: definition.name, id, args, signal, update, ctx, mode: frame.mode,
          canDetach: session.agent.toolExecution !== 'sequential',
          async execute(jobSignal, onUpdate) {
            assertActive();
            const base = runner.createToolContext(id, jobSignal);
            const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(base);
            descriptors.signal = { value: jobSignal, enumerable: true };
            descriptors.tools = { ...descriptors.tools, get() { assertActive(); return base.tools; } };
            descriptors.executeTool = { ...descriptors.executeTool, value: (...input: Parameters<ToolContext['executeTool']>) => { assertActive(); return base.executeTool(...input); } };
            const jobCtx = Object.defineProperties({}, descriptors) as ToolContext;
            // Never revalidate native args after permission mutations.
            return runToolCall({ ...frame.context.toolCall, arguments: {}, argumentsError: undefined }, {
              tools: [{ name: definition.name, label: definition.label, description: '',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                execute: (_id, _empty, signal, update) => nativeExecute.call(definition, id, args, signal, update, jobCtx) }],
              assistantMessage: frame.context.assistantMessage, context: frame.context.context, signal: jobSignal, onUpdate,
              afterToolCall: inner => { assertActive(); return fence.native.call(session, { ...inner, toolCall: frame.context.toolCall, args }, frame.parentId); },
            });
          },
        }); // Synchronous admission may throw: retain native outer finalization.
        fence.calls.set(frame.context.toolCall, fence); // admitted: skip outer finalization
        return view;
      },
    };
    for (const key of FIELDS) {
      const value = values[key]; patch.set(key, { saved: Object.getOwnPropertyDescriptor(definition, key), value });
      origins.set(value, definition[key]);
      Object.defineProperty(definition, key, { configurable: true, enumerable: true, writable: true, value });
    }
    patches.set(definition, patch);
  }
  function reconcile(): boolean {
    if (!active()) return false;
    const definitions = new Set(session.getAllTools().map(t => session.getToolDefinition(t.name)).filter((d): d is Tool => !!d));
    let changed = false;
    for (const [definition, patch] of patches) {
      if (definitions.has(definition) && [...patch].every(([key, { value }]) => definition[key] === value)
        && ['direct', 'codemode', 'deferred'].includes(definition.exposure ?? 'direct') && definition.executionMode !== 'sequential') continue;
      restore(definition, patch); patches.delete(definition); changed = true;
    }
    for (const definition of definitions) if (!patches.has(definition)) {
      try { decorate(definition); changed ||= patches.has(definition); }
      catch (error) { diagnostic(definition.name, String(error)); }
    }
    return changed;
  }
  const beforeHook: HostSession['_beforeToolCall'] = async function (this: HostSession, context, parentId) {
    fence.calls.set(context.toolCall, token); fence.pending.set(context.toolCall.id, context.toolCall);
    try {
      const result = await before.call(this, context, parentId);
      if (result?.block) fence.end(context.toolCall.id, context.toolCall);
      else if (active() && patches.has(session.getToolDefinition(context.toolCall.name)!)) {
        const raw = context.toolCall.arguments;
        frames.set(context.toolCall.id, { context, parentId, mode: isRecord(raw) ? modes.get(raw) ?? 'auto' : 'auto' });
      }
      return result;
    } catch (error) { fence.end(context.toolCall.id, context.toolCall); throw error; }
  };
  const refreshHook = () => {
    refresh.call(loaderRuntime);
    // Select the winner first; rebuild copied AgentTools only if raw fields changed.
    if (reconcile()) refresh.call(loaderRuntime);
  };
  session._beforeToolCall = beforeHook;
  loaderRuntime.refreshTools = refreshHook;
  refreshHook();
  return {
    refresh: refreshHook,
    end(id: string) { frames.delete(id); },
    names: () => [...patches.keys()].map(t => t.name),
    retire() { frames.clear(); if (fence.owner === token) fence.owner = undefined; },
    dispose() {
      frames.clear(); if (fence.owner === token) fence.owner = undefined;
      if (session._beforeToolCall === beforeHook) session._beforeToolCall = before;
      if (loaderRuntime.refreshTools === refreshHook) loaderRuntime.refreshTools = refresh;
      for (const [definition, patch] of patches) restore(definition, patch);
      patches.clear();
      fence.end();
      if (session.extensionRunner === runner) refresh.call(loaderRuntime);
    },
  };
}
