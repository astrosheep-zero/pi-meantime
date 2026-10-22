import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { BeforeAgentStartEvent, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Snapshot } from '../src/runtime.ts';
import { deferred } from './helpers.ts';

interface Hooks {
  request?(number: number, signal?: AbortSignal): Promise<void>;
  front?(ctx: ExtensionContext): Promise<void>;
  beforeStart?(event: BeforeAgentStartEvent): void;
  turnEnd?(): void;
}

// Real SDK and scripted provider, isolated from user resources and external models.
async function fixture(workCount = 1, hooks: Hooks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meantime-notifications-sdk-'));
  const release = deferred<void>(), completed = deferred<void>();
  const expected = new Set<string>(), indexed = new Set<string>();
  const requests: string[][] = [], errors: unknown[] = [];
  let plugin: ReturnType<typeof install> | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let unsubscribe: (() => void) | undefined;
  const settings = SettingsManager.inMemory({ defaultTools: ['notification_work', 'notification_front'], compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      pi.registerProvider('notification-fixture', {
        api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'offline',
        models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model, context, options) {
          requests.push(context.messages.filter(message => message.role === 'user')
            .flatMap(message => [...JSON.stringify(message.content).matchAll(/Meantime (mt_[a-f0-9]{8}) completed/g)].map(match => match[1]!)));
          const number = requests.length;
          const stream = createAssistantMessageEventStream();
          void (async () => {
            await hooks.request?.(number, options?.signal);
            const calls: ToolCall[] = number === 1
              ? Array.from({ length: workCount }, (_, i) => ({ type: 'toolCall', id: `work-${i}`, name: 'notification_work', arguments: { __background__: 'yes' } }))
              : number === 2 && hooks.front
                ? [{ type: 'toolCall', id: 'front', name: 'notification_front', arguments: { __background__: 'no' } }]
                : [];
            const message: AssistantMessage = {
              role: 'assistant', api: model.api, provider: model.provider, model: model.id,
              content: calls.length ? calls : [{ type: 'text', text: 'done' }],
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: options?.signal?.aborted ? 'aborted' : calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
            };
            stream.push({ type: 'start', partial: message });
            for (const [contentIndex, toolCall] of calls.entries()) {
              stream.push({ type: 'toolcall_start', contentIndex, partial: message });
              stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
            }
            if (message.stopReason === 'aborted') stream.push({ type: 'error', reason: 'aborted', error: message });
            else stream.push({ type: 'done', reason: calls.length ? 'toolUse' : 'stop', message });
            stream.end();
          })().catch(error => { errors.push(error); stream.end(); });
          return stream;
        },
      });
      pi.registerTool({ name: 'notification_work', label: 'Work', description: 'Deferred offline producer',
        parameters: { type: 'object', properties: {} },
        async execute() { await release.promise; return { content: [{ type: 'text', text: 'background done' }], details: undefined }; },
      });
      pi.registerTool({ name: 'notification_front', label: 'Front', description: 'Immediate foreground result',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'foreground done' }], details: undefined }; },
      });
      pi.on('tool_execution_end', event => {
        if (event.toolName !== 'notification_work') return;
        const handle = event.result.structuredContent as { task: { id: string }; result_available: boolean };
        assert.equal(handle.result_available, false);
        expected.add(handle.task.id);
      });
      pi.on('tool_call', async (event, ctx) => {
        if (event.toolName === 'notification_front') {
          assert.equal(expected.size, workCount, 'all handles precede producer release');
          await hooks.front?.(ctx);
        }
      });
      plugin = install(pi, { config: validateConfig({ autoDetachMs: 0, maxRunning: 32, notifyDebounceMs: 5000 }) });
      pi.on('before_agent_start', event => hooks.beforeStart?.(event));
      pi.on('turn_end', () => hooks.turnEnd?.());
    }],
  });
  async function close() {
    release.resolve(); completed.resolve(); unsubscribe?.();
    try { await session?.abort(); await plugin?.dispose(); }
    finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
  }
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.inMemory(root), modelRuntime }));
    await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error); } });
    await session.setModel(modelRuntime.getModel('notification-fixture', 'fixture')!);
    unsubscribe = session.subscribe(event => {
      if (event.type !== 'entry_appended' || event.entry.type !== 'custom' || event.entry.customType !== 'meantime-index') return;
      const data = event.entry.data as { change?: { completion?: { id: string } } };
      const id = data.change?.completion?.id;
      if (id && expected.has(id)) indexed.add(id);
      if (indexed.size === workCount) completed.resolve();
    });
    const tasks = () => (plugin!.inspect() as { tasks: Snapshot[] }).tasks;
    const batches = () => session!.messages.flatMap(message => message.role === 'custom' && message.customType === 'meantime-completion'
      ? [(message.details as { taskIds: string[] }).taskIds] : []);
    const assertConsumedOnce = () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(batches().flat().sort(), [...expected].sort(), 'each task has exactly one host-consumed message');
      assert.ok(batches().every(ids => ids.length > 0 && ids.length <= 16));
      assert.ok(tasks().every(task => task.notification === 'delivered'));
    };
    return { session, release, completed, expected, requests, tasks, batches, assertConsumedOnce, close };
  } catch (error) { await close(); throw error; }
}

for (const approval of [true, false]) test(approval
  ? 'SDK: approval continuation cannot defer completion past the next request'
  : 'SDK: a batch boundary flushes all 17 eligible completions before the next request', { timeout: 15_000 }, async () => {
  const h = await fixture(approval ? 1 : 17, { async front(ctx) {
    if (approval) assert.equal(await ctx.ui.confirm('Permission', 'Allow foreground tool?'), true);
    else { h.release.resolve(); await h.completed.promise; }
  } });
  try {
    h.session.extensionRunner!.setUIContext({ ...h.session.extensionRunner!.getUIContext(), async confirm() {
      h.release.resolve(); await h.completed.promise; return true;
    } }, 'rpc');
    await h.session.prompt('exercise notification boundaries');
    await h.session.waitForIdle();
    assert.equal(h.session.steeringMode, 'one-at-a-time');
    assert.equal(h.requests.length, 3, 'no extra notification answer');
    assert.deepEqual([...h.requests[2]!].sort(), [...h.expected].sort(), 'all completions are in the next request, without duplicates');
    h.assertConsumedOnce();
  } finally { await h.close(); }
});

for (const staged of [false, true]) test(staged
  ? 'SDK: Stop after staging and clearQueue does not lose a completion or restart'
  : 'SDK: Stop with a pending completion does not lose it or restart', { timeout: 15_000 }, async t => {
  const streaming = deferred<void>(), interrupted = deferred<void>();
  let stopping: Promise<void> | undefined;
  const h = await fixture(1, staged ? {
    async front() { h.release.resolve(); await h.completed.promise; },
    turnEnd() {
      if (stopping || !h.tasks().some(task => task.notification === 'queued')) return;
      assert.deepEqual(h.session.clearQueue(), { steering: [], followUp: [] }, 'staged notification bypasses disposable queues');
      stopping = h.session.abort(); // Do not await idle inside its own boundary.
    },
  } : {
    async request(number, signal) {
      if (number !== 2) return;
      signal!.addEventListener('abort', () => interrupted.resolve(), { once: true });
      streaming.resolve(); await interrupted.promise;
    },
  });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = h.session.prompt('start work, then Stop');
    if (!staged) {
      await streaming.promise;
      h.release.resolve(); await h.completed.promise;
      t.mock.timers.tick(5000); await nextTurn();
      assert.equal(h.tasks()[0]!.notification, 'pending');
      stopping = h.session.abort();
    }
    await run; await stopping;
    assert.ok(stopping, 'Stop was exercised');
    assert.equal(h.requests.length, 2, 'Stop prevents a notification answer');
    t.mock.timers.tick(10_000); await nextTurn();
    assert.equal(h.requests.length, 2, 'pending timers cannot automatically resurrect the run');
    await h.session.prompt('resume explicitly');
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.requests[2], [...h.expected]);
    h.assertConsumedOnce();
  } finally { interrupted.resolve(); await h.close(); }
});

// Observe the real public Promise without replacing delivery or the SDK runner.
function rejectedSend(session: Awaited<ReturnType<typeof fixture>>['session']) {
  const rejected = deferred<unknown>();
  const send = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (...args) => {
    const promise = send(...args);
    void promise.catch(error => rejected.resolve(error));
    return promise;
  };
  return rejected.promise;
}

test('SDK: idle preparation failure waits for a legal prompt and recovers exactly once', { timeout: 15_000 }, async t => {
  let preparations = 0, fail = true;
  const h = await fixture(1, { beforeStart(event) {
    if (event.messageType !== 'custom' || event.message.customType !== 'meantime-completion') return;
    preparations++;
    if (fail) event.systemPromptOptions.sections['invalid section name'] = 'force real SDK preparation rejection';
  } });
  try {
    await h.session.prompt('start background work');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejection = rejectedSend(h.session);
    h.release.resolve(); await h.completed.promise;
    assert.match(String(await rejection), /Invalid system prompt section name/);
    await nextTurn();
    assert.equal(h.tasks()[0]!.notification, 'pending');
    assert.deepEqual(h.batches(), []);
    t.mock.timers.tick(10_000); await nextTurn();
    assert.equal(preparations, 1, 'no automatic preparation retry');
    assert.equal(h.requests.length, 2, 'failed preparation never called the provider');
    fail = false;
    await h.session.prompt('recover explicitly');
    assert.equal(h.requests.length, 3, 'recovery needs only the user-requested answer');
    assert.deepEqual(h.requests[2], [...h.expected]);
    h.assertConsumedOnce();
  } finally { await h.close(); }
});

test('SDK: a rejected idle send cannot roll back an already consumed notification', { timeout: 15_000 }, async t => {
  const h = await fixture();
  const failure = new Error('public settled observer failed after consumption');
  let consumed = false, threw = false;
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'meantime-completion') {
      consumed = true;
      assert.equal(h.tasks()[0]!.notification, 'delivered');
      // Idle message_end precedes session persistence. This receipt promises
      // host consumption only, not even an appended entry, let alone fs durability.
      assert.equal(h.session.sessionManager.getEntries().some(entry => entry.type === 'custom_message' && entry.customType === 'meantime-completion'), false);
    }
    if (event.type === 'agent_settled' && consumed && !threw) { threw = true; throw failure; }
  });
  try {
    await h.session.prompt('start background work');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejection = rejectedSend(h.session);
    h.release.resolve(); await h.completed.promise;
    assert.equal(await rejection, failure);
    await nextTurn();
    assert.equal(consumed, true);
    assert.equal(h.tasks()[0]!.notification, 'delivered');
    t.mock.timers.tick(10_000); await nextTurn();
    assert.equal(h.requests.length, 3, 'post-consumption rejection cannot retry automatically');
    await h.session.prompt('continue explicitly');
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.requests[3], [...h.expected]);
    h.assertConsumedOnce();
  } finally { unsubscribe(); await h.close(); }
});
