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
 * success. Unconsumed fast-path messages return to the outbox at settlement.
 * Stop recovery appends without starting a run. Receipts are not disk durability
 * (idle sends emit before persistence). */
export class CompletionDelivery {
  private boundaries = 0;
  private staged = 0;
  private paused = false;
  private closed = false;
  private appendOnly = 0;
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
    const passive = boundary || this.appendOnly > 0;
    const streaming = !passive && this.host.isStreaming;
    if (this.closed || (!passive && (this.paused || (!streaming && !this.isIdle())))) return false;
    // Recovery after Stop must never start a turn or race a new explicit run.
    if (this.appendOnly > 0 && (this.host.isStreaming || !this.isIdle())) return false;
    const ids = tasks.map(task => task.id);
    // Add before calling the host: a test/host double may acknowledge synchronously.
    if (streaming) for (const id of ids) this.fastQueued.add(id);
    const pending = this.host.sendCustomMessage(this.message(tasks), { deliverAs: 'steer', triggerTurn: !passive });
    if (boundary) this.staged += tasks.length;
    void pending.catch(() => {
      if (streaming) for (const id of ids) this.fastQueued.delete(id);
      if (this.closed) return;
      // Failed preparation is not delivery. Keep the result for the next legal
      // request, without an automatic restart loop or undoing the user's Stop.
      this.paused = true;
      this.runtime.notificationFailed(ids);
    });
  }

  async atBoundary(): Promise<boolean> {
    if (this.closed) return false;
    this.paused = false;
    const before = this.staged;
    this.boundaries++;
    try {
      await this.runtime.flushNotificationsAtBoundary();
      return this.staged > before;
    } finally { this.boundaries--; }
  }

  settled(aborted = false): void {
    this.returnFastPath();
    if (!aborted) { this.hostReady(); return; }
    this.paused = true;
    clearImmediate(this.ready);
    // Agent.settled listeners run before the host becomes idle. Append after
    // that dispatch, but do not trigger a run and undo the user's Stop.
    this.ready = setImmediate(() => {
      this.ready = undefined;
      if (this.closed) return;
      // An explicit request may have rearmed delivery before this callback.
      if (!this.paused) { this.runtime.flushNotifications(); return; }
      this.appendOnly++;
      try { this.runtime.flushNotifications(); } finally { this.appendOnly--; }
    });
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
    if (this.closed || this.paused || this.ready) return;
    // Leave the host's busy/settled dispatch before starting an idle run. This
    // also retains sendCustomMessage's real rejection, not a deferred void API.
    this.ready = setImmediate(() => {
      this.ready = undefined;
      if (!this.closed && !this.paused) this.runtime.flushNotifications();
    });
  }

  close(): void {
    this.closed = true;
    this.fastQueued.clear();
    clearImmediate(this.ready); this.ready = undefined;
    this.unsubscribe();
  }
}
