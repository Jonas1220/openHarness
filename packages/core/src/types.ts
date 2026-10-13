export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Reasoning text from thinking models. Not sent back to the model. */
  thinking?: string;
  toolCalls?: ToolCall[];
  /** For role === 'tool': which call this answers. */
  toolCallId?: string;
  toolName?: string;
  /** Base64-encoded images (vision models). */
  images?: string[];
  /** Marks a compaction summary that replaced earlier history. */
  summary?: boolean;
}

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** What a tool may affect. Drives the permission check. `external` runs outside our sandbox (e.g. MCP servers). */
export type ToolKind = 'read' | 'write' | 'exec' | 'network' | 'external' | 'meta';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  sandbox: SandboxPolicy;
  /** Session-scoped scratch state (todo list, etc). */
  state: Map<string, unknown>;
  emit: (event: AgentEvent) => void;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  kind: ToolKind;
  /** Short human-readable description of a pending call, shown in approval prompts. */
  describe?: (args: Record<string, unknown>) => string;
  /** Paths the call will write to, used to keep writes inside the workspace. */
  targetPaths?: (args: Record<string, unknown>, cwd: string) => string[];
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export type PermissionMode = 'read-only' | 'ask' | 'auto-edit' | 'full-auto';

export interface SandboxPolicy {
  enabled: boolean;
  writableRoots: string[];
  allowNetwork: boolean;
}

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'allow-session' }
  | { kind: 'deny'; feedback?: string };

export interface ApprovalRequest {
  id: string;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  contextWindow: number;
}

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'assistant_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'tool_call'; call: ToolCall; summary: string }
  | { type: 'tool_result'; callId: string; name: string; result: ToolResult }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'compacted'; removedMessages: number }
  | { type: 'error'; message: string }
  | { type: 'turn_end'; reason: 'done' | 'aborted' | 'max_steps' | 'error' };

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
