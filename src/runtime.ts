import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Mode, Outcome, Result, Update } from './protocol.ts';
import { TaskStore, cleanText, truncateUtf8 } from './store.ts';

export type TaskState = 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
export type DetachReason = 'explicit' | 'shortcut' | 'steer' | 'timeout';
export interface Snapshot {
  id: string; tool: string; kind: 'bash' | 'tool'; state: TaskState;
  mode: Mode; delivery: 'foreground' | 'background'; createdAt: number;
  endedAt?: number; detachReason?: DetachReason; cancelRequestedAt?: number;
  localRunning: boolean; progress?: string; resultPath?: string;
  resultTruncated?: boolean; resultBytes?: number; storageError?: string;
  /** Final native Outcome error flag (or a local persistence error), independent of stale result.isError. */
  isError?: boolean;
  producerId?: string; recovered?: boolean; notification: 'none' | 'pending' | 'queued' | 'observed' | 'failed' | 'suppressed';
}
export type View = { kind: 'result'; task: Snapshot; result: Result; isError?: boolean; thrown?: { error: unknown } } | { kind: 'handle'; task: Snapshot };
export interface RunRequest {
  tool: string; kind: 'bash' | 'tool'; callId: string; mode: Mode;
  canDetach: boolean; parentSignal?: AbortSignal; onUpdate?: Update;
  readyToDetach?: () => boolean;
  execute(signal: AbortSignal, update: Update): Promise<Outcome>;
}
interface Task {
  meta: Snapshot; callId: string; ownsRecord: boolean; controller?: AbortController;
  result?: Result; published: boolean; observed: boolean; viewSettled: boolean;
  requestedDetach?: DetachReason; canDetach: boolean; readyToDetach?: () => boolean;
  resolveView?: (view: View) => void;
  cleanupParent?: () => void; autoTimer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  done?: Promise<void>; notifyAttempts: number; finishSequence?: number;
}
export interface RuntimeSink {
  notify(tasks: Snapshot[]): void;
  changed?(): void;
  journal?(event: { type: string; task: Snapshot }): void;
}
// Reloaded modules share admission only, not stale Pi contexts. Non-cooperative
// old producers continue to occupy a slot until they actually settle.
// Keep the original key so producers from v0.1.x still count after hot reload.
const LEASES = Symbol.for('pi-bg-poc.live-producer-leases.v1');
const globalState = globalThis as unknown as Record<symbol, Set<string> | undefined>;
function leases(): Set<string> { return globalState[LEASES] ??= new Set<string>(); }

function failure(error: unknown): Result {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
}
function snap(task: Task): Snapshot { return { ...task.meta }; }

export class TaskRuntime {
  readonly store: TaskStore;
  readonly config: Config;
  readonly tasks = new Map<string, Task>();
  private open = true;
  private readonly producerId = randomUUID();
  private promptDepth = 0;
  private promptResume?: ReturnType<typeof setImmediate>;
  private completionSequence = 0;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private sink: RuntimeSink;

  constructor(store: TaskStore, config: Config, sink: RuntimeSink) {
    this.store = store; this.config = config; this.sink = sink;
    const records = store.loadMetadata().sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    for (const raw of records) {
      if (typeof raw.id !== 'string' || !/^bg_[a-f0-9-]{36}$/.test(raw.id) || typeof raw.tool !== 'string') continue;
      const meta = raw as unknown as Snapshot;
      const unfinished = meta.localRunning || meta.state === 'running' || meta.state === 'cancel_requested';
      const restored: Snapshot = { ...meta, recovered: true, localRunning: false,
        state: unfinished ? 'outcome_unknown' : meta.state, notification: 'suppressed' };
      this.tasks.set(restored.id, { meta: restored, callId: '', ownsRecord: false, published: true, observed: false,
        viewSettled: true, canDetach: false, notifyAttempts: 0 });
    }
    this.prune();
  }

  run(request: RunRequest): Promise<View> {
    if (!this.open) throw new Error('Background runtime is closed');
    if (request.parentSignal?.aborted) throw new Error('Tool call was cancelled before admission');
    if (request.mode === 'yes' && !request.canDetach) throw new Error('Background execution is unavailable in print/json mode or for this tool');
    if (leases().size >= this.config.maxRunning) throw new Error(`Background capacity ${this.config.maxRunning} reached; inspect or cancel a task, do not retry in a loop`);
    const id = `bg_${randomUUID()}`;
    const meta: Snapshot = { id, tool: request.tool, kind: request.kind, mode: request.mode,
      state: 'running', delivery: 'foreground', createdAt: Date.now(), localRunning: true, notification: 'none', producerId: this.producerId };
    const task: Task = { meta, callId: request.callId, ownsRecord: true, controller: new AbortController(), published: false,
      observed: false, viewSettled: false, canDetach: request.canDetach, readyToDetach: request.readyToDetach, notifyAttempts: 0 };
    const view = new Promise<View>(resolve => { task.resolveView = resolve; });
    // Admission and its durable record precede starting any side effect.
    this.store.saveMeta(id, meta);
    this.tasks.set(id, task); leases().add(id);
    const onParentAbort = () => {
      if (task.meta.delivery === 'foreground' && !task.viewSettled) this.requestCancel(task, request.parentSignal?.reason);
    };
    request.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    task.cleanupParent = () => request.parentSignal?.removeEventListener('abort', onParentAbort);
    const update: Update = partial => {
      if (!task.meta.localRunning) return;
      task.meta.progress = truncateUtf8(cleanText(partial.content.filter(b => b.type === 'text').map(b => b.text).join('\n')), 2048);
      if (this.open && !task.viewSettled && task.meta.delivery === 'foreground') {
        try { request.onUpdate?.(partial); } catch { /* A dead renderer cannot kill the producer. */ }
      }
    };
    let thrown: { error: unknown } | undefined;
    task.done = Promise.resolve().then(() => {
      if (task.controller!.signal.aborted) throw new Error('Cancelled before execution');
      return request.execute(task.controller!.signal, update);
    }).then(outcome => {
      if (!outcome || typeof outcome.isError !== 'boolean' || !outcome.result || !Array.isArray(outcome.result.content) || !outcome.result.content.every(block => block && ((block.type === 'text' && typeof block.text === 'string') || (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')))) throw new Error('Malformed tool result; verify external state before retrying');
      // Preserve the native payload separately from its authoritative final flag.
      // afterToolCall may intentionally override a result's original isError.
      return { result: outcome.result, isError: outcome.isError };
    }).catch(error => {
      thrown = { error };
      return { result: failure(error), isError: true };
    }).then(outcome => this.finish(task, outcome.result, outcome.isError, thrown))
      .finally(() => { leases().delete(id); this.prune(); this.changed(); });
    if (request.mode === 'auto' && request.canDetach && this.config.autoDetachMs > 0) {
      task.autoTimer = setTimeout(() => this.detach(task, 'timeout'), this.config.autoDetachMs);
    }
    if (request.mode === 'yes') {
      // Let synchronous validation/hooks enter a UI prompt before deciding
      // whether it is safe to release the observer. Later remote elicitation
      // remains an upstream limitation, documented in DESIGN.md.
      setImmediate(() => { if (this.open) this.detach(task, 'explicit'); });
    }
    this.changed();
    return view;
  }

  detachAll(reason: Exclude<DetachReason, 'explicit'>): number {
    let count = 0;
    for (const task of this.tasks.values()) if (this.detach(task, reason)) count++;
    return count;
  }
  private detach(task: Task, reason: DetachReason): boolean {
    if (!this.open || task.viewSettled || !task.canDetach || task.meta.mode === 'no' || task.meta.state !== 'running') return false;
    if (this.promptDepth > 0 || this.promptResume || (task.readyToDetach && !task.readyToDetach())) { task.requestedDetach = reason; return false; }
    task.meta.delivery = 'background'; task.meta.detachReason = reason;
    task.cleanupParent?.(); task.cleanupParent = undefined;
    clearTimeout(task.autoTimer);
    this.persist(task);
    this.resolveView(task, { kind: 'handle', task: snap(task) });
    this.journal('detached', task);
    return true;
  }
  ready(callId: string): void {
    for (const task of this.tasks.values()) {
      if (task.callId === callId && task.requestedDetach) this.detach(task, task.requestedDetach);
    }
  }
  prompt(started: boolean): void {
    this.promptDepth = Math.max(0, this.promptDepth + (started ? 1 : -1));
    if (this.promptDepth === 0) {
      clearImmediate(this.promptResume);
      // Pi emits ui_prompt_end before the awaiting permission handler returns.
      // Let its grant/deny microtasks settle before releasing a pending waiter.
      // Keep every detach trigger gated during that continuation turn.
      this.promptResume = setImmediate(() => {
        this.promptResume = undefined;
        if (!this.open || this.promptDepth > 0) return;
        for (const task of this.tasks.values()) {
          if (task.requestedDetach) this.detach(task, task.requestedDetach);
        }
        this.scheduleNotifications();
      });
    }
  }
  private resolveView(task: Task, view: View): void {
    if (task.viewSettled) return;
    task.viewSettled = true;
    task.resolveView?.(view); task.resolveView = undefined;
    this.changed();
  }
  private finish(task: Task, result: Result, isError: boolean, thrown?: { error: unknown }): void {
    task.meta.localRunning = false; task.meta.endedAt = Date.now(); task.finishSequence = ++this.completionSequence;
    clearTimeout(task.autoTimer); clearTimeout(task.cancelTimer); task.cleanupParent?.();
    // These states describe Pi's returned outcome, never inferred remote rollback.
    task.meta.isError = isError;
    task.meta.state = isError ? 'failed' : 'completed';
    try {
      const current = this.store.readMeta(task.meta.id);
      if (!current || current.producerId !== this.producerId) throw new Error('Task lifecycle writer ownership changed or metadata disappeared');
      if (current.localRunning === false && typeof current.endedAt === 'number') throw new Error('Task already has terminal evidence; refusing to replace its result');
      const saved = this.store.saveResult(task.meta.id, result);
      task.result = saved.result; task.meta.resultPath = saved.path;
      task.meta.resultTruncated = saved.truncated; task.meta.resultBytes = saved.originalBytes;
    } catch (error) {
      // An operation may have succeeded; never silently retry it after losing its result.
      task.result = failure(`Result could not be persisted: ${String(error)}. The operation may already have executed; inspect externally before retrying.`);
      task.meta.storageError = String(error); task.meta.state = 'outcome_unknown'; task.meta.isError = true;
    }
    task.controller = undefined;
    if (!task.viewSettled) {
      task.observed = true; task.meta.notification = 'observed';
      // Retention may clean/truncate the disk copy; it must not change a
      // foreground result (or turn a successful operation into a storage error).
      task.published = true; // No task metadata is needed in the foreground reply.
      this.resolveView(task, { kind: 'result', task: snap(task), result, isError, thrown });
    } else if (task.meta.delivery === 'background' && !task.observed) {
      task.meta.notification = this.open ? 'pending' : 'suppressed';
    }
    this.persist(task); this.journal('settled', task);
    this.scheduleNotifications(); this.prune(); this.changed();
    if (task.meta.resultPath) task.result = undefined; // disk-backed retention, not N times a multi-MiB heap copy
  }
  published(callId: string, taskId?: string): void {
    for (const task of this.tasks.values()) if (task.callId === callId && (taskId === undefined || task.meta.id === taskId)) task.published = true;
    this.scheduleNotifications(); this.prune();
  }
  private lookup(id: string): Task {
    const task = this.tasks.get(id);
    if (!task || !this.refresh(task)) throw new Error('No task with that id in this session');
    return task;
  }
  // A recovered runtime is an observer, never the lifecycle writer. The original
  // producer may still complete after reload grace, so snapshots are not caches.
  private refresh(task: Task): boolean {
    if (task.ownsRecord) return true;
    const raw = this.store.readMeta(task.meta.id);
    if (!raw) { this.tasks.delete(task.meta.id); return false; }
    const meta = raw as unknown as Snapshot;
    const unfinished = meta.localRunning || meta.state === 'running' || meta.state === 'cancel_requested';
    task.meta = { ...meta, recovered: true, localRunning: false,
      state: unfinished ? 'outcome_unknown' : meta.state,
      notification: task.observed ? 'observed' : 'suppressed' };
    return true;
  }
  get(id: string): Snapshot { return snap(this.lookup(id)); }
  list(): Snapshot[] {
    for (const task of this.tasks.values()) this.refresh(task);
    return [...this.tasks.values()].map(snap).sort((a, b) => b.createdAt - a.createdAt);
  }
  result(id: string): { task: Snapshot; result?: Result } {
    const task = this.lookup(id);
    if (task.meta.localRunning || !task.meta.endedAt) return { task: snap(task) };
    const result = task.result ?? (task.meta.resultPath ? this.store.readResult(id) : undefined);
    if (result) {
      task.observed = true; task.meta.notification = 'observed';
      if (task.ownsRecord) this.persist(task);
      else {
        // Merge only acknowledgement into the latest canonical record. Never
        // write the observer's projected outcome_unknown/localRunning fields.
        this.store.updateMeta(id, current => ({ ...current, notification: 'observed' }));
        this.refresh(task);
      }
    }
    const view = { task: snap(task), result };
    this.prune(id);
    return view;
  }
  cancel(id: string): Snapshot {
    const task = this.lookup(id);
    // A retained terminal result has nothing left to cancel, including legacy
    // outcome_unknown records with endedAt. Only unfinished recovery lacks control.
    if (!task.meta.localRunning && task.meta.endedAt !== undefined) return snap(task);
    if (task.meta.recovered && !task.controller && task.meta.state === 'outcome_unknown') throw new Error('Recovered task has no live local controller; verify its external state. It will not be replayed.');
    this.requestCancel(task); return snap(task);
  }
  private requestCancel(task: Task, reason?: unknown): void {
    if (!task.meta.localRunning || !task.controller || task.meta.cancelRequestedAt) return;
    task.meta.cancelRequestedAt = Date.now(); task.meta.state = 'cancel_requested';
    clearTimeout(task.autoTimer);
    task.controller.abort(reason); this.persist(task); this.journal('cancel_requested', task);
    if (!task.viewSettled) {
      // Cancellation is cooperative for arbitrary tools. Release the observer
      // after grace, but do not free admission while a producer is still alive.
      task.cancelTimer = setTimeout(() => {
        if (task.viewSettled) return;
        task.meta.delivery = 'background'; task.cleanupParent?.();
        this.resolveView(task, { kind: 'handle', task: snap(task) });
      }, this.config.shutdownGraceMs);
    }
  }
  private eligible(): Task[] {
    return [...this.tasks.values()].filter(t => t.published && !t.observed && t.meta.notification === 'pending' && !t.meta.localRunning);
  }
  private scheduleNotifications(): void {
    if (!this.open || this.promptDepth > 0 || this.promptResume || this.notifyTimer || this.eligible().length === 0) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined; this.flushNotifications();
    }, this.config.notifyDebounceMs);
    this.notifyTimer.unref();
  }
  flushNotifications(): void {
    if (!this.open || this.promptDepth > 0 || this.promptResume) return;
    const batch = this.eligible().slice(0, 16); if (!batch.length) return;
    try {
      this.sink.notify(batch.map(snap));
      for (const task of batch) { task.meta.notification = 'queued'; this.persist(task); }
      this.scheduleNotifications();
    } catch {
      for (const task of batch) {
        task.notifyAttempts++;
        if (task.notifyAttempts >= 3) task.meta.notification = 'failed';
        this.persist(task);
      }
      this.scheduleNotifications();
    }
    // Pending items were protected at finish/publish. Queueing (or exhausting
    // retries) releases that protection even if no further task event occurs.
    this.prune(); this.changed();
  }
  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false; clearTimeout(this.notifyTimer); clearImmediate(this.promptResume); this.promptResume = undefined;
    for (const task of this.tasks.values()) {
      if (!task.ownsRecord) continue;
      this.requestCancel(task); task.meta.notification = 'suppressed';
      task.cleanupParent?.(); clearTimeout(task.autoTimer);
    }
    const pending = [...this.tasks.values()].flatMap(t => t.done ? [t.done] : []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.config.shutdownGraceMs);
    })]);
    clearTimeout(timer);
    for (const task of this.tasks.values()) {
      if (!task.ownsRecord) continue;
      clearTimeout(task.cancelTimer);
      if (task.meta.localRunning) task.meta.state = 'outcome_unknown';
      if (!task.viewSettled) this.resolveView(task, { kind: 'handle', task: snap(task) });
      this.persist(task);
    }
    // Old closures cannot send into a newly selected session.
    this.sink = { notify: () => {} };
  }
  private persist(task: Task): void {
    if (!task.ownsRecord) return;
    try {
      const saved = this.store.updateMeta(task.meta.id, current => {
        if (current.producerId !== this.producerId) throw new Error('Task lifecycle writer ownership changed');
        // Terminal evidence is immutable. Shutdown uncertainty has no endedAt,
        // so a late producer success can advance it, never the reverse.
        const terminal = current.localRunning === false && typeof current.endedAt === 'number';
        const next = terminal ? { ...current } : { ...current, ...task.meta };
        next.notification = current.notification === 'observed' || current.notification === 'queued'
          ? current.notification : task.meta.notification;
        if (task.meta.notification === 'observed') next.notification = 'observed';
        return next;
      });
      task.meta = saved as unknown as Snapshot;
    } catch (error) { task.meta.storageError = String(error); this.journal('storage_error', task); }
  }
  private journal(type: string, task: Task): void {
    if (this.open) { try { this.sink.journal?.({ type, task: snap(task) }); } catch { /* The disk snapshot remains authoritative. */ } }
  }
  private changed(): void { if (this.open) { try { this.sink.changed?.(); } catch {} } }
  private prune(retainId?: string): void {
    if (!this.open) return; // A retired runtime cannot delete its successor's records.
    const readable: Task[] = [];
    for (const task of this.tasks.values()) {
      try { if (this.refresh(task)) readable.push(task); }
      catch (error) { task.meta.storageError = String(error); this.journal('retention_error', task); }
    }
    const ended = readable.filter(t => !t.meta.localRunning && t.meta.endedAt !== undefined)
      .sort((a, b) => Number(b.meta.id === retainId) - Number(a.meta.id === retainId)
        || (b.meta.endedAt ?? 0) - (a.meta.endedAt ?? 0) || (b.finishSequence ?? 0) - (a.finishSequence ?? 0));
    for (const task of ended.slice(this.config.maxRetained)) {
      if (!task.published || task.meta.notification === 'pending' || leases().has(task.meta.id)) continue;
      try {
        const current = this.store.readMeta(task.meta.id);
        // Re-check authoritative state immediately before removing both files.
        // Unknown recovery is never evidence that a producer has stopped.
        if (current && (current.localRunning !== false || typeof current.endedAt !== 'number' || current.notification === 'pending')) continue;
        this.store.remove(task.meta.id); this.tasks.delete(task.meta.id);
      } catch (error) { task.meta.storageError = String(error); this.journal('retention_error', task); }
    }
  }
  static liveProducerCount(): number { return leases().size; }
}
