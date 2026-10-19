import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';
import type { BashTool, Result, ToolContext } from '../src/protocol.ts';
import { FakePi, basicTool } from './host.ts';

test('foreground bash returns the actual native object, including truncation and errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-fg-')); const pi = new FakePi();
  let nativeResult: Result | undefined; let nativeError: unknown;
  const base = createBashToolDefinition(root);
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0 }), baseBash: base,
    makeBash: cwd => {
      const native: BashTool = createBashToolDefinition(cwd);
      return { ...native, async execute(...args) {
        try { return nativeResult = await native.execute(...args); }
        catch (error) { nativeError = error; throw error; }
      } };
    },
  });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const bash = pi.definitions.get('bash')!;
    assert.deepEqual(bash.constrainedSampling, base.constrainedSampling);
    assert.deepEqual((bash.outputSchema as { anyOf: unknown[] }).anyOf[0], base.outputSchema);
    for (const command of ['printf hello', 'printf failure; exit 7', 'seq 1 3000']) {
      const output = await pi.call('bash', { command, __background__: 'no' });
      assert.strictEqual(output.result, nativeResult);
    }
    assert.ok((nativeResult!.details as { truncation?: unknown }).truncation);
    // auto that finishes before any detach is just as transparent.
    assert.strictEqual((await pi.call('bash', { command: 'printf auto' })).result, nativeResult);
    const ctx: ToolContext = { ...pi.ctx, tools: [], executeTool: async () => { throw new Error('unexpected'); } };
    await assert.rejects(bash.execute('timeout', { command: 'sleep 1', timeout: 0.01, __background__: 'no' }, undefined, undefined, ctx),
      error => error === nativeError && /timed out/.test(String(error)));
    assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('foreground proxy preserves hook output and images unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-proxy-fg-')); const pi = new FakePi();
  const original: Result = { content: [{ type: 'text', text: 'x'.repeat(40000) }, { type: 'image', data: 'eA==', mimeType: 'image/png' }],
    details: { original: true }, structuredContent: { original: 'data' } };
  pi.registerTool(basicTool('mcp__test__large', async () => original));
  pi.after.push((name, result) => name === 'mcp__test__large' ? { ...result, details: { hook: true }, isError: true } : result);
  const instance = install(pi, { config: validateConfig({ autoDetachMs: 0 }), makeBash: createBashToolDefinition });
  try {
    await pi.emit('session_start', { type: 'session_start' });
    const output = await pi.call('mcp__test__large_mt', { __background__: 'no' });
    assert.deepEqual(output.result, { ...original, details: { hook: true }, isError: true });
    assert.equal(pi.notifications.length, 0);
  } finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
});
