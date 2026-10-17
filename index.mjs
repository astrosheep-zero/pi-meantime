// @ts-check
// Pi supplies this package when loading an extension. No runtime npm dependency
// is required by the task runtime itself. See docs/API-CONTRACT.md.
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { install } from './src/extension.ts';
import { loadConfig } from './src/config.ts';

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function backgroundPoc(pi) {
  install(pi, {
    config: loadConfig(),
    // During extension load the session runtime is not yet bound. Only the
    // execution-time factory below may call pi.getSettings().
    baseBash: createBashToolDefinition(process.cwd()),
    makeBash: (cwd) => {
      // Reuse the live, effective host settings instead of rereading project files.
      const settings = pi.getSettings();
      return createBashToolDefinition(cwd, {
        shellPath: settings.shellPath,
        commandPrefix: settings.shellCommandPrefix,
      });
    },
  });
}
