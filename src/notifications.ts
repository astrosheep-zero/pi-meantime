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
  sendCustomMessage: AgentSession['sendCustomMessage'];
  subscribe(listener: (event: DeliveryEvent) => void): () => void;
}

/** One outbox bridge: stage at request boundaries, wake only when idle, and
 * acknowledge only the host's message_end consumption, never enqueue success.
 * This is not a disk-durability receipt (idle sends emit before persistence).
 * Active-run messages bypass the disposable steering queue entirely. */
export class CompletionDelivery {
  private boundaries = 0;
  private staged = 0;
  private paused = false;
  private closed = false;
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
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) runtime.notificationConsumed(ids);
    });
  }

  send(tasks: Snapshot[]): void | false {
    const boundary = this.boundaries > 0;
    if (this.closed || (!boundary && (this.paused || this.host.isStreaming || !this.isIdle()))) return false;
    const pending = this.host.sendCustomMessage(this.message(tasks), { deliverAs: 'steer', triggerTurn: !boundary });
    if (boundary) this.staged += tasks.length;
    void pending.catch(() => {
      if (this.closed) return;
      // Failed preparation is not delivery. Keep the result for the next legal
      // request, without an automatic restart loop or undoing the user's Stop.
      this.paused = true;
      this.runtime.notificationFailed(tasks.map(task => task.id));
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
    if (aborted) {
      this.paused = true;
      clearImmediate(this.ready); this.ready = undefined;
    } else this.hostReady();
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
    clearImmediate(this.ready); this.ready = undefined;
    this.unsubscribe();
  }
}
