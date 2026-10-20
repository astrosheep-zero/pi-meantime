// @ts-check
// Pi's Jiti require resolves virtual host modules before native ESM can pick a
// second local SDK copy. Session identity must come from the running host.
const { AgentSession, createCodemodeExtension } = require('@earendil-works/pi-coding-agent');
const { registerCodemode } = require('./src/codemode.ts');
const { install } = require('./src/extension.ts');
const { captureSession } = require('./src/host.ts');
const { loadConfig } = require('./src/config.ts');

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function backgroundPoc(pi) {
  registerCodemode(pi, createCodemodeExtension);
  install(pi, { config: loadConfig(), connect: host => captureSession(host, AgentSession) });
}
