import { compact, estimateTokens } from './compaction.ts';
import { buildSystemPrompt } from './context.ts';
import { OllamaError, type OllamaClient } from './ollama.ts';
import { PermissionEngine } from './permissions.ts';
import { extractTextToolCalls, textToolPrompt } from './textToolCalls.ts';
import { builtinTools } from './tools/index.ts';
import { ToolInputError } from './tools/util.ts';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  Message,
  PermissionMode,
  Tool,
  ToolCall,
  ToolResult,
} from './types.ts';

export interface AgentOptions {
  client: OllamaClient;
  model: string;
  cwd: string;
  mode: PermissionMode;
  /** Replaces the built-in tool set. */
  tools?: Tool[];
  /** Added to the tool set (MCP tools, daemon tools, …). */
  extraTools?: Tool[];
  /** Extra system prompt text (daemon goal, custom instructions). */
  instructions?: string;
  maxSteps?: number;
  /** Upper bound for the context window; the model's own limit is used if lower. */
  maxContext?: number;
  think?: boolean;
  temperature?: number;
  history?: Message[];
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

const COMPACT_AT = 0.8;

export class Agent {
  messages: Message[];
  readonly permissions: PermissionEngine;
  readonly state = new Map<string, unknown>();
  model: string;
  private tools: Tool[];
  private listeners = new Set<(e: AgentEvent) => void>();
  private controller: AbortController | null = null;
  private textMode = false;
  private capabilities: string[] = [];
  private numCtx = 8192;
  private lastPromptTokens = 0;
  private initialized = false;

  constructor(private opts: AgentOptions) {
    this.model = opts.model;
    this.messages = opts.history ? [...opts.history] : [];
    this.permissions = new PermissionEngine(opts.mode, opts.cwd);
    this.tools = [...(opts.tools ?? builtinTools()), ...(opts.extraTools ?? [])];
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  get running(): boolean {
    return this.controller !== null;
  }

  get contextWindow(): number {
    return this.numCtx;
  }

  get toolList(): Tool[] {
    return this.tools;
  }

  on(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e);
  }

  setMode(mode: PermissionMode): void {
    this.permissions.mode = mode;
    this.opts.mode = mode;
    this.initialized = false;
  }

  setModel(model: string): void {
    this.model = model;
    this.opts.model = model;
    this.initialized = false;
  }

  setExtraTools(tools: Tool[]): void {
    this.opts.extraTools = tools;
    this.tools = [...(this.opts.tools ?? builtinTools()), ...tools];
    this.initialized = false;
  }

  abort(): void {
    this.controller?.abort();
  }

  /** Start over: drop the conversation and per-session state. */
  reset(): void {
    this.messages = [];
    this.state.clear();
    this.lastPromptTokens = 0;
    this.initialized = false;
  }

  /** Resolve model capabilities and (re)build the system prompt. */
  private async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const details = await this.opts.client.showModel(this.model);
      this.capabilities = details.capabilities;
      const max = this.opts.maxContext ?? 16384;
      this.numCtx = details.contextLength ? Math.min(details.contextLength, max) : max;
    } catch {
      this.capabilities = [];
    }
    if (this.capabilities.length && !this.capabilities.includes('tools')) this.textMode = true;
    const system = await buildSystemPrompt({
      cwd: this.opts.cwd,
      mode: this.opts.mode,
      model: this.model,
      extra: this.opts.instructions,
      toolSection: this.textMode ? textToolPrompt(this.tools) : undefined,
    });
    if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: system };
    else this.messages.unshift({ role: 'system', content: system });
    this.initialized = true;
  }

  /** Send a user message and run the agent loop until the model stops calling tools. */
  async send(text: string, images?: string[]): Promise<void> {
    if (this.controller) throw new Error('Agent is already running.');
    const controller = (this.controller = new AbortController());
    const { signal } = controller;
    this.emit({ type: 'turn_start' });
    try {
      await this.init();
      this.messages.push({ role: 'user', content: text, ...(images?.length ? { images } : {}) });
      const reason = await this.loop(signal);
      this.emit({ type: 'turn_end', reason });
    } catch (err) {
      if (signal.aborted) {
        this.emit({ type: 'turn_end', reason: 'aborted' });
      } else {
        this.emit({ type: 'error', message: (err as Error).message });
        this.emit({ type: 'turn_end', reason: 'error' });
      }
    } finally {
      this.controller = null;
    }
  }

  private async loop(signal: AbortSignal): Promise<'done' | 'aborted' | 'max_steps'> {
    const maxSteps = this.opts.maxSteps ?? 60;
    const recentCalls: string[] = [];

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return 'aborted';
      await this.maybeCompact(signal);

      const assistant = await this.callModel(signal);
      this.messages.push(assistant);
      this.emit({ type: 'assistant_message', message: assistant });
      if (!assistant.toolCalls?.length) return 'done';

      for (const call of assistant.toolCalls) {
        if (signal.aborted) {
          this.pushToolResult(call, { output: 'Interrupted by user.', isError: true });
          continue;
        }
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        recentCalls.push(key);
        const result = await this.runTool(call, signal);
        if (recentCalls.slice(-3).length === 3 && recentCalls.slice(-3).every((k) => k === key)) {
          result.output += '\n\n[You have made this exact call three times in a row. Change your approach.]';
        }
        this.pushToolResult(call, result);
        if (result.stopTurn) return 'done';
      }
    }
    return 'max_steps';
  }

  private pushToolResult(call: ToolCall, result: ToolResult): void {
    this.messages.push({ role: 'tool', content: result.output, toolCallId: call.id, toolName: call.name });
    this.emit({ type: 'tool_result', callId: call.id, name: call.name, result });
  }

  private async callModel(signal: AbortSignal): Promise<Message> {
    let content = '';
    let thinking = '';
    let toolCalls: ToolCall[] = [];
    try {
      for await (const chunk of this.opts.client.chat({
        model: this.model,
        messages: this.textMode ? toTextMode(this.messages) : this.messages,
        tools: this.textMode ? undefined : this.tools,
        think: this.capabilities.includes('thinking') ? (this.opts.think ?? true) : undefined,
        numCtx: this.numCtx,
        temperature: this.opts.temperature,
        signal,
      })) {
        if (chunk.thinking) {
          thinking += chunk.thinking;
          this.emit({ type: 'thinking_delta', text: chunk.thinking });
        }
        if (chunk.content) {
          content += chunk.content;
          this.emit({ type: 'assistant_delta', text: chunk.content });
        }
        if (chunk.toolCalls.length) toolCalls.push(...chunk.toolCalls);
        if (chunk.done && chunk.promptTokens !== undefined) {
          this.lastPromptTokens = chunk.promptTokens + (chunk.completionTokens ?? 0);
          this.emit({
            type: 'usage',
            usage: { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens ?? 0, contextWindow: this.numCtx },
          });
        }
      }
    } catch (err) {
      if (err instanceof OllamaError && err.toolsUnsupported && !this.textMode) {
        this.textMode = true;
        this.initialized = false;
        await this.init();
        return this.callModel(signal);
      }
      throw err;
    }

    // Recover tool calls the model printed as text (always in text mode, and as a fallback otherwise).
    if (toolCalls.length === 0 && content) {
      const parsed = extractTextToolCalls(content, this.tools);
      if (parsed.calls.length) {
        toolCalls = parsed.calls;
        content = parsed.text;
      }
    }
    return { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult & { stopTurn?: boolean }> {
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      return { output: `Unknown tool "${call.name}". Available tools: ${this.tools.map((t) => t.name).join(', ')}.`, isError: true };
    }
    const summary = safeDescribe(tool, call.arguments);
    this.emit({ type: 'tool_call', call, summary });

    const verdict = this.permissions.check(tool, call.arguments);
    if (verdict.kind === 'deny') return { output: verdict.reason, isError: true };
    if (verdict.kind === 'ask') {
      const request: ApprovalRequest = { id: call.id, toolName: tool.name, summary, args: call.arguments, reason: verdict.reason };
      this.emit({ type: 'approval_request', request });
      const decision = await Promise.race([
        this.opts.approve(request),
        new Promise<ApprovalDecision>((resolve) =>
          signal.addEventListener('abort', () => resolve({ kind: 'deny' }), { once: true }),
        ),
      ]);
      this.emit({ type: 'approval_resolved', requestId: request.id, decision });
      if (decision.kind === 'deny') {
        return {
          output: `User denied this ${tool.name} call.${decision.feedback ? ` Feedback: ${decision.feedback}` : ' Stop and wait for the user.'}`,
          isError: true,
          stopTurn: !decision.feedback,
        };
      }
      if (decision.kind === 'allow-session') this.permissions.rememberForSession(tool, call.arguments);
    }

    const sandbox = verdict.sandboxed ? this.permissions.sandboxPolicy() : { enabled: false, writableRoots: [], allowNetwork: true };
    try {
      return await tool.run(call.arguments, {
        cwd: this.opts.cwd,
        signal,
        sandbox,
        state: this.state,
        emit: (e) => this.emit(e),
      });
    } catch (err) {
      if (signal.aborted) return { output: 'Interrupted by user.', isError: true };
      const e = err as NodeJS.ErrnoException;
      const msg = err instanceof ToolInputError ? e.message : e.code === 'ENOENT' ? `No such file or directory: ${e.path ?? ''}` : e.message;
      return { output: `Error: ${msg}`, isError: true };
    }
  }

  private async maybeCompact(signal: AbortSignal): Promise<void> {
    const used = Math.max(this.lastPromptTokens, estimateTokens(this.messages));
    if (used < this.numCtx * COMPACT_AT) return;
    const { messages, removed } = await compact(this.opts.client, this.model, this.messages, { numCtx: this.numCtx, signal });
    if (removed > 0) {
      this.messages = messages;
      this.lastPromptTokens = 0;
      this.emit({ type: 'compacted', removedMessages: removed });
    }
  }

  /** Force a compaction now (e.g. from a /compact command). */
  async compactNow(): Promise<number> {
    await this.init();
    const { messages, removed } = await compact(this.opts.client, this.model, this.messages, { numCtx: this.numCtx, keepRecent: 2 });
    this.messages = messages;
    this.lastPromptTokens = 0;
    if (removed) this.emit({ type: 'compacted', removedMessages: removed });
    return removed;
  }
}

function safeDescribe(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.describe?.(args) ?? tool.name;
  } catch {
    return tool.name;
  }
}

/** For models without native tool calling: inline calls and results as plain text. */
export function toTextMode(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls
        .map((c) => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.arguments })}\n</tool_call>`)
        .join('\n');
      return { role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') };
    }
    if (m.role === 'tool') {
      return { role: 'user', content: `<tool_result name="${m.toolName}">\n${m.content}\n</tool_result>` };
    }
    return m;
  });
}
