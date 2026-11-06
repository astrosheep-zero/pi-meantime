import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Snapshot, TaskRuntime } from './runtime.ts';
import { isRecord } from './schema.ts';

type Message = Parameters<AgentSession['sendCustomMessage']>[0];
export interface DeliveryEvent {
  type: string;
  message?: { role: string; customType?: string; details?: unknown };
}
export interface DeliveryHost {
  subscribe(listener: (event: DeliveryEvent) => void): () => void;
}

/** Keep completions in runtime's outbox until a public boundary or idle handoff.
 * Only message_end acknowledges consumption; agent-emitted messages need a
 * separate post-append barrier before their delivery receipt can be persisted. */
export class CompletionDelivery {
  private boundaries = 0;
  private staged = 0;
  private stopped = false;
  private wakeSuppressed = false;
  private closed = false;
  private waking = false;
  private consumed = new Set<string>();
  private retry?: ReturnType<typeof setTimeout>;
  private ready?: ReturnType<typeof setImmediate>;
  private unsubscribe: () => void;

  private runtime: TaskRuntime;
  private isIdle: () => boolean;
  private message: (tasks: Snapshot[]) => Message;
  private sendCustomMessage: AgentSession['sendCustomMessage'];

  constructor(runtime: TaskRuntime, host: DeliveryHost,
    isIdle: () => boolean, message: (tasks: Snapshot[]) => Message,
    sendCustomMessage: AgentSession['sendCustomMessage']) {
    this.runtime = runtime; this.isIdle = isIdle; this.message = message; this.sendCustomMessage = sendCustomMessage;
    this.unsubscribe = host.subscribe(event => {
      const message = event.message;
      if (this.closed || event.type !== 'message_end' || message?.role !== 'custom'
        || message.customType !== 'meantime-completion' || !isRecord(message.details)) return;
      const ids = message.details.taskIds;
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        runtime.notificationConsumed(ids);
        for (const id of ids) this.consumed.add(id);
        this.hostReady();
      }
    });
  }

  send(tasks: Snapshot[]): void | false {
    const boundary = this.boundaries > 0;
    // Busy completions stay ours: no steering queue, interception or withdrawal.
    if (this.closed || this.retry || (!boundary && (!this.isIdle() || this.waking))) return false;
    const ids = tasks.map(task => task.id);
    const triggerTurn = !boundary && !this.stopped && !this.wakeSuppressed;
    if (triggerTurn) this.waking = true;
    const failed = (error: unknown) => {
      if (this.closed) return;
      if (triggerTurn) this.waking = false;
      // The idle Promise covers the whole run. A late model/observer error
      // must not return an already consumed or explicitly observed notification.
      const delay = this.runtime.notificationFailed(ids, error);
      if (delay === undefined) { this.hostReady(); return; }
      this.wakeSuppressed = true;
      if (delay === 0) { this.hostReady(); return; }
      if (this.stopped || this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        if (!this.closed) this.runtime.flushNotifications();
      }, delay);
      this.retry.unref();
    };
    try {
      const pending = this.sendCustomMessage(this.message(tasks), { deliverAs: 'steer', triggerTurn });
      // Append-only handoff persists before its synchronous message_end receipt.
      this.flushDurable();
      if (boundary) this.staged += tasks.length;
      void pending.then(() => {
        if (triggerTurn) this.waking = false;
        this.hostReady();
      }, failed);
    } catch (error) { failed(error); }
  }

  async atBoundary(resume = false): Promise<boolean> {
    if (this.closed) return false;
    if (resume) { this.stopped = false; this.wakeSuppressed = false; }
    const before = this.staged;
    this.flushDurable();
    this.boundaries++;
    try {
      await this.runtime.flushNotificationsAtBoundary();
      return this.staged > before;
    } finally { this.boundaries--; }
  }

  settled(aborted = false): void {
    if (aborted) {
      this.stopped = true; this.wakeSuppressed = true;
      clearTimeout(this.retry); this.retry = undefined;
    }
    this.hostReady();
  }

  hostReady(): void {
    if (this.closed || this.ready) return;
    // Leave host dispatch and its message append before checking current state.
    this.ready = setImmediate(() => {
      this.ready = undefined;
      if (!this.closed) { this.flushDurable(); this.runtime.flushNotifications(); }
    });
  }

  private flushDurable(): void {
    if (this.closed || this.consumed.size === 0) return;
    const ids = [...this.consumed];
    if (this.runtime.notificationDurable(ids)) for (const id of ids) this.consumed.delete(id);
  }

  close(): void {
    this.closed = true;
    this.consumed.clear();
    clearTimeout(this.retry); this.retry = undefined;
    clearImmediate(this.ready); this.ready = undefined;
    this.unsubscribe();
  }
}
