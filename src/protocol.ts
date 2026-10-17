/** Minimal public Pi v1.3 contract consumed by this extension.
 * SDK references are type-only: the runtime and FakePi do not import the SDK.
 * test/sdk-contract.compile.ts checks both host and tool assignability against
 * the pinned official SDK as part of npm run check.
 */
import type {
  AgentToolResult, BeforeAgentStartEventResult, ExtensionAPI, InputEventResult, ToolCallEventResult,
  ToolDefinition, ToolLoadout,
} from '@earendil-works/pi-coding-agent';
export type Json = Exclude<AgentToolResult<unknown>['structuredContent'], undefined>;
// A checked object-shaped schema, after narrowing the SDK's general TSchema.
export type Schema = Record<string, unknown>;
export type Mode = 'auto' | 'yes' | 'no';
export type Exposure = 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
export type Result = AgentToolResult<unknown>;
export type Content = Result['content'][number];
export interface Outcome {
  result: Result;
  isError: boolean;
  toolCall?: { id: string; name: string; arguments: unknown };
  durationMs?: number;
}
export type Update = (partial: Result) => void;
export interface Context {
  cwd: string;
  mode: 'tui' | 'rpc' | 'json' | 'print';
  hasUI: boolean;
  signal?: AbortSignal;
  isIdle(): boolean;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, content: string[] | undefined): void;
  };
}
export interface ToolContext extends Context {
  readonly tools: readonly ToolView[];
  executeTool(name: string, args: unknown, options?: {
    signal?: AbortSignal; onUpdate?: Update;
  }): Promise<Outcome>;
}
export interface ToolInfo {
  name: string;
  description: string;
  parameters: ToolDefinition['parameters'];
  exposure?: Exposure;
  promptGuidelines?: readonly string[];
  annotations?: {
    readOnlyHint?: boolean; destructiveHint?: boolean;
    idempotentHint?: boolean; openWorldHint?: boolean;
  };
  namespace?: { name: string; aliases?: readonly string[]; description?: string; instructions?: string };
  sourceInfo?: { path?: string };
}
/** A registry/loadout entry is a runtime AgentTool, not an extension definition.
 * Only metadata is consumed here; never call another tool's execute directly.
 */
export type ToolView = Pick<ToolLoadout['registered'][number],
  'name' | 'label' | 'description' | 'parameters' | 'outputSchema' | 'executionMode'>;
export interface Loadout {
  readonly declared: readonly ToolView[];
  readonly callable: readonly ToolView[];
  readonly registered: readonly ToolView[];
  getExposure(name: string): Exposure;
  getPromptGuidelines(name: string): readonly string[];
}
export interface Tool extends ToolInfo {
  label: string;
  parameters: Schema;
  // Registration takes a mutable array; read-only registry views remain safe.
  promptGuidelines?: string[];
  exposure?: Exposure;
  defaultActive?: boolean;
  outputSchema?: ToolDefinition['outputSchema'];
  constrainedSampling?: ToolDefinition['constrainedSampling'];
  executionMode?: 'parallel' | 'sequential';
  promptSnippet?: string;
  reachesTools?: (input: Record<string, unknown>) => 'all' | readonly string[];
  prepareLoadout?: (loadout: Loadout) => {
    hiddenDeclarations?: readonly string[];
    descriptions?: Readonly<Record<string, string>>;
  } | undefined;
  execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
    onUpdate: Update | undefined, ctx: ToolContext): Promise<Result>;
}
/** Built-in Bash input: preserve its native TypeBox schema, but consume only
 * the metadata and executor that the background wrapper actually uses.
 */
export type BashTool = Pick<Tool,
  'name' | 'description' | 'promptSnippet' | 'promptGuidelines' | 'annotations' | 'executionMode' | 'outputSchema' | 'constrainedSampling' | 'execute'>
  & Pick<ToolInfo, 'parameters'>;
export interface InputEvent {
  type: 'input'; text: string; source: 'interactive' | 'rpc' | 'extension';
  streamingBehavior?: 'steer' | 'followUp'; images?: Content[];
}
export interface ToolCallEvent {
  type: 'tool_call'; toolName: string; toolCallId: string;
  parentToolCallId?: string; input: Record<string, unknown>;
}
export interface ToolEndEvent {
  type: 'tool_execution_end'; toolCallId: string; parentToolCallId?: string;
  toolName: string; result: Result; isError: boolean;
}
export interface EventMap {
  session_start: { type: 'session_start' };
  session_shutdown: { type: 'session_shutdown'; reason?: string };
  session_tree: { type: 'session_tree' };
  before_agent_start: { type: 'before_agent_start' };
  agent_settled: { type: 'agent_settled'; aborted?: boolean };
  mcp_servers_change: { type: 'mcp_servers_change' };
  input: InputEvent;
  tool_call: ToolCallEvent;
  tool_execution_end: ToolEndEvent;
  ui_prompt_start: { type: 'ui_prompt_start' };
  ui_prompt_end: { type: 'ui_prompt_end' };
}
export interface EventResultMap {
  session_start: void;
  session_shutdown: void;
  session_tree: void;
  before_agent_start: BeforeAgentStartEventResult;
  agent_settled: void;
  mcp_servers_change: void;
  input: InputEventResult;
  tool_call: ToolCallEventResult;
  tool_execution_end: void;
  ui_prompt_start: void;
  ui_prompt_end: void;
}
export type EventHandler<K extends keyof EventMap> =
  (event: EventMap[K], ctx: Context) => EventResultMap[K] | void | Promise<EventResultMap[K] | void>;
export interface PiHost {
  registerTool(tool: Tool): void;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  getSettings(): { shellPath?: string; shellCommandPrefix?: string };
  on<K extends keyof EventMap>(event: K,
    handler: EventHandler<K>): () => void;
  registerShortcut(key: Parameters<ExtensionAPI['registerShortcut']>[0], options: {
    description: string; handler: (ctx: Context) => void | Promise<void>;
  }): void;
  registerCommand(name: string, options: {
    description: string; handler: (args: string, ctx: Context) => Promise<void>;
  }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: 'followUp'; triggerTurn: true }): void;
  appendEntry(customType: string, data?: unknown): void;
}
