/** Compile-only: never import this file at runtime.
 * npm run typecheck (and npm run check) compile it against the pinned official
 * SDK. Positive calls must remain assignable; @ts-expect-error cases must fail.
 * No casts bridge the SDK and our contract.
 */
import type {
  AgentSession, AgentToolResult, ExtensionAPI, ExtensionFactory, ExtensionToolContext,
  ToolDefinition, ToolLoadout,
} from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import backgroundPoc from '../index.mjs';
import { install } from '../src/extension.ts';
import type { InstallOptions } from '../src/extension.ts';
import type { Loadout, PiHost, Result, Tool, ToolContext, ToolInfo } from '../src/protocol.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { decorateSchema } from '../src/schema.ts';

declare const pi: ExtensionAPI;
declare const tool: Tool;
declare const context: ExtensionToolContext;
declare const loadout: ToolLoadout;
declare const sdkResult: AgentToolResult<unknown>;
declare const session: AgentSession;

// The shipped entry and installation both accept a real, unadapted SDK host.
const entry: ExtensionFactory = backgroundPoc;
const host: PiHost = pi;
const options: InstallOptions = {
  config: DEFAULT_CONFIG,
  baseBash: createBashToolDefinition(process.cwd()),
  makeBash: cwd => createBashToolDefinition(cwd),
};
install(pi, options);

// Outgoing definitions are accepted by the SDK's real generic registerTool.
const sdkTool: ToolDefinition = tool;
pi.registerTool(tool);

// Incoming runtime tools are AgentTool entries, not extension definitions.
const toolContext: ToolContext = context;
const toolLoadout: Loadout = loadout;
const registry: ToolInfo[] = pi.getAllTools();
const prepareLoadout: NonNullable<ToolDefinition['prepareLoadout']> = current => {
  const view: Loadout = current;
  return tool.prepareLoadout?.(view);
};

// Public TSchema does not promise a string index signature. The schema boundary
// validates it before transformation, including native TypeBox Bash schemas.
const bash = createBashToolDefinition(process.cwd());
const proxyParameters = decorateSchema(bash.parameters);
pi.registerTool({ ...tool, parameters: proxyParameters, prepareLoadout });

// Read-only metadata can be observed; registration receives its own mutable copy.
const readonlyGuidelines: readonly string[] = ['Keep the original execution policy.'];
const info: ToolInfo = { ...tool, promptGuidelines: readonlyGuidelines };
const registration: Tool = { ...tool, promptGuidelines: [...(info.promptGuidelines ?? [])] };
pi.registerTool(registration);
// @ts-expect-error The real SDK rejects readonly registration guidelines.
pi.registerTool({ ...tool, promptGuidelines: readonlyGuidelines });
// @ts-expect-error Our outgoing Tool contract must reject them too.
const invalidGuidelines: Tool = { ...tool, promptGuidelines: readonlyGuidelines };

// Incoming SDK results and outgoing retained results preserve the public shape,
// including readonly JSON arrays and fully specified Usage accounting.
const retained: Result = sdkResult;
const emitted: AgentToolResult<unknown> = retained;
const readonlyJson: Result = { content: [], details: undefined, structuredContent: ['retained', 1] as const };
// @ts-expect-error Partial token counters are not a valid SDK Usage record.
const invalidUsage: Result = { content: [], details: undefined, usage: { input: 3, output: 4 } };

// The smoke's awaited teardown uses the public SDK lifecycle emitter.
session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });

// Event returns, commands and shortcuts stay within actual host contracts.
host.on('input', () => ({ action: 'continue' }));
host.on('tool_call', () => ({ block: true, reason: 'Use the managed proxy.' }));
// @ts-expect-error Unknown input actions cannot be registered.
host.on('input', () => ({ action: 'retry' }));
// @ts-expect-error SDK command handlers are asynchronous.
host.registerCommand('invalid', { description: 'compile-only', handler() {} });
// @ts-expect-error SDK KeyId rejects an arbitrary string.
host.registerShortcut('not-a-real-key', { description: 'compile-only', handler() {} });

void [entry, host, sdkTool, toolContext, toolLoadout, registry, emitted, readonlyJson,
  invalidGuidelines, invalidUsage];
