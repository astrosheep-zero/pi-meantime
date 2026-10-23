import { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { codemodeScopes, override, withStoreOwner } from './codemode.ts';
import { runToolCall } from '@earendil-works/pi-agent-core';
import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Config } from './config.ts';
import type { DeliveryHost } from './notifications.ts';
import type { Mode, Outcome, PiHost, Result, ScopeResult, Tool, ToolContext, Update } from './protocol.ts';
import { decorateSchema, isRecord, matches, splitControl } from './schema.ts';

/** Pi 1.3 port. Native CodeMode additionally retains the session's nested scopes. */
export interface HostSession extends DeliveryHost {
  readonly sessionManager?: Pick<SessionManager, 'appendUsage' | 'getEntries'>;
  getAllTools: PiHost['getAllTools'];
  getToolDefinition(name: string): Tool | undefined;
  readonly agent: { toolExecution?: 'parallel' | 'sequential' };
  readonly extensionRunner: object;
  readonly resourceLoader: { getExtensions(): { runtime: { refreshTools(): void } } };
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
  codemodeRootId?: string; onDetach?(): void; onSettled?(): void;
  scope?: Promise<ScopeResult | undefined>; finalize?(outcome: Outcome): Outcome;
  execute(signal: AbortSignal, update: Update): Promise<Outcome>;
}
const FIELDS = ['parameters', 'prepareArguments', 'execute', 'outputSchema'] as const;
type Field = typeof FIELDS[number];
type Patch = Map<Field, { saved?: PropertyDescriptor; value: unknown }>;
const HANDLE_SCHEMA = { type: 'object', properties: { task: { type: 'object' }, result_available: { const: false } }, required: ['task', 'result_available'] };
// Pi 1.3 after reads only id/name, args and result, not this valid carrier stub.
const CARRIER: AssistantMessage = { role: 'assistant', content: [], api: 'openai-completions', provider: 'meantime', model: 'carrier',
  stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

// One permanent fence per session, not per runner: calls tagged by a retired
// generation never reach successor result hooks; untagged calls pass through.
const FENCE = Symbol.for('pi-meantime.result-fence');
type After = HostSession['_afterToolCall'];
interface Fence { native: After; owner?: object; calls: WeakMap<object, { owner: object; raw?: unknown; parent?: string }>; primitives: Map<string, object> }
const objectKey = (value: unknown): value is object => value !== null && typeof value === 'object';
function resultFence(session: HostSession): Fence {
  const existing = (session._afterToolCall as After & { [FENCE]?: Fence })[FENCE];
  if (existing) return existing;
  const fence: Fence = { native: session._afterToolCall, calls: new WeakMap(), primitives: new Map() };
  const hook: After = async function (this: HostSession, context, parentId) {
    const owner = objectKey(context.args) ? fence.calls.get(context.args)?.owner : fence.primitives.get(context.toolCall.id);
    if (objectKey(context.args)) fence.calls.delete(context.args);
    else fence.primitives.delete(context.toolCall.id);
    return owner !== undefined && owner !== fence.owner ? undefined : fence.native.call(this, context, parentId);
  };
  session._afterToolCall = Object.defineProperty(hook, FENCE, { value: fence });
  return fence;
}

export function manageTools(session: HostSession, config: Config, run: (call: ManagedCall) => Promise<Result>, diagnostic: (name: string, message: string) => void, codemodeExecute?: Tool['execute']) {
  const runner = session.extensionRunner, loaderRuntime = session.resourceLoader.getExtensions().runtime;
  const refresh = loaderRuntime.refreshTools;
  const fence = resultFence(session), token = {}; fence.owner = token;
  const patches = new Map<Tool, Patch>();
  let scopes: ReturnType<typeof codemodeScopes> | undefined;
  let codemode: Tool | undefined;
  let closing = false;
  // Copied definitions may contain our wrappers; unwrap exact identities only.
  const origins = new WeakMap<object, unknown>();
  const active = () => fence.owner === token && session.extensionRunner === runner && session.resourceLoader.getExtensions().runtime === loaderRuntime;
  const assertActive = () => { if (!active()) throw new Error('Managed tool session has retired'); };
  const isNativeCodemode = (definition: Tool) => definition === codemode;
  const eligible = (definition: Tool) => definition.name !== 'meantime' && definition.executionMode !== 'sequential' && definition.exposure !== 'hidden'
    && (definition.name === 'bash' || (matches(definition.name, config.include) && !matches(definition.name, config.exclude)))
    && (isNativeCodemode(definition) || ['direct', 'codemode', 'deferred'].includes(definition.exposure ?? 'direct'));
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
    const nativeCodemode = isNativeCodemode(definition);
    const fields = nativeCodemode ? ['execute'] as const : FIELDS;
    if (!eligible(definition)) return;
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(definition, key);
      if (descriptor?.configurable === false || (!descriptor && !Object.isExtensible(definition))) throw new Error(`Cannot decorate readonly tool property: ${key}`);
    }
    const parameters = nativeCodemode ? definition.parameters : decorateSchema(definition.parameters);
    const nativeExecute = nativeCodemode ? codemodeExecute! : definition.execute, prepare = definition.prepareArguments;
    const patch: Patch = new Map();
    const values = {
      parameters,
      prepareArguments(raw: unknown) {
        // Preserve primitive native repair; transport mode defaults to auto.
        const split = isRecord(raw) ? splitControl(raw) : undefined;
        return prepare ? prepare.call(definition, split ? split.args : raw) : split ? split.args : raw;
      },
      outputSchema: definition.outputSchema ? { anyOf: [definition.outputSchema, HANDLE_SCHEMA] } : {},
      async execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: Update | undefined, ctx: ToolContext): Promise<Result> {
        assertActive();
        if (closing) throw new Error('Managed tool session is closing');
        const frame = fence.calls.get(args);
        if (frame?.owner !== token) throw new Error('Managed tool execution requires the native lifecycle pipeline');
        // Before links raw and validated args; execute proves the whole permission
        // chain passed. Keep its final mutations without validating again.
        const mode = !nativeCodemode && isRecord(frame.raw) ? splitControl(frame.raw).mode : 'auto';
        // Ordinary descendants belong to the whole script, not to a second
        // observer. In particular mode:no alone would still detach on steer.
        const nestedRoot = frame.parent && scopes?.rootId(frame.parent);
        if (nestedRoot && mode !== 'yes') return nativeExecute.call(definition, id, args, signal, update, ctx);
        if (nativeCodemode) scopes ??= codemodeScopes(session);
        const lease = nativeCodemode || nestedRoot ? scopes!.begin(id, nativeCodemode) : undefined;
        let view: Promise<Result>;
        try { view = run({ name: definition.name, id, args, signal, update, ctx, mode,
          codemodeRootId: lease?.rootId, onDetach: lease ? () => lease.detached() : undefined,
          onSettled: lease ? () => lease.end() : undefined,
          scope: lease?.scope, finalize: lease ? outcome => lease.finish(outcome) : undefined,
          canDetach: session.agent.toolExecution !== 'sequential',
          async execute(jobSignal, onUpdate) {
            assertActive();
            jobSignal = lease?.signal(jobSignal) ?? jobSignal;
            const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(ctx);
            descriptors.signal = { value: jobSignal, enumerable: true };
            descriptors.tools = { ...descriptors.tools, get() { assertActive(); return ctx.tools; } };
            descriptors.executeTool = { ...descriptors.executeTool, value: (name: string, args: unknown, options?: Parameters<ToolContext['executeTool']>[2]) => {
              assertActive(); return ctx.executeTool(name, args, { ...options, signal: options?.signal ?? jobSignal });
            } };
            const jobCtx = Object.defineProperties({}, descriptors) as ToolContext;
            // Empty-schema carrier never revalidates permission-mutated args.
            return runToolCall({ type: 'toolCall', id, name: definition.name, arguments: {} }, {
              tools: [{ name: definition.name, label: definition.label, description: '',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                execute: (_id, _empty, signal, update) => withStoreOwner(() => {
                  assertActive();
                  if (closing || signal?.aborted) throw new Error('Codemode store owner has been cancelled');
                }, () => nativeExecute.call(definition, id, args, signal, update, jobCtx)) }],
              assistantMessage: CARRIER, context: { messages: [] }, signal: jobSignal, onUpdate,
              afterToolCall: inner => { assertActive(); return fence.native.call(session, { ...inner, args }, frame.parent); },
            });
          },
        }); } catch (error) { lease?.end(); throw error; } // Failed admission retains native finalization.
        fence.calls.set(args, { owner: fence }); // admitted: skip outer finalization
        return view;
      },
    };
    for (const key of fields) {
      const value = values[key]; patch.set(key, { saved: Object.getOwnPropertyDescriptor(definition, key), value });
      origins.set(value, definition[key]);
      Object.defineProperty(definition, key, { configurable: true, enumerable: true, writable: true, value });
    }
    patches.set(definition, patch);
  }
  function reconcile(): boolean {
    if (!active()) return false;
    const tools = session.getAllTools();
    codemode = codemodeExecute && tools.some(t => t.name === 'codemode' && t.sourceInfo?.path === 'builtin:codemode')
      ? session.getToolDefinition('codemode') : undefined;
    // Built-in MCP is a provider of external tools, not a native tool itself.
    const definitions = new Set(tools.filter(t => t.name === 'bash' || (t.name === 'codemode' && codemode)
      || !t.sourceInfo?.path?.startsWith('builtin:') || t.sourceInfo.path === 'builtin:mcp')
      .map(t => session.getToolDefinition(t.name)).filter((d): d is Tool => !!d));
    let changed = false;
    for (const [definition, patch] of patches) {
      if (definitions.has(definition) && eligible(definition) && [...patch].every(([key, { value }]) => definition[key] === value)) continue;
      restore(definition, patch); patches.delete(definition); changed = true;
    }
    for (const definition of definitions) if (!patches.has(definition)) {
      try { decorate(definition); changed ||= patches.has(definition); }
      catch (error) { diagnostic(definition.name, String(error)); }
    }
    return changed;
  }
  const refreshHook = () => {
    refresh.call(loaderRuntime);
    // Select the winner first; rebuild copied AgentTools only if raw fields changed.
    if (reconcile()) refresh.call(loaderRuntime);
  };
  // Tag before entering permissions, so suspended approvals keep their original
  // generation even after reload. The native hook still owns the entire chain.
  const before = session._beforeToolCall;
  const restoreBefore = override(session, '_beforeToolCall', function (this: HostSession, context, parent) {
    if (objectKey(context.args)) fence.calls.set(context.args, { owner: token, raw: context.toolCall.arguments, parent });
    else fence.primitives.set(context.toolCall.id, token);
    return before.call(this, context, parent);
  });
  loaderRuntime.refreshTools = refreshHook;
  refreshHook();
  return {
    refresh: refreshHook,
    end(id: string) { fence.primitives.delete(id); },
    names: () => [...patches.keys()].map(t => t.name),
    closeAdmission() { closing = true; },
    dispose() {
      scopes?.dispose();
      restoreBefore();
      if (fence.owner === token) fence.owner = undefined;
      if (loaderRuntime.refreshTools === refreshHook) loaderRuntime.refreshTools = refresh;
      for (const [definition, patch] of patches) restore(definition, patch);
      patches.clear();
      if (session.extensionRunner === runner) refresh.call(loaderRuntime);
    },
  };
}
