import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Snapshot, TaskRuntime } from './runtime.ts';
import { isRecord } from './schema.ts';

type Message = Parameters<AgentSession['sendCustomMessage']>[0];
export interface DeliveryEvent {
  type: string;
  message?: { role: string; customType?: string; details?: unknown };
}
export interface DeliveryHost {
  readonly isStreaming: boolean;
  readonly agent: { hasQueuedMessages(): boolean };
  sendCustomMessage: AgentSession['sendCustomMessage'];
  subscribe(listener: (event: DeliveryEvent) => void): () => void;
}

/** One outbox bridge: use steering as a volatile fast path, stage at request
 * boundaries, and acknowledge only message_end consumption, never enqueue
 * success. Unconsumed fast-path messages return once the host queue is empty.
 * Stop and failed wakeups suppress only automatic turns; idle delivery remains
 * append-only. Receipts are not disk durability (idle sends emit before persistence). */
export class CompletionDelivery {
  private boundaries = 0;
  private staged = 0;
  private wakePaused = false;
  private closed = false;
  private fastQueued = new Set<string>();
  private ready?: ReturnType<typeof setImmediate>;
  private unsubscribe: () => void;

  private runtime: TaskRuntime;
  private host: DeliveryHost;
  private isIdle: () => boolean;
  private message: (tasks: Snapshot[]) => Message;

  constructor(runtime: TaskRuntime, host: DeliveryHost,
    isIdle: () => boolean, message: (tasks: Snapshot[]) => Message) {
    this.runtime = runtime; this.host = host; this.isIdle = isIdle; this.message = message;
    this.unsubscribe = host.subscribe(event => {
      const message = event.message;
      if (this.closed || event.type !== 'message_end' || message?.role !== 'custom'
        || message.customType !== 'meantime-completion' || !isRecord(message.details)) return;
      const ids = message.details.taskIds;
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        runtime.notificationConsumed(ids);
        for (const id of ids) this.fastQueued.delete(id);
      }
    });
  }

  send(tasks: Snapshot[]): void | false {
    const boundary = this.boundaries > 0;
    const streaming = !boundary && this.host.isStreaming;
    if (this.closed) return false;
    if (!boundary) {
      if (streaming) {
        if (this.wakePaused) return false;
      } else if (!this.isIdle()) return false;
    }
    const ids = tasks.map(task => task.id);
    // Add before calling the host: a test/host double may acknowledge synchronously.
    if (streaming) for (const id of ids) this.fastQueued.add(id);
    // Pausing wakeups must not pause safe delivery: idle recovery is append-only.
    const triggerTurn = !boundary && !this.wakePaused;
    const pending = this.host.sendCustomMessage(this.message(tasks), { deliverAs: 'steer', triggerTurn });
    if (boundary) this.staged += tasks.length;
    void pending.catch(() => {
      if (streaming) for (const id of ids) this.fastQueued.delete(id);
      if (this.closed) return;
      // Failed preparation is not delivery. Suppress automatic wakeups; a safe
      // idle flush or the next legal request can retry without a restart loop.
      this.wakePaused = true;
      this.runtime.notificationFailed(ids);
    });
  }

  async atBoundary(): Promise<boolean> {
    if (this.closed) return false;
    this.wakePaused = false;
    const before = this.staged;
    this.boundaries++;
    try {
      await this.runtime.flushNotificationsAtBoundary();
      return this.staged > before;
    } finally { this.boundaries--; }
  }

  settled(aborted = false): void {
    this.returnFastPath();
    if (aborted) this.wakePaused = true;
    this.hostReady();
  }

  private returnFastPath(): void {
    // Abort alone does not clear Agent's queues. If anything remains queued,
    // leave our copies alone: a later run may still consume them. Reconcile
    // after that drain instead of manufacturing a duplicate.
    if (this.fastQueued.size === 0 || this.host.agent.hasQueuedMessages()) return;
    const ids = [...this.fastQueued];
    this.fastQueued.clear();
    this.runtime.notificationReturned(ids);
  }

  hostReady(): void {
    if (this.closed || this.ready) return;
    // Leave the host's busy/settled dispatch before flushing. send() alone
    // decides whether the host state permits steering, a wakeup or append-only.
    this.ready = setImmediate(() => {
      this.ready = undefined;
      if (!this.closed) this.runtime.flushNotifications();
    });
  }

  /** A result was observed before its queued notification was consumed. The
   * host message itself can't be unsent, but the volatile copy must not be
   * returned and re-queued as a duplicate later. */
  forget(id: string): void {
    this.fastQueued.delete(id);
  }

  close(): void {
    this.closed = true;
    this.fastQueued.clear();
    clearImmediate(this.ready); this.ready = undefined;
    this.unsubscribe();
  }
}
