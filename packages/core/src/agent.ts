import { randomUUID } from 'node:crypto';
import { CheckpointLog } from './checkpoints.ts';
import { compact, estimateTokens } from './compaction.ts';
import { buildSystemPrompt } from './context.ts';
import { HookRunner, type HooksConfig } from './hooks.ts';
import { memoryPrompt, memoryTools } from './memory.ts';
import { expandMentions } from './mentions.ts';
import { OllamaError } from './ollama.ts';
import type { ModelClient } from './providers.ts';
import { PROPOSE_PLAN, PermissionEngine } from './permissions.ts';
import { loadSkillTool, loadSkills, skillsPrompt } from './skills.ts';
import { extractTextToolCalls, textToolPrompt } from './textToolCalls.ts';
import { deferredToolsPrompt, isDeferrable, searchToolsTool, useToolSearch, type ToolSearchSetting } from './toolSearch.ts';
import { builtinTools, exec } from './tools/index.ts';
import { ToolInputError } from './tools/util.ts';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  Checkpoint,
  Message,
  PermissionMode,
  Tool,
  ToolCall,
  ToolResult,
} from './types.ts';

export interface AgentOptions {
  client: ModelClient;
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
  /** Optional cap for the context window. 0 or unset = the model's full context. */
  maxContext?: number;
  think?: boolean;
  temperature?: number;
  history?: Message[];
  /** Saved checkpoints of an earlier run of this session. */
  checkpoints?: Checkpoint[];
  /** Share a checkpoint log with another agent (subagents record into their parent's undo history). */
  checkpointLog?: CheckpointLog;
  /** Extra folders sandboxed commands may write to. */
  writableRoots?: string[];
  /** Offer the `task` tool for delegating research to a subagent (default true). */
  subagents?: boolean;
  /** Load skills from the skill folders (default true). */
  skills?: boolean;
  /** Auto memory: remember/forget tools and saved facts in the prompt (default true). */
  memory?: boolean;
  /** Load MCP tools on demand via search_tools (default 'auto': when there are many). */
  toolSearch?: ToolSearchSetting;
  /** Lifecycle hooks (Claude Code format). */
  hooks?: HooksConfig;
  /** Identifies the chat to hooks. */
  sessionId?: string;
  /**
   * Check command run when the agent finishes a turn in which it changed something
   * (e.g. "npm test && npm run typecheck"). On failure the output goes back to the agent.
   */
  verify?: { command: string; maxRounds?: number; timeoutSec?: number };
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface SendOptions {
  images?: string[];
  /** Id for the user message (generated when omitted); used for rewinding. */
  id?: string;
}

const COMPACT_AT = 0.8;

export class Agent {
  messages: Message[];
  readonly permissions: PermissionEngine;
  readonly state = new Map<string, unknown>();
  readonly checkpoints: CheckpointLog;
  model: string;
  private tools: Tool[];
  private agentTools: Tool[] = [];
  private activatedTools = new Set<string>();
  private hookRunner: HookRunner | null = null;
  private turnId = '';
  /** The current turn edited files or ran commands, so verification is due. */
  private turnChanged = false;
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
    this.permissions = new PermissionEngine(opts.mode, opts.cwd, opts.writableRoots);
    this.checkpoints = opts.checkpointLog ?? new CheckpointLog(opts.checkpoints ?? []);
    this.tools = [...(opts.tools ?? builtinTools()), ...(opts.extraTools ?? [])];
    this.setHooks(opts.hooks);
  }

  get mode(): PermissionMode {
    return this.permissions.mode;
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

  /**
   * Tools offered to the model right now: propose_plan only in plan mode, and with tool
   * search active only the MCP tools the model has loaded via search_tools.
   */
  get toolList(): Tool[] {
    let all = [...this.tools, ...this.agentTools];
    if (this.toolSearchActive) all = all.filter((t) => !isDeferrable(t) || this.activatedTools.has(t.name));
    else all = all.filter((t) => t.name !== 'search_tools');
    return this.mode === 'plan' ? all : all.filter((t) => t.name !== PROPOSE_PLAN);
  }

  private get toolSearchActive(): boolean {
    return useToolSearch(this.tools, this.opts.toolSearch);
  }

  /** MCP tools not loaded yet (only meaningful while tool search is active). */
  private get deferredTools(): Tool[] {
    return this.tools.filter((t) => isDeferrable(t) && !this.activatedTools.has(t.name));
  }

  setHooks(hooks: HooksConfig | undefined): void {
    this.opts.hooks = hooks;
    this.hookRunner = hooks && Object.keys(hooks).length ? new HookRunner(hooks, { sessionId: this.opts.sessionId ?? 'cli', cwd: this.opts.cwd }) : null;
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

  /** Apply changed settings; takes effect on the next model call. */
  setOptions(patch: Partial<Pick<AgentOptions, 'maxContext' | 'think' | 'temperature' | 'toolSearch' | 'verify'>>): void {
    Object.assign(this.opts, patch);
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
    this.checkpoints.list = [];
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
      // Use the model's full context window unless the user set a cap.
      const modelMax = details.contextLength ?? 8192;
      this.numCtx = this.opts.maxContext ? Math.min(this.opts.maxContext, modelMax) : modelMax;
    } catch {
      this.capabilities = [];
      this.numCtx = this.opts.maxContext || 8192;
    }
    if (this.capabilities.length && !this.capabilities.includes('tools')) this.textMode = true;
    const skills = this.opts.skills === false ? [] : await loadSkills(this.opts.cwd);
    const memory = this.opts.memory !== false;
    this.agentTools = [proposePlanTool];
    if (skills.length) this.agentTools.push(loadSkillTool(skills));
    if (this.opts.subagents !== false) this.agentTools.push(this.taskTool());
    if (memory) this.agentTools.push(...memoryTools(this.opts.cwd));
    this.agentTools.push(
      searchToolsTool(
        () => this.deferredTools,
        (names) => {
          for (const n of names) this.activatedTools.add(n);
          if (this.textMode) this.initialized = false; // the tool list lives in the prompt
        },
      ),
    );
    const system = await buildSystemPrompt({
      cwd: this.opts.cwd,
      mode: this.opts.mode,
      model: this.model,
      extra: [
        this.opts.instructions,
        skillsPrompt(skills),
        memory ? await memoryPrompt(this.opts.cwd) : '',
        this.toolSearchActive && this.deferredTools.length ? deferredToolsPrompt(this.deferredTools) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      toolSection: this.textMode ? textToolPrompt(this.toolList) : undefined,
    });
    if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: system };
    else this.messages.unshift({ role: 'system', content: system });
    this.initialized = true;
  }

  /** Send a user message and run the agent loop until the model stops calling tools. */
  async send(text: string, opts: SendOptions = {}): Promise<void> {
    if (this.controller) throw new Error('Agent is already running.');
    const controller = (this.controller = new AbortController());
    const { signal } = controller;
    this.turnId = opts.id ?? randomUUID();
    this.turnChanged = false;
    this.emit({ type: 'turn_start' });
    try {
      await this.init();
      let content = await expandMentions(text, this.opts.cwd);
      if (this.hookRunner?.has('UserPromptSubmit')) {
        const hook = await this.hookRunner.run('UserPromptSubmit', { prompt: text }, signal);
        this.reportHookErrors('UserPromptSubmit', hook.errors);
        if (hook.block) {
          this.emit({ type: 'hook', event: 'UserPromptSubmit', message: `Prompt blocked by a hook: ${hook.reason ?? ''}`.trim() });
          this.emit({ type: 'turn_end', reason: 'done' });
          return;
        }
        if (hook.context) content += `\n\n<hook_context>\n${hook.context}\n</hook_context>`;
      }
      this.messages.push({ role: 'user', id: this.turnId, content, ...(opts.images?.length ? { images: opts.images } : {}) });
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
    let stopHookRounds = 0;
    let verifyRounds = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return 'aborted';
      await this.init(); // the mode may have changed (plan approved), which changes the system prompt
      await this.maybeCompact(signal);

      const assistant = await this.callModel(signal);
      this.messages.push(assistant);
      this.emit({ type: 'assistant_message', message: assistant });
      if (!assistant.toolCalls?.length) {
        // Built-in verification: run the project's checks and send failures back to the agent.
        const verify = this.opts.verify;
        if (verify?.command && this.turnChanged && verifyRounds < (verify.maxRounds ?? 3) && this.mode !== 'plan' && this.mode !== 'read-only') {
          verifyRounds++;
          const failure = await this.runVerify(verify, signal);
          if (failure !== null) {
            this.turnChanged = false;
            this.messages.push({
              role: 'user',
              content: `[Verify] \`${verify.command}\` failed:\n\n${failure}\n\nFix the cause (don't weaken or skip the checks), then finish.`,
            });
            continue;
          }
        }
        // A Stop hook can send the agent back to work (e.g. "tests are failing"), at most 3 times.
        if (this.hookRunner?.has('Stop') && stopHookRounds < 3) {
          const hook = await this.hookRunner.run('Stop', {}, signal);
          this.reportHookErrors('Stop', hook.errors);
          if (hook.block && hook.reason) {
            stopHookRounds++;
            this.emit({ type: 'hook', event: 'Stop', message: `A Stop hook asked the agent to continue: ${hook.reason}` });
            this.messages.push({ role: 'user', content: `[Stop hook] ${hook.reason}` });
            continue;
          }
        }
        return 'done';
      }

      const calls = assistant.toolCalls;
      for (let i = 0; i < calls.length; i++) {
        // Consecutive task calls are independent subagents: run them in parallel.
        let j = i;
        while (j < calls.length && calls[j]!.name === 'task') j++;
        if (j - i > 1) {
          const batch = calls.slice(i, j);
          const results = await Promise.all(batch.map((c) => this.runTool(c, signal)));
          batch.forEach((c, k) => this.pushToolResult(c, results[k]!));
          if (results.some((r) => r.stopTurn)) return 'done';
          i = j - 1;
          continue;
        }

        const call = calls[i]!;
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
        tools: this.textMode ? undefined : this.toolList,
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
      const parsed = extractTextToolCalls(content, this.toolList);
      if (parsed.calls.length) {
        toolCalls = parsed.calls;
        content = parsed.text;
      }
    }
    return { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult & { stopTurn?: boolean }> {
    const tool = this.toolList.find((t) => t.name === call.name);
    if (!tool) {
      return { output: `Unknown tool "${call.name}". Available tools: ${this.toolList.map((t) => t.name).join(', ')}.`, isError: true };
    }
    const summary = safeDescribe(tool, call.arguments);
    this.emit({ type: 'tool_call', call, summary });

    let verdict = this.permissions.check(tool, call.arguments);
    if (this.hookRunner?.has('PreToolUse')) {
      const hook = await this.hookRunner.run('PreToolUse', { toolName: tool.name, toolInput: call.arguments }, signal);
      this.reportHookErrors('PreToolUse', hook.errors);
      if (hook.block || hook.decision === 'deny') {
        return { output: `Blocked by a PreToolUse hook: ${hook.reason ?? 'no reason given'}`, isError: true };
      }
      // A hook can skip the approval prompt or force one, but never lift a mode's hard deny.
      if (hook.decision === 'allow' && verdict.kind === 'ask') verdict = { kind: 'allow', sandboxed: verdict.sandboxed };
      if (hook.decision === 'ask' && verdict.kind === 'allow') verdict = { kind: 'ask', reason: hook.reason ?? 'A hook asks for approval', sandboxed: verdict.sandboxed };
    }
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
      if (tool.name === PROPOSE_PLAN) {
        const next = (decision.kind === 'allow' && decision.mode) || 'auto-edit';
        this.setMode(next);
        this.emit({ type: 'mode_changed', mode: next });
        return { output: `The user approved the plan. You are now in ${next} mode — implement the plan step by step.` };
      }
    }

    if (tool.kind === 'write' || tool.kind === 'exec') this.turnChanged = true;

    if (tool.kind === 'write' && tool.targetPaths) {
      const cp = await this.checkpoints.capture(this.turnId, tool.targetPaths(call.arguments, this.opts.cwd));
      if (cp) this.emit({ type: 'checkpoint', checkpoint: cp });
    }

    const sandbox = verdict.sandboxed ? this.permissions.sandboxPolicy() : { enabled: false, writableRoots: [], allowNetwork: true };
    const result = await this.execute(tool, call, signal, sandbox);
    if (this.hookRunner?.has('PostToolUse') && !signal.aborted) {
      const hook = await this.hookRunner.run('PostToolUse', { toolName: tool.name, toolInput: call.arguments, toolResponse: result }, signal);
      this.reportHookErrors('PostToolUse', hook.errors);
      if (hook.block && hook.reason) result.output += `\n\n[PostToolUse hook] ${hook.reason}`;
      if (hook.context) result.output += `\n\n[Hook context] ${hook.context}`;
    }
    return result;
  }

  /** Run the verify command; returns null when it passes, else the tail of its output. */
  private async runVerify(verify: NonNullable<AgentOptions['verify']>, signal: AbortSignal): Promise<string | null> {
    this.emit({ type: 'verify', status: 'running', command: verify.command });
    const res = await exec(['/bin/zsh', '-c', verify.command], {
      cwd: this.opts.cwd,
      timeoutMs: (verify.timeoutSec ?? 600) * 1000,
      signal,
    }).catch((err: Error) => ({ stdout: '', stderr: err.message, code: 1, timedOut: false }));
    if (res.code === 0) {
      this.emit({ type: 'verify', status: 'passed', command: verify.command });
      return null;
    }
    const output = `${res.stdout}\n${res.stderr}`.trim();
    const tail = output.length > 4000 ? `…${output.slice(-4000)}` : output;
    const reason = res.timedOut ? `${tail}\n[timed out after ${verify.timeoutSec ?? 600}s]` : tail;
    this.emit({ type: 'verify', status: 'failed', command: verify.command, output: reason });
    return reason || `exit code ${res.code}`;
  }

  private reportHookErrors(event: string, errors: string[]): void {
    for (const e of errors) this.emit({ type: 'hook', event, message: `Hook failed: ${e}` });
  }

  private async execute(
    tool: Tool,
    call: ToolCall,
    signal: AbortSignal,
    sandbox: ReturnType<PermissionEngine['sandboxPolicy']>,
  ): Promise<ToolResult> {
    try {
      return await tool.run(call.arguments, {
        cwd: this.opts.cwd,
        callId: call.id,
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

  /**
   * Go back to before the user message `messageId`: restore the files the agent
   * changed since then and/or drop that message and everything after it.
   */
  async rewind(messageId: string, opts: { code?: boolean; conversation?: boolean } = { code: true, conversation: true }): Promise<string[]> {
    if (this.running) throw new Error('Stop the agent before rewinding.');
    const restored = opts.code ? await this.checkpoints.rewind(messageId) : [];
    if (opts.conversation) {
      const idx = this.messages.findIndex((m) => m.role === 'user' && m.id === messageId);
      if (idx > 0) this.messages = this.messages.slice(0, idx);
      if (!opts.code) this.checkpoints.list = this.checkpoints.list.filter((c) => this.messages.some((m) => m.id === c.messageId));
      this.lastPromptTokens = 0;
    }
    return restored;
  }

  /**
   * The `task` tool hands a self-contained job to a subagent with its own context.
   * - research: read-only tools, no approvals, returns a report (cheap on the main context)
   * - general: the parent's tools and permission mode; its tool calls and approval requests
   *   appear in the parent's chat, and its edits go into the parent's undo history
   * Several task calls in one turn run in parallel.
   */
  private taskTool(): Tool {
    return {
      name: 'task',
      kind: 'read',
      description:
        'Delegate a self-contained job to a subagent with its own context. kind "research" (default): read-only tools, for searching and understanding code without filling your context. kind "general": can also edit files and run commands, for independent pieces of implementation work. Give complete, specific instructions; you only get back its final report. Call task several times in one message to run subagents in parallel.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Three to five word label for the task.' },
          prompt: { type: 'string', description: 'Full instructions, including what to report back.' },
          kind: { type: 'string', enum: ['research', 'general'], description: 'research (read-only, default) or general (can edit and run commands).' },
        },
        required: ['prompt'],
      },
      describe: (a) => `Subagent${a.kind === 'general' ? '' : ' (research)'}: ${a.description ?? String(a.prompt ?? '').slice(0, 60)}`,
      run: async (args, ctx) => {
        const general = args.kind === 'general';
        const label = String(args.description ?? 'subagent').slice(0, 40);
        const readOnlyMode = this.mode === 'plan' || this.mode === 'read-only';
        const child = new Agent({
          client: this.opts.client,
          model: this.model,
          cwd: this.opts.cwd,
          mode: general && !readOnlyMode ? this.mode : 'read-only',
          tools: general
            ? builtinTools()
            : builtinTools().filter((t) => ['read_file', 'list_dir', 'glob', 'grep'].includes(t.name)),
          extraTools: general ? this.opts.extraTools : undefined,
          subagents: false,
          skills: false,
          memory: false,
          maxSteps: general ? 40 : 25,
          maxContext: this.opts.maxContext,
          think: this.opts.think,
          hooks: this.opts.hooks,
          sessionId: this.opts.sessionId,
          writableRoots: this.opts.writableRoots,
          checkpointLog: this.checkpoints,
          toolSearch: this.opts.toolSearch,
          instructions: general
            ? 'You are a subagent working on one part of a larger task for another agent. Do the work with your tools, verify it where possible, then reply with a concise report: what you changed (file paths), how you verified it, and anything left open. Do not ask the user questions.'
            : 'You are a subagent doing focused research for another agent. Investigate with your tools, then reply with a concise report: findings, relevant file paths with line numbers, and open questions. Do not ask the user anything.',
          approve: general
            ? (req) => this.opts.approve({ ...req, summary: `[${label}] ${req.summary}` })
            : async () => ({ kind: 'deny', feedback: 'Research subagents cannot request approval.' }),
        });
        let report = '';
        let error = '';
        child.on((e) => {
          if (e.type === 'tool_call') {
            ctx.emit({ type: 'subagent_progress', callId: ctx.callId, summary: e.summary });
            // General subagents show their calls in the chat so their approvals can be answered there.
            if (general) ctx.emit({ ...e, summary: `↳ ${label}: ${e.summary}` });
          }
          if (general && (e.type === 'tool_result' || e.type === 'approval_request' || e.type === 'approval_resolved' || e.type === 'checkpoint')) {
            ctx.emit(e);
          }
          if (e.type === 'assistant_message' && e.message.content.trim()) report = e.message.content.trim();
          if (e.type === 'error') error = e.message;
        });
        const onAbort = () => child.abort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await child.send(String(args.prompt ?? ''), { id: this.turnId });
        } finally {
          ctx.signal.removeEventListener('abort', onAbort);
        }
        if (error && !report) return { output: `Subagent failed: ${error}`, isError: true };
        return { output: report || 'The subagent finished without a report.' };
      },
    };
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

/** Ends plan mode: the plan is shown to the user, who approves it (switching mode) or asks for changes. */
const proposePlanTool: Tool = {
  name: PROPOSE_PLAN,
  kind: 'meta',
  description:
    'Plan mode only: present your implementation plan to the user for approval once you have explored enough. On approval you can start making changes.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in Markdown: what you will change, where, and how you will verify it.' } },
    required: ['plan'],
  },
  describe: () => 'Proposed plan',
  run: async () => ({ output: 'Not in plan mode; continue with the task.' }),
};

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
