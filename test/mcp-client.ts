/** Wire fixture client, deliberately not advertised as the official Pi MCP client. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Result, Schema } from '../src/protocol.ts';
import { isRecord } from '../src/schema.ts';

export class FixtureMcpClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly sent: Record<string, unknown>[] = [];
  private next = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; cleanup(): void }>();
  constructor() {
    this.process = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdin.on('error', () => {});
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', () => this.fail(new Error('MCP transport closed; remote state is unknown')));
    createInterface({ input: this.process.stdout }).on('line', line => {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message) || typeof message.id !== 'number') return;
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); request.cleanup();
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
  }
  private write(method: string, params: unknown, id?: number): void {
    const message = { jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) };
    this.sent.push(message); this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('MCP request cancelled before send'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const onAbort = () => {
        this.write('notifications/cancelled', { requestId: id, reason: 'local cancellation' });
        this.pending.delete(id); cleanup(); reject(new Error('MCP request cancelled locally; remote side effect may still execute'));
      };
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error('Fixture MCP timeout')); }, 7000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write(method, params, id);
    });
  }
  async connect(): Promise<{ name: string; inputSchema: Schema }[]> {
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '0.1.0' } });
    this.write('notifications/initialized', {});
    const response = await this.request('tools/list', {}) as { tools: { name: string; inputSchema: Schema }[] };
    return response.tools;
  }
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<Result> {
    const response = await this.request('tools/call', { name, arguments: args }, signal) as Result;
    return { ...response, details: { fixture: true } };
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.fail(new Error('Fixture client stopped'));
    if (this.process.exitCode === null) {
      const ended = new Promise<void>(resolve => this.process.once('exit', () => resolve()));
      this.process.kill('SIGKILL'); await ended;
    }
  }
}
