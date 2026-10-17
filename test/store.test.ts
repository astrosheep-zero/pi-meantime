import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { statSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, truncateUtf8 } from '../src/store.ts';
import { runtimeHarness, ok } from './helpers.ts';

test('store is private, atomic and rejects path traversal', async () => {
  const h = runtimeHarness();
  try {
    const id = `bg_${randomUUID()}`; const stored = h.store.saveResult(id, ok().result);
    assert.equal(statSync(h.store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(stored.path).mode & 0o777, 0o600);
    assert.throws(() => h.store.readResult('../../secret'), /Invalid/);
    assert.deepEqual(h.store.readResult(id).content, ok().result.content);
  } finally { await h.close(); }
});
test('oversized output is explicitly truncated and stored below the budget', async () => {
  const h = runtimeHarness({ maxResultBytes: 4096 });
  try {
    const result = h.store.saveResult(`bg_${randomUUID()}`, ok('字'.repeat(20_000)).result);
    assert.equal(result.truncated, true); assert.ok(result.originalBytes > 4096);
    assert.ok(statSync(result.path).size < 4096); assert.match(readFileSync(result.path, 'utf8'), /omitted/);
  } finally { await h.close(); }
});
test('UTF-8 truncation never creates a partial codepoint', () => {
  for (let n = 0; n <= 12; n++) assert.ok(!truncateUtf8('你🙂a世界', n).includes('\uFFFD'));
});
test('malformed metadata and symlink results fail safely', async () => {
  const h = runtimeHarness();
  try {
    const id = `bg_${randomUUID()}`;
    writeFileSync(join(h.store.directory, `${id}.meta.json`), '{broken');
    assert.equal(h.store.loadMetadata().length, 0);
    const external = join(h.root, 'external.json'); writeFileSync(external, JSON.stringify(ok().result));
    symlinkSync(external, join(h.store.directory, `${id}.result.json`));
    assert.throws(() => h.store.readResult(id), /Unsafe/);
    const linkedRoot = join(h.root, 'symlink-root'); symlinkSync(h.store.directory, linkedRoot);
    assert.throws(() => new TaskStore(linkedRoot, 'x', 4096), /symlink/);
  } finally { await h.close(); }
});
