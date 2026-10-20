import type { Mode, Result, Schema } from './protocol.ts';

export const CONTROL = '__background__';
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
      [CONTROL]: { type: 'string', enum: ['auto', 'yes', 'no'] },
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
/** Serialize before entering Pi's append path (which advances its memory leaf
 * before writing JSONL). Keep the live Result untouched; optional unknown data
 * must not strand the session tree or discard serializable usage/records. */
export function projectResult(source: Result): Result {
  const result: Result = { content: JSON.parse(JSON.stringify(source.content)), details: undefined,
    ...(source.isError !== undefined ? { isError: source.isError } : {}), ...(source.terminate ? { terminate: true } : {}),
  };
  const omitted = new Set(source.persistenceOmissions);
  for (const key of ['details', 'structuredContent', 'nestedCalls', 'usage'] as const) {
    if (source[key] === undefined) continue;
    try { Object.assign(result, { [key]: JSON.parse(JSON.stringify(source[key])) }); }
    catch { omitted.add(key); }
  }
  if (omitted.size) result.persistenceOmissions = [...omitted];
  return result;
}

export function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
}
