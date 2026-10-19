import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isRecord } from './schema.ts';

export interface Config {
  include: string[];
  exclude: string[];
  autoDetachMs: number;
  maxRunning: number;
  maxRetained: number;
  shutdownGraceMs: number;
  notifyDebounceMs: number;
  detachOnSteer: boolean;
}
export const DEFAULT_CONFIG: Config = {
  include: ['*'],
  exclude: [],
  autoDetachMs: 120_000,
  maxRunning: 4,
  maxRetained: 128,
  shutdownGraceMs: 1000,
  notifyDebounceMs: 50,
  detachOnSteer: true,
};
export function validateConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error('meantime config must be an object');
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown meantime setting: ${key}`);
  const config = { ...DEFAULT_CONFIG, ...raw } as Config;
  for (const key of ['include', 'exclude'] as const) {
    if (!Array.isArray(config[key]) || !config[key].every(v => typeof v === 'string' && v.length > 0)) throw new Error(`${key} must be an array of patterns`);
  }
  const bounds: [keyof Config, number, number][] = [
    ['autoDetachMs', 0, 2_147_483_647], ['maxRunning', 1, 32], ['maxRetained', 1, 512],
    ['shutdownGraceMs', 0, 10_000], ['notifyDebounceMs', 0, 5000],
  ];
  for (const [key, min, max] of bounds) {
    const n = config[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
  }
  if (typeof config.detachOnSteer !== 'boolean') throw new Error('detachOnSteer must be boolean');
  return config;
}
/** Only explicit/global configuration, never automatically consume untrusted project config. */
export function loadConfig(): Config {
  const file = process.env.PI_MEANTIME_CONFIG;
  if (file && !isAbsolute(file)) throw new Error('PI_MEANTIME_CONFIG must be an absolute path');
  const path = file ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'meantime.json');
  try { return validateConfig(JSON.parse(readFileSync(resolve(path), 'utf8'))); }
  catch (error) {
    if (!file && (error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({});
    throw error;
  }
}
