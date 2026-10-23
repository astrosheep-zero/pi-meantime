import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { captureCodemodeExecute } from '../src/codemode.ts';
import { install } from '../src/extension.ts';
import { validateConfig } from '../src/config.ts';

// Separate process: native admission is process-global, and this checks actual
// builtin decoration with a public factory rather than a private executor or using
// a sandbox double. The script's installed-host variant additionally checks
// index.mjs/Jiti's module identity.
test('native CodeMode: continuation, descendants, accounting, capacity and lifecycle through real SDK', { timeout: 45_000 }, async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../scripts/sdk-codemode.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /NATIVE_CODEMODE_PASS/);
  } finally { clearTimeout(timer); child.kill(); }
});

test('CodeMode adoption respects disabled, excluded and externally replaced tools', async t => {
  for (const mode of ['disabled', 'excluded', 'external']) await t.test(mode, async () => {
    const root = mkdtempSync(join(tmpdir(), 'meantime-codemode-registration-'));
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['codemode', 'meantime'],
      extensions: mode === 'disabled' ? ['-builtin:codemode'] : [], cacheWarming: 'off' });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        { name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension() },
        pi => { install(pi, { config: validateConfig({ exclude: mode === 'excluded' ? ['codemode'] : [] }),
          codemodeExecute: captureCodemodeExecute(pi, sdk.createCodemodeExtension) }); },
        ...(mode === 'external' ? [sdk.createCodemodeExtension()] : []),
      ] });
    let session: sdk.AgentSession | undefined;
    try {
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const warnings = structuredClone(loader.getExtensions().warnings ?? []);
      assert.equal(warnings.length, mode === 'external' ? 1 : 0, 'genuine external replacement still warns');
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
      ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
        settingsManager: settings, modelRuntime, sessionManager: sdk.SessionManager.inMemory(root) }));
      const original = session.getToolDefinition('codemode');
      const descriptors = original && Object.getOwnPropertyDescriptors(original);
      const errors: unknown[] = [];
      await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
      assert.deepEqual(errors, []);
      assert.equal(session.getToolDefinition('codemode'), original);
      assert.deepEqual(original && Object.getOwnPropertyDescriptors(original), descriptors, 'unmanaged definition remains untouched');
      assert.deepEqual(loader.getExtensions().warnings ?? [], warnings, 'no warning suppression or new replacement');
      assert.equal(loader.getExtensions().extensions.filter(e => e.tools.has('codemode')).length, mode === 'disabled' ? 0 : 1);
      assert.equal(session.getToolDefinition('meantime')?.exposure, 'model-only');
    } finally {
      if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session?.dispose(); rmSync(root, { recursive: true, force: true });
    }
  });
});
