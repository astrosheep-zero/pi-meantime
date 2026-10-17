import { createHash } from 'node:crypto';
import type { Mode, Schema } from './protocol.ts';

export const CONTROL = '__background__';
export const MARKER = '[pi-bg-poc proxy]';
const UNSUPPORTED = ['$ref', '$dynamicRef', '$recursiveRef', 'allOf', 'anyOf', 'oneOf',
  'not', 'if', 'then', 'else', 'patternProperties', 'propertyNames',
  'unevaluatedProperties', 'dependencies', 'dependentSchemas', 'dependentRequired',
  'minProperties', 'maxProperties', 'const', 'enum'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Add the control property directly; an allOf/Intersect would conflict with
 * additionalProperties:false. Complex root constraints fail closed instead of
 * silently weakening the business schema. Nested schemas remain untouched. */
export function decorateSchema(original: unknown): Schema {
  if (!isRecord(original)) throw new Error('Only object schemas are supported');
  if (original.type !== 'object') throw new Error('Only explicit object-root schemas are supported');
  if (original.properties !== undefined && !isRecord(original.properties)) throw new Error('Invalid properties');
  const properties = (original.properties ?? {}) as Record<string, unknown>;
  if ((Array.isArray(original.required) && original.required.includes(CONTROL)) || Object.hasOwn(properties, CONTROL)) throw new Error(`Reserved property collision: ${CONTROL}`);
  for (const keyword of UNSUPPORTED) {
    if (Object.hasOwn(original, keyword)) throw new Error(`Unsupported root schema keyword: ${keyword}`);
  }
  const copy = JSON.parse(JSON.stringify(original)) as Schema;
  return {
    ...copy,
    properties: {
      ...(copy.properties as Record<string, unknown> | undefined),
      [CONTROL]: {
        type: 'string', enum: ['auto', 'yes', 'no'],
        description: 'Pi execution control, removed before dispatch. auto (default): foreground, may detach on timeout, Ctrl+Shift+B or steer; yes: request immediate background; no: never detach. Detach does not cancel the operation.',
      },
    },
  };
}
export function splitControl(args: Record<string, unknown>): { mode: Mode; args: Record<string, unknown> } {
  const value = args[CONTROL] ?? 'auto';
  if (value !== 'auto' && value !== 'yes' && value !== 'no') throw new Error(`Invalid ${CONTROL}: use auto, yes or no`);
  const business = { ...args };
  delete business[CONTROL];
  return { mode: value, args: business };
}
export function proxyName(original: string): string {
  const simple = `${original}_bg`;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(simple)) return simple;
  const clean = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45);
  return `${clean}_${createHash('sha256').update(original).digest('hex').slice(0, 12)}_bg`;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
}
