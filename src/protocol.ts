/** Narrow Pi 1.3 shapes shared by runtime/UI and the deterministic host double.
 * test/sdk-contract.compile.ts checks assignability against the official SDK. */
import type {
  AgentToolResult, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, InputEventResult, ToolCallEventResult,
  ToolDefinition, ToolLoadout, TurnEndEventResult,
} from '@earendil-works/pi-coding-agent';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
export type Json = Exclude<AgentToolResult<unknown>['structuredContent'], undefined>;
// A checked object-shaped schema, after narrowing the SDK's general TSchema.
export type Schema = Record<string, unknown>;
export type Mode = 'auto' | 'yes' | 'no';
export type Exposure = 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
/** nestedCalls is retained completion metadata, not a rewritten transcript message. */
export type Result = AgentToolResult<unknown> & {
  nestedCalls?: ToolResultMessage['nestedCalls']; persistenceOmissions?: string[];
};
/** Late scope metadata, separate from the already-returned script observation. */
export interface ScopeResult { result: Result; usage?: Result['usage'] }
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
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined;
    getEntries(): { type: string; customType?: string; data?: unknown }[] };
  ui: {
    custom: ExtensionContext['ui']['custom'];
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
/** Copied AgentTool metadata, distinct from the raw extension definition. */
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
  prepareArguments?: (args: unknown) => unknown;
  execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
    onUpdate: Update | undefined, ctx: ToolContext): Promise<Result>;
}
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
  session_before_tree: { type: 'session_before_tree' };
  session_tree: { type: 'session_tree' };
  session_compact: { type: 'session_compact' };
  session_compact_failed: { type: 'session_compact_failed' };
  turn_end: { type: 'turn_end'; outcome?: 'completed' | 'aborted' | 'error' };
  tool_execution_start: { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string };
  before_agent_start: { type: 'before_agent_start'; systemPromptOptions: { sections: Record<string, string> } };
  agent_settled: { type: 'agent_settled'; aborted?: boolean };
  input: InputEvent;
  tool_call: ToolCallEvent;
  tool_execution_end: ToolEndEvent;
  ui_prompt_start: { type: 'ui_prompt_start' };
  ui_prompt_end: { type: 'ui_prompt_end' };
}
export interface EventResultMap {
  session_start: void;
  session_shutdown: void;
  session_before_tree: void;
  session_tree: void;
  session_compact: void;
  session_compact_failed: void;
  turn_end: TurnEndEventResult;
  tool_execution_start: void;
  before_agent_start: BeforeAgentStartEventResult;
  agent_settled: void;
  input: InputEventResult;
  tool_call: ToolCallEventResult;
  tool_execution_end: void;
  ui_prompt_start: void;
  ui_prompt_end: void;
}
export type EventHandler<K extends keyof EventMap> =
  (event: EventMap[K], ctx: Context) => EventResultMap[K] | void | Promise<EventResultMap[K] | void>;
export interface PiHost {
  registerToolRenderer: ExtensionAPI['registerToolRenderer'];
  registerTool(tool: Tool): void;
  getAllTools(): ToolInfo[];
  on<K extends keyof EventMap>(event: K,
    handler: EventHandler<K>): () => void;
  registerShortcut(key: Parameters<ExtensionAPI['registerShortcut']>[0], options: {
    description: string; handler: (ctx: Context) => void | Promise<void>;
  }): void;
  registerCommand(name: string, options: {
    description: string; handler: (args: string, ctx: Context) => Promise<void>;
  }): void;
  appendEntry(customType: string, data?: unknown): void;
}
