import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { BeforeAgentStartEvent, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Snapshot } from '../src/runtime.ts';
import { deferred, until } from './helpers.ts';

interface Hooks {
  request?(number: number, signal?: AbortSignal): Promise<void>;
  work?(number: number): Promise<void>;
  beforeCompact?(event: SessionBeforeCompactEvent): SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>;
  front?(ctx: ExtensionContext): Promise<void>;
  beforeStart?(event: BeforeAgentStartEvent): void | Promise<void>;
  beforeBind?(session: Awaited<ReturnType<typeof createAgentSession>>['session']): void;
  calls?(number: number): ToolCall[] | undefined;
  toolCall?(event: ToolCallEvent): void;
}

// Stock SDK and scripted provider; no queue methods, external models or user resources.
async function fixture(workCount = 1, hooks: Hooks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meantime-notifications-sdk-'));
  const release = deferred<void>(), completed = deferred<void>();
  const expected = new Set<string>(), indexed = new Set<string>();
  const requests: string[][] = [], errors: unknown[] = [], sends: { ids: string[]; trigger: boolean }[] = [];
  let plugin: ReturnType<typeof install> | undefined;
  let workCalls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let unsubscribe: (() => void) | undefined;
  const settings = SettingsManager.inMemory({ defaultTools: ['notification_work', 'notification_front'],
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 }, retry: { enabled: false } });
  const makeLoader = () => new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      pi.registerProvider('notification-fixture', {
        api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'offline',
        models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
        streamSimple(model, context, options) {
          requests.push(context.messages.filter(message => message.role === 'user')
            .flatMap(message => [...JSON.stringify(message.content).matchAll(/(mt_[a-f0-9]{8}) · completed/g)].map(match => match[1]!)));
          const number = requests.length;
          const stream = createAssistantMessageEventStream();
          void (async () => {
            await hooks.request?.(number, options?.signal);
            const calls: ToolCall[] = hooks.calls?.(number) ?? (number === 1
              ? Array.from({ length: workCount }, (_, i) => ({ type: 'toolCall', id: `work-${i}`, name: 'notification_work', arguments: { __background__: 'yes' } }))
              : number === 2 && hooks.front
                ? [{ type: 'toolCall', id: 'front', name: 'notification_front', arguments: { __background__: 'no' } }]
                : []);
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
        async execute() {
          await (hooks.work ? hooks.work(++workCalls) : release.promise);
          return { content: [{ type: 'text', text: 'background done' }], details: undefined };
        },
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
        hooks.toolCall?.(event);
        if (event.toolName === 'notification_front') await hooks.front?.(ctx);
      });
      plugin = install(pi, { config: validateConfig({ autoDetachMs: 0, explicitDetachMs: 0, maxRunning: 32, maxRetained: 1, notifyDebounceMs: 5000 }) });
      pi.on('session_before_compact', event => hooks.beforeCompact?.(event));
      pi.on('before_agent_start', event => hooks.beforeStart?.(event));
    }],
  });
  let modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  async function open(sessionManager: SessionManager) {
    const loader = makeLoader();
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
      sessionManager, modelRuntime }));
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (message, options) => {
      if (message.customType === 'meantime-completion') sends.push({ ids: (message.details as { taskIds: string[] }).taskIds, trigger: options?.triggerTurn === true });
      return send(message, options);
    };
    hooks.beforeBind?.(session);
    await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error); } });
    await session.setModel(modelRuntime.getModel('notification-fixture', 'fixture')!);
    unsubscribe = session.subscribe(event => {
      if (event.type !== 'entry_appended' || event.entry.type !== 'custom' || event.entry.customType !== 'meantime-index') return;
      const data = event.entry.data as { change?: { completion?: { id: string } } };
      const id = data.change?.completion?.id;
      if (id && expected.has(id)) indexed.add(id);
      if (indexed.size === workCount) completed.resolve();
    });
  }
  async function restart() {
    const file = session?.sessionManager.getSessionFile();
    assert.ok(file);
    unsubscribe?.(); await session?.abort(); await plugin?.dispose(); session?.dispose();
    await open(SessionManager.open(file));
  }
  async function close() {
    release.resolve(); completed.resolve(); unsubscribe?.();
    try { await session?.abort(); await plugin?.dispose(); }
    finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
  }
  async function control(args: ToolCall['arguments'], signal?: AbortSignal) {
    const toolCall = { type: 'toolCall' as const, id: 'control-' + Math.random(), name: 'meantime', arguments: args };
    return runToolCall(toolCall, { tools: session!.agent.state.tools, assistantMessage: [...session!.messages].reverse().find(m => m.role === 'assistant') as AssistantMessage,
      context: { messages: session!.messages, tools: session!.agent.state.tools }, signal,
      beforeToolCall: session!.agent.beforeToolCall, afterToolCall: session!.agent.afterToolCall });
  }
  try {
    modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    await open(SessionManager.create(root, join(root, 'sessions')));
    const tasks = () => (plugin!.inspect() as { tasks: Snapshot[] }).tasks;
    const batches = () => session!.messages.flatMap(message => message.role === 'custom' && message.customType === 'meantime-completion'
      ? [(message.details as { taskIds: string[] }).taskIds] : []);
    const assertConsumedOnce = (ids = [...expected]) => {
      assert.deepEqual(errors, []);
      assert.deepEqual(batches().flat().sort(), ids.sort());
      assert.ok(batches().every(ids => ids.length > 0 && ids.length <= 16));
      const entries = session!.sessionManager.getEntries();
      for (const id of ids) {
        const message = entries.findIndex(entry => entry.type === 'custom_message' && entry.customType === 'meantime-completion'
          && (entry.details as { taskIds: string[] }).taskIds.includes(id));
        const receipt = entries.findIndex(entry => entry.type === 'custom' && entry.customType === 'meantime-index'
          && (entry.data as { change: { delivered?: string[] } }).change.delivered?.includes(id));
        assert.ok(message >= 0 && receipt > message, 'real consumed message precedes durable delivered receipt');
      }
    };
    return { get session() { return session!; }, release, completed, expected, indexed, requests, errors, sends, tasks, batches,
      assertConsumedOnce, restart, close, control, dispose: () => plugin!.dispose() };
  } catch (error) { await close(); throw error; }
}

for (const approval of [true, false]) test(approval ? 'SDK: approval ending resumes the outbox at a public boundary'
  : 'SDK: busy completion stays pending, then public boundary hands off all 17 tasks', { timeout: 15_000 }, async t => {
  const h = await fixture(approval ? 1 : 17, { async front(ctx) {
    if (approval) assert.equal(await ctx.ui.confirm('Permission', 'Allow foreground tool?'), true);
    else { h.release.resolve(); await h.completed.promise; }
    t.mock.timers.tick(5000); await nextTurn();
    assert.ok(h.tasks().every(task => task.notification === 'pending'));
    assert.equal(h.sends.length, 0, 'busy flush leaves ownership in meantime');
  } });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    h.session.extensionRunner!.setUIContext({ ...h.session.extensionRunner!.getUIContext(), async confirm() {
      h.release.resolve(); await h.completed.promise; return true;
    } }, 'rpc');
    await h.session.prompt('exercise notification boundaries'); await nextTurn();
    assert.equal(h.requests.length, 3);
    h.assertConsumedOnce();
    assert.ok(h.sends.every(send => !send.trigger));
  } finally { await h.close(); }
});

test('SDK: already-idle completion proactively wakes without another human event', { timeout: 15_000 }, async t => {
  const h = await fixture();
  try {
    await h.session.prompt('start background work');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    h.release.resolve(); await h.completed.promise;
    t.mock.timers.tick(5000); await nextTurn(); await h.session.waitForIdle(); await nextTurn();
    assert.equal(h.requests.length, 3); assert.equal(h.sends[0]!.trigger, true);
    h.assertConsumedOnce();
    await h.restart(); await h.session.prompt('reopen'); await nextTurn();
    h.assertConsumedOnce();
  } finally { await h.close(); }
});

for (const all of [false, true]) test(`SDK: successful wait before handoff suppresses ${all ? 'all' : 'one'} result(s)`, { timeout: 15_000 }, async t => {
  const h = await fixture(2, {
    async request(number) {
      if (number !== 2) return;
      h.release.resolve(); await h.completed.promise;
      t.mock.timers.tick(5000); await nextTurn();
      assert.equal(h.sends.length, 0);
    },
    calls(number) {
      if (number !== 2) return;
      return [{ type: 'toolCall', id: 'observe', name: 'meantime', arguments: { action: 'wait', ids: [...h.expected].slice(0, all ? 2 : 1), timeout: 0 } }];
    },
  });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await h.session.prompt('read before handoff'); await nextTurn();
    const unread = all ? [] : [...h.expected].slice(1);
    h.assertConsumedOnce(unread);
    const result = h.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'observe');
    assert.match(JSON.stringify(result), /background done/);
    assert.equal(h.requests.length, 3, 'only the natural post-tool continuation');
  } finally { await h.close(); }
});

for (const abort of [false, true]) test(`SDK: ${abort ? 'aborted' : 'timed-out'} batch wait releases pending notifications without cancelling producers`, { timeout: 15_000 }, async t => {
  const first = deferred<void>(), second = deferred<void>();
  const h = await fixture(2, { work(number) { return number === 1 ? first.promise : second.promise; } });
  try {
    await h.session.prompt('start both tasks');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const wait = h.control({ action: 'wait', ids: [...h.expected], timeout: 90 }, controller.signal);
    await nextTurn(); first.resolve(); await until(() => h.indexed.size === 1);
    t.mock.timers.tick(5000); await nextTurn(); assert.equal(h.sends.length, 0, 'active waiter pauses handoff');
    if (abort) controller.abort(new Error('stop waiting')); else t.mock.timers.tick(90_000);
    await wait; await nextTurn();
    t.mock.timers.tick(5000); await nextTurn(); await h.session.waitForIdle(); await nextTurn();
    assert.equal(h.tasks().filter(task => task.localRunning).length, 1);
    if (abort) h.assertConsumedOnce([...h.expected].slice(0, 1));
    else assert.equal(h.sends.length, 0, 'timeout returned and observed the available result');
    second.resolve(); await h.completed.promise;
    t.mock.timers.tick(5000); await nextTurn(); await h.session.waitForIdle(); await nextTurn();
    assert.deepEqual(h.batches().flat().sort(), [...h.expected].slice(abort ? 0 : 1).sort());
  } finally { first.resolve(); second.resolve(); await h.close(); }
});

test('SDK: Stop keeps pending and later idle completions append-only', { timeout: 15_000 }, async t => {
  const first = deferred<void>(), second = deferred<void>(), streaming = deferred<void>(), interrupted = deferred<void>();
  const h = await fixture(2, { work(number) { return number === 1 ? first.promise : second.promise; },
    async request(number, signal) {
      if (number !== 2) return;
      signal!.addEventListener('abort', () => interrupted.resolve(), { once: true });
      streaming.resolve(); await interrupted.promise;
    } });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = h.session.prompt('stop while busy'); await streaming.promise;
    first.resolve(); await until(() => h.indexed.size === 1);
    t.mock.timers.tick(5000); await nextTurn(); assert.equal(h.sends.length, 0);
    h.session.clearQueue(); const stopping = h.session.abort(); await run; await stopping; await nextTurn();
    second.resolve(); await h.completed.promise;
    t.mock.timers.tick(5000); await nextTurn();
    assert.equal(h.requests.length, 2); assert.ok(h.sends.every(send => !send.trigger));
    h.assertConsumedOnce();
    t.mock.timers.tick(100_000); await nextTurn(); assert.equal(h.requests.length, 2);
  } finally { first.resolve(); second.resolve(); interrupted.resolve(); await h.close(); }
});

test('SDK: compaction ending resumes an ordinary idle pending completion', { timeout: 15_000 }, async t => {
  const h = await fixture(1, { async beforeCompact(event) {
    h.release.resolve(); await h.completed.promise;
    t.mock.timers.tick(5000); await nextTurn(); assert.equal(h.sends.length, 0);
    return { compaction: { summary: 'offline compact', firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore } };
  } });
  try {
    await h.session.prompt('start');
    h.session.sessionManager.appendMessage({ role: 'user', content: 'older turn '.repeat(100), timestamp: Date.now() });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await h.session.compact(); await nextTurn(); await h.session.waitForIdle(); await nextTurn();
    assert.equal(h.sends[0]!.trigger, true); h.assertConsumedOnce();
  } finally { await h.close(); }
});

for (const stop of [false, true]) test(`SDK: real idle preparation rejection ${stop ? 'after Stop' : 'without Stop'} retries append-only`, { timeout: 15_000 }, async t => {
  const entered = deferred<void>(), leave = deferred<void>(); let preparations = 0;
  const h = await fixture(1, { async beforeStart(event) {
    if (event.messageType !== 'custom') return;
    preparations++; entered.resolve(); await leave.promise;
    event.systemPromptOptions.sections['invalid section name'] = 'real SDK preparation rejection';
  } });
  try {
    await h.session.prompt('start'); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.release.resolve(); await h.completed.promise; t.mock.timers.tick(5000); await entered.promise;
    const stopping = stop ? h.session.abort() : undefined;
    leave.resolve(); await stopping; await nextTurn();
    assert.equal(h.tasks()[0]!.notification, 'pending'); assert.equal(h.batches().length, 0);
    // External boundary/ready callbacks cannot bypass the retry delay.
    t.mock.timers.tick(249); await nextTurn(); assert.equal(h.sends.length, 1);
    t.mock.timers.tick(1); await nextTurn();
    assert.equal(preparations, 1, 'a rejected preparation never automatically wakes again');
    assert.deepEqual(h.sends.map(send => send.trigger), [true, false]);
    assert.equal(h.requests.length, 2); h.assertConsumedOnce();
    t.mock.timers.tick(100_000); await nextTurn(); assert.equal(preparations, 1);
  } finally { leave.resolve(); await h.close(); }
});

test('SDK: retry exhaustion retains failed batches, exposes errors and advances later pending tasks', { timeout: 15_000 }, async t => {
  const attempts: { ids: string[]; trigger: boolean }[] = [];
  let blocked: string[] | undefined;
  const h = await fixture(17, { beforeBind(session) {
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (message, options) => {
      if (message.customType === 'meantime-completion') {
        const ids = (message.details as { taskIds: string[] }).taskIds;
        attempts.push({ ids, trigger: options?.triggerTurn === true });
        blocked ??= ids;
        if (ids.some(id => blocked!.includes(id))) return Promise.reject(new Error('public send unavailable'));
      }
      return send(message, options);
    };
  } });
  try {
    await h.session.prompt('start'); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.release.resolve(); await h.completed.promise; t.mock.timers.tick(5000); await nextTurn();
    t.mock.timers.tick(250); await nextTurn();
    t.mock.timers.tick(1000); await nextTurn(); await nextTurn();
    const blockedAttempts = attempts.filter(send => send.ids.some(id => blocked!.includes(id)));
    assert.deepEqual(blockedAttempts.map(send => [send.ids.length, send.trigger]), [[16, true], [16, false], [16, false]]);
    const otherAttempts = attempts.filter(send => !send.ids.some(id => blocked!.includes(id)));
    assert.deepEqual(otherAttempts.map(send => [send.ids.length, send.trigger]), [[1, false]], 'other eligible tasks progress without waking');
    const failed = h.tasks().filter(task => task.notificationError);
    assert.equal(failed.length, 16, 'pending exhausted results survive maxRetained=1');
    assert.ok(failed.every(task => task.notification === 'failed' && /retry exhausted/.test(task.notificationError!)));
    const listed = await h.control({ action: 'list', limit: 32 });
    assert.match(JSON.stringify(listed.result.content), /Notification retry exhausted/);
    t.mock.timers.tick(100_000); await nextTurn(); assert.equal(attempts.length, 4, 'finite budget, no busy-loop');
    const result = await h.control({ action: 'wait', ids: [blocked![0]!], timeout: 0 });
    assert.match(JSON.stringify(result.result), /background done/, 'exhaustion keeps the full producer result');
    h.assertConsumedOnce([...h.expected].filter(id => !blocked!.includes(id)));
  } finally { await h.close(); }
});

for (const stop of [false, true]) test(`SDK: ${stop ? 'Stop' : 'cleanup'} cancels a pending retry timer`, { timeout: 15_000 }, async t => {
  const entered = deferred<void>(), interrupted = deferred<void>();
  let attempts = 0;
  const h = await fixture(1, { beforeBind(session) {
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (message, options) => {
      if (message.customType === 'meantime-completion') {
        attempts++;
        if (!options?.triggerTurn) return Promise.reject(new Error('append failed'));
      }
      return send(message, options);
    };
  }, beforeStart(event) {
    if (event.messageType === 'custom') event.systemPromptOptions.sections['invalid section name'] = 'real preparation failure';
  }, async request(number, signal) {
    if (number !== 3) return;
    signal!.addEventListener('abort', () => interrupted.resolve(), { once: true });
    entered.resolve(); await interrupted.promise;
  } });
  try {
    await h.session.prompt('start'); t.mock.timers.enable({ apis: ['setTimeout'] });
    h.release.resolve(); await h.completed.promise; t.mock.timers.tick(5000); await nextTurn();
    assert.equal(attempts, 1);
    if (stop) {
      const run = h.session.prompt('explicit user run'); await entered.promise;
      const stopping = h.session.abort(); await run; await stopping; await nextTurn();
    } else await h.dispose();
    const before = attempts;
    t.mock.timers.tick(100_000); await nextTurn();
    assert.equal(attempts, before, 'retired or stopped retry cannot fire');
    assert.equal(h.requests.length, stop ? 3 : 2);
  } finally { interrupted.resolve(); await h.close(); }
});

test('SDK: consumed notification stays delivered after a late Promise rejection; later idle work still wakes', { timeout: 15_000 }, async t => {
  const first = deferred<void>(), second = deferred<void>(), rejection = deferred<unknown>(); let consumed = false, threw = false;
  const h = await fixture(2, { work(number) { return number === 1 ? first.promise : second.promise; }, beforeBind(session) {
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (message, options) => {
      const pending = send(message, options);
      if (message.customType === 'meantime-completion') void pending.catch(error => rejection.resolve(error));
      return pending;
    };
  } });
  const failure = new Error('public settled observer failed after consumption');
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'meantime-completion') consumed = true;
    if (event.type === 'agent_settled' && consumed && !threw) { threw = true; throw failure; }
  });
  try {
    await h.session.prompt('start'); t.mock.timers.enable({ apis: ['setTimeout'] });
    first.resolve(); await until(() => h.indexed.size === 1); t.mock.timers.tick(5000);
    assert.equal(await rejection.promise, failure); await nextTurn();
    second.resolve(); await h.completed.promise;
    t.mock.timers.tick(5000); await nextTurn(); await h.session.waitForIdle(); await nextTurn();
    assert.deepEqual(h.sends.map(send => send.trigger), [true, true]); h.assertConsumedOnce();
  } finally { unsubscribe(); first.resolve(); second.resolve(); await h.close(); }
});
