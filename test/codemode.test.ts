import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Separate process: native admission is process-global, and this checks actual
// public factory replacement rather than importing a private executor or using
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
