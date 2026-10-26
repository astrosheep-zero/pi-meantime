// @ts-check
// Keep host imports in native ESM. Besides avoiding a second local SDK copy,
// this bypasses Jiti's unbundled-SDK prefix aliases, which otherwise resolve
// pi-ai/utils/* below dist/compat.js while loading the coding-agent root.
const { AgentSession, createCodemodeExtension } = await import('@earendil-works/pi-coding-agent');
const { captureCodemodeExecute } = await import('./src/codemode.ts');
const { install } = await import('./src/extension.ts');
const { captureSession } = await import('./src/host.ts');
const { loadConfig } = await import('./src/config.ts');

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function backgroundPoc(pi) {
  install(pi, { config: loadConfig(), codemodeExecute: captureCodemodeExecute(pi, createCodemodeExtension),
    connect: host => captureSession(host, AgentSession) });
}
