import { AsyncLocalStorage } from 'node:async_hooks';
import type { createCodemodeExtension, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HostSession } from './host.ts';
import type { Outcome, Result, ScopeResult, Tool, Update } from './protocol.ts';

const definitions = new WeakSet<object>();
const storeOwner = new AsyncLocalStorage<() => void>();

/** Compose the public factory. No executor, worker admission or source transform. */
export function registerCodemode(pi: ExtensionAPI, factory: typeof createCodemodeExtension): void {
  factory()({ ...pi,
    appendEntry(type, data) { storeOwner.getStore()?.(); pi.appendEntry(type, data); },
    registerTool(native) {
      const prepare = native.prepareLoadout!;
      const definition = { ...native,
        prepareLoadout(loadout: Parameters<typeof prepare>[0]) {
          const result = prepare(loadout);
          return result && { ...result, hiddenDeclarations: result.hiddenDeclarations?.filter(name => name !== 'meantime') };
        },
      };
      definitions.add(definition);
      pi.registerTool(definition);
    },
  });
}
export function isNativeCodemode(definition: Tool): boolean { return definitions.has(definition); }
export function withStoreOwner<T>(check: () => void, execute: () => T): T { return storeOwner.run(check, execute); }

type Usage = NonNullable<Result['usage']>;
// Same additive fields as Pi's native nested-call accounting, including optional splits.
function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
interface Scope {
  recorder: { addUsage(usage: Usage): void };
}
interface NestedRunner {
  scopes: Map<string, Scope>;
  takeRecord(id: string): { calls?: Result['nestedCalls']; usage?: Usage } | undefined;
  clear(): void;
}
interface NestedSession {
  _nestedToolCalls?: NestedRunner;
  _executeNestedToolCall(parent: string, name: string, args: unknown, options?: { signal?: AbortSignal; onUpdate?: Update }): Promise<Outcome>;
}
interface Root {
  id: string; signal?: AbortSignal; pending: Set<Promise<unknown>>; producers: Set<string>;
  scope: Promise<ScopeResult | undefined>; resolveScope(value?: ScopeResult): void;
  late?: Outcome;
}

function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  if (saved?.configurable === false || (!saved && !Object.isExtensible(target))) throw new Error(`Cannot bridge readonly Pi property: ${String(key)}`);
  Object.defineProperty(target, key, { configurable: true, enumerable: saved?.enumerable ?? false, writable: true, value });
  return () => {
    if (target[key] !== value) return;
    if (saved) Object.defineProperty(target, key, saved);
    else delete target[key];
  };
}

/** Pi 1.3 instance bridge. Retain native scopes/recorder/counters, not a second runner.
 * Script observation finishes independently; its late scope has its own drain promise.
 * Native nested execute.finally deletes a child's scope even if its observer detached:
 * protect that exact producer's delete too, so its later grandchildren keep their IDs.
 */
export function codemodeScopes(host: HostSession) {
  const session = host as unknown as NestedSession;
  if (typeof session._executeNestedToolCall !== 'function' || !host.sessionManager?.appendUsage) {
    throw new Error('pi-meantime requires the Pi 1.3 nested-scope and usage bridge');
  }
  const roots = new Map<string, Root>();
  const held = new Set<string>();
  const execute = session._executeNestedToolCall;
  const restore: (() => void)[] = [];
  let runner: NestedRunner | undefined;
  let take: NestedRunner['takeRecord'] | undefined, clear: NestedRunner['clear'] | undefined;
  let remove: Map<string, Scope>['delete'] | undefined;
  let disposed = false;
  const belongs = (id: string, root: Root) => id === root.id || id.startsWith(`${root.id}/`);
  function rootFor(id: string): Root | undefined { return [...roots.values()].find(root => belongs(id, root)); }
  function changed(root: Root) {
    if (root.producers.size || root.pending.size) return;
    held.delete(root.id); roots.delete(root.id);
    if (root.late) {
      const summary = runner && take!.call(runner, root.id);
      root.resolveScope({ result: { ...root.late.result, nestedCalls: summary?.calls,
        ...(summary?.usage ? { usage: addUsage(root.late.result.usage, summary.usage) } : {}),
      }, usage: summary?.usage });
    } else root.resolveScope();
  }
  const takeHook: NestedRunner['takeRecord'] = function (this: NestedRunner, id) {
    return held.has(id) ? undefined : take!.call(this, id);
  };
  const deleteHook: Map<string, Scope>['delete'] = function (this: Map<string, Scope>, id) {
    return held.has(id) ? false : remove!.call(this, id);
  };
  const clearHook: NestedRunner['clear'] = function (this: NestedRunner) {
    const retained = [...this.scopes].filter(([id]) => rootFor(id));
    clear!.call(this);
    for (const [id, scope] of retained) this.scopes.set(id, scope);
  };
  function patchRunner() {
    const current = session._nestedToolCalls;
    if (!current || current === runner) return;
    if (runner) throw new Error('Pi replaced the live nested runner');
    if (!(current.scopes instanceof Map) || typeof current.takeRecord !== 'function' || typeof current.clear !== 'function') {
      throw new Error('Unsupported Pi nested-scope layout');
    }
    take = current.takeRecord; clear = current.clear; remove = current.scopes.delete;
    const undo: (() => void)[] = [];
    try {
      undo.push(override(current, 'takeRecord', takeHook));
      undo.push(override(current, 'clear', clearHook));
      undo.push(override(current.scopes, 'delete', deleteHook));
    } catch (error) { for (const unpatch of undo.reverse()) unpatch(); throw error; }
    runner = current; restore.push(...undo);
  }
  const executeHook: NestedSession['_executeNestedToolCall'] = function (this: NestedSession, parent, name, args, options) {
    const root = rootFor(parent);
    const signal = root?.signal;
    const pending = execute.call(this, parent, name, args, signal ? {
      ...options, signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
    } : options);
    // Native creation is synchronous, before execute reaches its first await.
    patchRunner();
    if (root) {
      root.pending.add(pending);
      void pending.finally(() => { root.pending.delete(pending); changed(root); }).catch(() => {});
    }
    return pending;
  };
  try {
    patchRunner();
    restore.push(override(session, '_executeNestedToolCall', executeHook));
  } catch (error) { for (const unpatch of restore.reverse()) unpatch(); throw error; }
  return {
    rootId(id: string) { return rootFor(id)?.id; },
    begin(id: string, native: boolean) {
      let root = native ? undefined : rootFor(id);
      if (native) {
        if (roots.has(id)) throw new Error(`Codemode call ID is still live: ${id}`);
        let resolveScope!: Root['resolveScope'];
        const scope = new Promise<ScopeResult | undefined>(resolve => { resolveScope = resolve; });
        root = { id, pending: new Set(), producers: new Set(), scope, resolveScope };
        roots.set(id, root);
      }
      if (!root) throw new Error('Missing codemode producer scope');
      const owner = root;
      owner.producers.add(id); held.add(id);
      let detached = false, ended = false;
      return {
        rootId: owner.id,
        scope: native ? owner.scope : undefined,
        detached() { detached = true; },
        signal(signal: AbortSignal) {
          if (native) owner.signal = signal;
          return !native && owner.signal ? AbortSignal.any([signal, owner.signal]) : signal;
        },
        finish(outcome: Outcome): Outcome {
          if (native) {
            if (owner.pending.size || owner.producers.size > 1) {
              // An explicit background child must not hold the caller hostage.
              // Retain its recorder and charge only the late nested delta later.
              owner.late = outcome;
              return outcome;
            }
            if (detached) {
              held.delete(id); // native takeRecord deletes through this Map too
              const summary = runner && take!.call(runner, id);
              if (summary) outcome = { ...outcome, result: { ...outcome.result,
                nestedCalls: summary.calls,
                ...(summary.usage ? { usage: addUsage(outcome.result.usage, summary.usage) } : {}),
              } };
            }
          } else if (detached && outcome.result.usage) {
            // The native pipeline recorded a handle (no usage). Donate the late
            // producer's own usage to its original recorder exactly once instead.
            runner?.scopes.get(id)?.recorder.addUsage(outcome.result.usage);
          }
          return outcome;
        },
        end() {
          if (ended) return;
          ended = true; owner.producers.delete(id);
          // Keep a late root held through native message_start and agent_end.
          if (!native) held.delete(id);
          // Foreground root record is still consumed by native message_start.
          // A child observer may already have run native execute.finally.
          if (!native && runner) remove!.call(runner.scopes, id);
          changed(owner);
        },
      };
    },
    dispose() {
      if (disposed) return;
      if (roots.size) throw new Error('Cannot dispose live codemode scopes before drain');
      disposed = true;
      for (const unpatch of restore.reverse()) unpatch();
    },
  };
}
