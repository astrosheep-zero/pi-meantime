import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool, createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { Result } from '../src/protocol.ts';
import { FakePi, basicTool } from './host.ts';

test('foreground bash executes the saved native definition and finalizes native errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-fg-')); const pi = new FakePi();
  let nativeResult: Result | undefined; let nativeError: unknown; let executions = 0;
  const base = createBashToolDefinition(root), native = createBashTool(root);
  pi.registerTool(basicTool('bash', async (id, args, signal, update) => {
    executions++;
    const input = { command: String(args.command), ...(typeof args.timeout === 'number' ? { timeout: args.timeout } : {}) };
    try { return nativeResult = await native.execute(id, input, signal, update); }
    catch (error) { nativeError = error; throw error; }
  }, { parameters: { ...base.parameters }, outputSchema: base.outputSchema, constrainedSampling: base.constrainedSampling }));
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0 }), connect: () => pi });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const bash = pi.definitions.get('bash')!;
    assert.deepEqual(bash.constrainedSampling, base.constrainedSampling);
    assert.deepEqual((bash.outputSchema as { anyOf: unknown[] }).anyOf[0], base.outputSchema);
    for (const command of ['printf hello', 'seq 1 3000', 'printf auto']) {
      const output = await pi.call('bash', { command, ...(command === 'printf auto' ? {} : { __background__: 'no' }) });
      assert.equal(output.isError, false);
      assert.deepEqual(output.result.content, nativeResult!.content);
      assert.deepEqual(output.result.details, nativeResult!.details);
      if (command.startsWith('seq')) assert.ok((nativeResult!.details as { truncation?: unknown }).truncation);
    }
    for (const args of [{ command: 'printf failure; exit 7' }, { command: 'sleep 1', timeout: 0.01 }]) {
      const output = await pi.call('bash', { ...args, __background__: 'no' });
      if (args.timeout) assert.ok(nativeError instanceof Error);
      else {
        assert.deepEqual(output.result.content, nativeResult!.content);
        assert.deepEqual(output.result.details, nativeResult!.details);
      }
      assert.equal(output.isError, true);
      assert.equal(output.result.isError, true);
      assert.match(JSON.stringify(output.result.content), args.timeout ? /timed out/ : /failure/);
    }
    assert.equal(executions, 5);
    assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('foreground same-name tool preserves hook output and images, with authoritative isError', async () => {
  const pi = new FakePi(); let executions = 0, hooks = 0;
  const original: Result = { content: [{ type: 'text', text: 'x'.repeat(40000) }, { type: 'image', data: 'eA==', mimeType: 'image/png' }],
    details: { original: true }, structuredContent: { original: 'data' } };
  pi.registerTool(basicTool('mcp__test__large', async () => { executions++; return original; }));
  let finalError = false;
  pi.after.push((name, result) => {
    assert.equal(name, 'mcp__test__large'); hooks++;
    return { ...result, details: { hook: true }, isError: finalError };
  });
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0 }), connect: () => pi });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    for (const isError of [false, true]) {
      finalError = isError;
      original.isError = !isError;
      const output = await pi.call('mcp__test__large', { __background__: 'no' });
      assert.deepEqual(output.result.content, original.content);
      assert.deepEqual(output.result.details, { hook: true });
      assert.deepEqual(output.result.structuredContent, original.structuredContent);
      assert.equal(output.result.isError, isError);
      assert.equal(output.isError, isError);
    }
    assert.equal(executions, 2); assert.equal(hooks, 2);
    assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); }
});
