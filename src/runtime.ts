import type { Config } from './config.ts';
import type { Mode, Outcome, Result, Update } from './protocol.ts';
import { isRecord } from './schema.ts';
import { TASK_ID, newTaskId, truncateUtf8 } from './store.ts';

export type TaskState = 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
export type DetachReason = 'explicit' | 'shortcut' | 'steer' | 'timeout';
export interface Snapshot {
  id: string; tool: string; kind: 'bash' | 'tool'; state: TaskState; command?: string;
  mode: Mode; delivery: 'foreground' | 'background'; createdAt: number;
  endedAt?: number; detachReason?: DetachReason; cancelRequestedAt?: number;
  localRunning: boolean; progress?: string; outputPath?: string; exitCode?: number;
  indexError?: string;
  /** Final native Outcome error flag, independent of stale result.isError. */
  isError?: boolean;
  recovered?: boolean; notification: 'none' | 'pending' | 'queued' | 'observed' | 'failed' | 'suppressed';
}
export type TaskIndex = Pick<Snapshot, 'id' | 'tool' | 'kind' | 'command' | 'mode' | 'createdAt' | 'detachReason'>;
export interface Completion {
  id: string; endedAt: number; isError: boolean; cancelRequestedAt?: number;
  exitCode?: number; text: string; outputPath?: string;
}
export type TaskRecord = TaskIndex & { completion?: Completion };
export type IndexChange = { task: TaskIndex } | { completion: Completion } | { removed: string[] };
export type View = { kind: 'result'; task: Snapshot; result: Result; isError?: boolean; thrown?: { error: unknown } } | { kind: 'handle'; task: Snapshot };
export interface RunRequest {
  tool: string; kind: 'bash' | 'tool'; callId: string; mode: Mode; command?: string;
  canDetach: boolean; parentSignal?: AbortSignal; onUpdate?: Update;
  userDetach?: 'steer' | 'shortcut';
  execute(signal: AbortSignal, update: Update): Promise<Outcome>;
}
interface Task {
  meta: Snapshot; callId: string; controller?: AbortController;
  result?: Result; outputTail?: string; published: boolean; observed: boolean; viewSettled: boolean;
  requestedDetach?: DetachReason; canDetach: boolean;
  resolveView?: (view: View) => void;
  cleanupParent?: () => void; autoTimer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  done?: Promise<void>; notifyAttempts: number; finishSequence?: number; waiters: number;
}
export interface RuntimeSink {
  /** false defers handoff until the host's next idle flush. */
  notify(tasks: Snapshot[]): void | false;
  changed?(): void;
  index(change: IndexChange): void;
}
// Reloaded modules share only admission; old non-cooperative producers retain
// their slot until they settle, without retaining a successor's Pi context.
const LEASES = Symbol.for('pi-bg-poc.live-producer-leases.v1');
const globalState = globalThis as unknown as Record<symbol, Set<string> | undefined>;
function leases(): Set<string> { return globalState[LEASES] ??= new Set<string>(); }

function failure(error: unknown): Result {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
}
function snap(task: Task): Snapshot { return { ...task.meta }; }

export class TaskRuntime {
  readonly config: Config;
  readonly tasks = new Map<string, Task>();
  private open = true;
  private promptDepth = 0;
  private promptResume?: ReturnType<typeof setImmediate>;
  private completionSequence = 0;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private waitReleases = new Set<() => void>();
  private sink: RuntimeSink;

  constructor(config: Config, sink: RuntimeSink, records: TaskRecord[] = []) {
    this.config = config; this.sink = sink;
    for (const { completion, ...record } of records) {
      if (!TASK_ID.test(record.id)) continue;
      const meta: Snapshot = { ...record, delivery: 'background', state: 'outcome_unknown',
        recovered: true, localRunning: false, notification: 'suppressed' };
      if (completion) Object.assign(meta, { endedAt: completion.endedAt, isError: completion.isError,
        cancelRequestedAt: completion.cancelRequestedAt, exitCode: completion.exitCode,
        outputPath: completion.outputPath,
        state: completion.cancelRequestedAt !== undefined ? 'cancelled' : completion.isError ? 'failed' : 'completed' });
      this.tasks.set(meta.id, { meta, outputTail: completion?.text.slice(-1026), result: completion ? { content: [{ type: 'text', text: completion.text }], details: undefined } : undefined,
        callId: '', published: true, observed: false, viewSettled: true, canDetach: false, notifyAttempts: 0, waiters: 0 });
    }
  }

  run(request: RunRequest): Promise<View> {
    if (!this.open) throw new Error('Background runtime is closed');
    if (request.parentSignal?.aborted) throw new Error('Tool call was cancelled before admission');
    if (request.mode === 'yes' && !request.canDetach) throw new Error('Background execution is unavailable in print/json mode or for this tool');
    if (leases().size >= this.config.maxRunning) throw new Error(`Background capacity ${this.config.maxRunning} reached; inspect or cancel a task, do not retry in a loop`);
    let id = newTaskId();
    while (this.tasks.has(id) || leases().has(id)) id = newTaskId();
    const meta: Snapshot = { id, tool: request.tool, kind: request.kind, mode: request.mode,
      ...(request.command !== undefined ? { command: request.command } : {}),
      state: 'running', delivery: 'foreground', createdAt: Date.now(), localRunning: true, notification: 'none' };
    const task: Task = { meta, callId: request.callId, controller: new AbortController(), published: false,
      observed: false, viewSettled: false, canDetach: request.canDetach, notifyAttempts: 0, waiters: 0 };
    const view = new Promise<View>(resolve => { task.resolveView = resolve; });
    this.tasks.set(id, task); leases().add(id);
    const onParentAbort = () => {
      if (task.meta.delivery === 'foreground' && !task.viewSettled) this.requestCancel(task, request.parentSignal?.reason);
    };
    request.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    task.cleanupParent = () => request.parentSignal?.removeEventListener('abort', onParentAbort);
    const update: Update = partial => {
      if (!task.meta.localRunning) return;
      task.meta.progress = truncateUtf8(partial.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), 2048);
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
      // A producer may open a prompt after admission; let it enter the gate.
      setImmediate(() => { if (this.open) this.detach(task, 'explicit'); });
    }
    if (request.userDetach) {
      // Inherited pre-admission intent still passes prompt and index gates.
      setImmediate(() => this.detach(task, request.userDetach!));
    }
    this.changed();
    return view;
  }

  releaseWaiters(): void {
    for (const release of this.waitReleases) release();
  }
  detachAll(reason: Exclude<DetachReason, 'explicit'>): number {
    let count = 0;
    for (const task of this.tasks.values()) if (this.detach(task, reason)) count++;
    return count;
  }
  private detach(task: Task, reason: DetachReason): boolean {
    if (!this.open || task.viewSettled || !task.canDetach || (task.meta.mode === 'no' && reason === 'timeout') || task.meta.state !== 'running') return false;
    if (this.promptDepth > 0 || this.promptResume) { task.requestedDetach = reason; return false; }
    task.meta.detachReason = reason;
    return this.releaseToBackground(task);
  }
  private releaseToBackground(task: Task, force = false): boolean {
    if (task.meta.delivery === 'foreground') {
      const { id, tool, kind, command, mode, createdAt, detachReason } = task.meta;
      try { this.sink.index({ task: { id, tool, kind, command, mode, createdAt, detachReason } }); }
      catch (error) {
        task.meta.indexError = `Task index could not be saved: ${String(error)}`;
        if (!force) { task.canDetach = false; return false; }
      }
      task.meta.delivery = 'background';
    }
    task.cleanupParent?.(); task.cleanupParent = undefined;
    clearTimeout(task.autoTimer);
    this.resolveView(task, { kind: 'handle', task: snap(task) });
    return true;
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
    delete task.meta.progress; // Terminal previews must use finalized output, not a pre-hook partial.
    clearTimeout(task.autoTimer); clearTimeout(task.cancelTimer); task.cleanupParent?.();
    // Cancellation is a lifecycle fact, not a claim of remote rollback.
    task.meta.isError = isError;
    task.meta.state = task.meta.cancelRequestedAt !== undefined ? 'cancelled' : isError ? 'failed' : 'completed';
    task.controller = undefined;
    if (!task.viewSettled) {
      // Pi already persists the foreground result, including its native payload.
      this.resolveView(task, { kind: 'result', task: snap(task), result, isError, thrown });
      if (task.waiters) task.result = result;
      else this.tasks.delete(task.meta.id);
      return;
    }
    task.result = result;
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    task.outputTail = text.slice(-1026); // Enough UTF-16 units for the notification's UTF-8 tail budget.
    const data = isRecord(result.structuredContent) ? result.structuredContent : {};
    const details = isRecord(result.details) ? result.details : {};
    const path = data.full_output_path ?? details.fullOutputPath;
    const outputPath = typeof path === 'string' ? path : undefined;
    const exitCode = typeof data.exit_code === 'number' ? data.exit_code : undefined;
    Object.assign(task.meta, { outputPath, exitCode });
    try {
      if (this.open) this.sink.index({ completion: { id: task.meta.id, endedAt: task.meta.endedAt,
        isError, cancelRequestedAt: task.meta.cancelRequestedAt, exitCode, text, outputPath } });
    } catch (error) {
      task.meta.indexError = `Completion index could not be saved: ${String(error)}`;
    }
    task.meta.notification = this.open ? 'pending' : 'suppressed';
    this.scheduleNotifications(); this.prune(); this.changed();
  }
  published(callId: string, taskId?: string): void {
    for (const task of this.tasks.values()) if (task.callId === callId && (taskId === undefined || task.meta.id === taskId)) task.published = true;
    this.scheduleNotifications(); this.prune();
  }
  private lookup(id: string): Task {
    // Full id or a unique prefix (e.g. "mt_4495" or "4495").
    let task = this.tasks.get(id);
    if (!task && id.length > 0) {
      const needle = id.startsWith('mt_') ? id : `mt_${id}`;
      const hits = [...this.tasks.values()].filter(t => t.meta.id.startsWith(needle));
      if (hits.length > 1) throw new Error(`Ambiguous task id prefix ${id}: ${hits.map(t => t.meta.id).join(', ')}`);
      task = hits[0];
    }
    if (!task) throw new Error('No task with that id in this session');
    return task;
  }
  /** Wait (optionally requesting cancellation first), then acknowledge the available result. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal, cancel = false): Promise<{ task: Snapshot; result?: Result }> {
    signal?.throwIfAborted();
    const task = this.lookup(id);
    return this.withWaiters([task], async () => {
      if (cancel) this.cancel(id);
      signal?.throwIfAborted();
      await this.waitUntil(task.meta.localRunning ? task.done : undefined, timeoutMs, signal);
      return this.result(task.meta.id);
    });
  }
  async waitMany(ids: string[], mode: 'any' | 'all', timeoutMs: number, signal?: AbortSignal): Promise<{ tasks: { task: Snapshot; result?: Result }[]; pending: Snapshot[] }> {
    signal?.throwIfAborted();
    // Resolve every prefix before waiting or acknowledging any result.
    const tasks = [...new Set(ids.map(id => this.lookup(id)))];
    return this.withWaiters(tasks, async () => {
      const done = tasks.map(task => task.meta.localRunning ? task.done : undefined);
      await this.waitUntil(mode === 'any' ? Promise.race(done) : Promise.all(done), timeoutMs, signal);
      const settled: { task: Snapshot; result?: Result }[] = [], pending: Snapshot[] = [];
      for (const task of tasks) {
        const snapshot = this.get(task.meta.id);
        if (!snapshot.localRunning && snapshot.endedAt !== undefined) settled.push(this.result(task.meta.id));
        else pending.push(snapshot);
      }
      return { tasks: settled, pending };
    });
  }
  private async withWaiters<T>(tasks: Task[], operation: () => Promise<T>): Promise<T> {
    for (const task of tasks) task.waiters++;
    try {
      return await operation();
    } finally {
      for (const task of tasks) task.waiters--;
      this.scheduleNotifications(); this.prune();
    }
  }
  private async waitUntil(done: Promise<unknown> | undefined, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (done && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let release: (() => void) | undefined;
      try {
        await Promise.race([
          done,
          new Promise<void>(resolve => { release = resolve; this.waitReleases.add(resolve); }),
          new Promise<void>(resolve => {
            let remaining = timeoutMs;
            const schedule = () => {
              const chunk = Math.min(remaining, 2_147_483_647);
              timer = setTimeout(() => {
                remaining -= chunk;
                if (remaining > 0) schedule(); else resolve();
              }, chunk);
            };
            schedule();
          }),
          new Promise<void>((_resolve, reject) => {
            onAbort = () => reject(signal!.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
        if (release) this.waitReleases.delete(release);
      }
    }
  }
  get(id: string): Snapshot { return snap(this.lookup(id)); }
  list(): Snapshot[] {
    this.prune();
    return [...this.tasks.values()].map(snap).sort((a, b) => b.createdAt - a.createdAt);
  }
  result(id: string): { task: Snapshot; result?: Result } {
    const task = this.lookup(id);
    if (task.meta.localRunning || !task.meta.endedAt) return { task: snap(task) };
    const result = task.result;
    if (result) { task.observed = true; task.meta.notification = 'observed'; }
    const view = { task: snap(task), result };
    this.prune(task.meta.id);
    return view;
  }
  cancel(id: string): Snapshot {
    const task = this.lookup(id);
    // Terminal results have nothing left to cancel. Only unfinished recovery
    // lacks a local controller.
    if (!task.meta.localRunning && task.meta.endedAt !== undefined) return snap(task);
    if (task.meta.recovered && !task.controller && task.meta.state === 'outcome_unknown') throw new Error('Recovered task has no live local controller; verify its external state. It will not be replayed.');
    this.requestCancel(task); return snap(task);
  }
  private requestCancel(task: Task, reason?: unknown): void {
    if (!task.meta.localRunning || !task.controller || task.meta.cancelRequestedAt) return;
    task.meta.cancelRequestedAt = Date.now(); task.meta.state = 'cancel_requested';
    clearTimeout(task.autoTimer);
    task.controller.abort(reason);
    if (!task.viewSettled) {
      // Cancellation is cooperative for arbitrary tools. Release the observer
      // after grace, but do not free admission while a producer is still alive.
      task.cancelTimer = setTimeout(() => {
        if (task.viewSettled) return;
        this.releaseToBackground(task, true);
      }, this.config.shutdownGraceMs);
    }
  }
  private eligible(): Task[] {
    return [...this.tasks.values()].filter(t => t.published && !t.observed && !t.waiters && t.meta.notification === 'pending' && !t.meta.localRunning);
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
      if (this.sink.notify(batch.map(snap)) === false) return;
      for (const task of batch) task.meta.notification = 'queued';
      this.scheduleNotifications();
    } catch {
      for (const task of batch) {
        task.notifyAttempts++;
        if (task.notifyAttempts >= 3) task.meta.notification = 'failed';
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
      clearTimeout(task.cancelTimer);
      if (task.meta.localRunning) task.meta.state = 'outcome_unknown';
      if (!task.viewSettled) this.releaseToBackground(task, true);
    }
    // Old closures cannot send into a newly selected session.
    this.sink = { notify() {}, index() {} };
  }
  private changed(): void { if (this.open) { try { this.sink.changed?.(); } catch {} } }
  private prune(retainId?: string): void {
    if (!this.open) return; // A retired runtime cannot delete its successor's records.
    const ended = [...this.tasks.values()].filter(t => !t.meta.localRunning && t.meta.endedAt !== undefined)
      .sort((a, b) => Number(b.meta.id === retainId) - Number(a.meta.id === retainId)
        || (b.meta.endedAt ?? 0) - (a.meta.endedAt ?? 0) || (b.finishSequence ?? 0) - (a.finishSequence ?? 0));
    for (const task of ended.slice(this.config.maxRetained)) {
      if (!task.published || task.waiters || task.meta.notification === 'pending' || leases().has(task.meta.id)) continue;
      try {
        this.sink.index({ removed: [task.meta.id] }); this.tasks.delete(task.meta.id);
      } catch (error) { task.meta.indexError = String(error); }
    }
  }
  static liveProducerCount(): number { return leases().size; }
}
