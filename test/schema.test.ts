import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL, decorateSchema, splitControl, matches } from '../src/schema.ts';
import { validateConfig } from '../src/config.ts';

test('closed object schema remains closed and business properties are unchanged', () => {
  const original = { type: 'object', properties: { query: { type: 'string' }, nested: { type: 'object', additionalProperties: false } }, required: ['query'], additionalProperties: false };
  const copy = structuredClone(original); const decorated = decorateSchema(original);
  assert.equal(decorated.additionalProperties, false);
  assert.deepEqual(decorated.required, ['query']); assert.deepEqual(original, copy);
  assert.deepEqual((decorated.properties as Record<string, unknown>).nested, original.properties.nested);
  assert.ok((decorated.properties as Record<string, unknown>)[CONTROL]);
});
test('control has three modes and never leaks into business parameters', () => {
  for (const mode of ['auto', 'yes', 'no'] as const) {
    const input = { a: 1, nested: { [CONTROL]: 'business' }, [CONTROL]: mode };
    const split = splitControl(input); assert.equal(split.mode, mode);
    assert.deepEqual(split.args, { a: 1, nested: { [CONTROL]: 'business' } });
    assert.equal(input[CONTROL], mode);
  }
  assert.equal(splitControl({}).mode, 'auto');
  assert.throws(() => splitControl({ [CONTROL]: true }), /Invalid/);
});
test('reserved parameter collision fails closed', () => {
  assert.throws(() => decorateSchema({ type: 'object', properties: { [CONTROL]: {} } }), /collision/);
});
for (const key of ['allOf', 'anyOf', 'oneOf', 'not', 'patternProperties', 'propertyNames', '$ref', 'maxProperties', 'unevaluatedProperties', 'if', 'dependencies']) {
  test(`root ${key} is not rewritten incorrectly`, () => assert.throws(() => decorateSchema({ type: 'object', [key]: {} }), /Unsupported/));
}
test('nested refs and constraints survive without flattening', () => {
  const schema = { type: 'object', properties: { input: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/x' }] } }, $defs: { x: { type: 'number' } } };
  const decorated = decorateSchema(schema); assert.deepEqual(decorated.$defs, schema.$defs);
});
test('patterns are globs, never arbitrary regex', () => {
  assert.equal(matches('mcp__docs__search', ['mcp__*']), true);
  assert.equal(matches('mcpXX', ['mcp.*']), false);
  assert.equal(matches('mcp.*', ['mcp.*']), true);
});
test('configuration rejects unsafe or unknown options', () => {
  for (const value of [{ maxRunning: 0 }, { maxRunning: NaN }, { autoDetachMs: -1 }, { typo: true }, { include: [3] }]) assert.throws(() => validateConfig(value));
});
