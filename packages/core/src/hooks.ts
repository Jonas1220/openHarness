import { exec } from './tools/shell.ts';

/**
 * Lifecycle hooks: shell commands that run before/after tool calls, when a prompt is
 * submitted, and when the agent is about to stop. The format follows Claude Code's hooks
 * (settings.json "hooks"), so existing hook scripts work:
 *
 *   "hooks": {
 *     "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }] }]
 *   }
 *
 * A hook gets a JSON description of the event on stdin. Exit code 0 = OK (stdout may be JSON
 * with a decision), exit code 2 = block, with stderr sent back to the model as the reason.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';
export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

export interface HookCommand {
  type?: 'command';
  command: string;
  /** Seconds (default 60). */
  timeout?: number;
}

export interface HookMatcher {
  /** Regex matched against the tool name (ours or Claude Code's); empty or "*" matches all. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookOutcome {
  /** A hook blocked the action (exit code 2 or decision "block"/"deny"). */
  block: boolean;
  reason?: string;
  /** PreToolUse permission decision. */
  decision?: 'allow' | 'deny' | 'ask';
  /** Extra context to give the model. */
  context?: string;
  /** Non-blocking errors from hooks that failed. */
  errors: string[];
}

/** Claude Code tool names, so matchers written for Claude Code work unchanged. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  edit_file: 'Edit',
  write_file: 'Write',
  read_file: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  list_dir: 'LS',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  task: 'Task',
};

export interface HookPayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: { output: string; isError?: boolean };
  prompt?: string;
}

export class HookRunner {
  constructor(
    private config: HooksConfig,
    private base: { sessionId: string; cwd: string },
  ) {}

  has(event: HookEvent): boolean {
    return (this.config[event]?.length ?? 0) > 0;
  }

  async run(event: HookEvent, payload: HookPayload, signal?: AbortSignal): Promise<HookOutcome> {
    const outcome: HookOutcome = { block: false, errors: [] };
    const commands = this.matching(event, payload.toolName);
    if (!commands.length) return outcome;

    const claudeName = payload.toolName ? (CLAUDE_TOOL_NAMES[payload.toolName] ?? payload.toolName) : undefined;
    const input = JSON.stringify({
      session_id: this.base.sessionId,
      cwd: this.base.cwd,
      hook_event_name: event,
      ...(claudeName ? { tool_name: claudeName } : {}),
      ...(payload.toolInput ? { tool_input: claudeStyleInput(payload.toolInput) } : {}),
      ...(payload.toolResponse ? { tool_response: payload.toolResponse } : {}),
      ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
    });

    const contexts: string[] = [];
    const reasons: string[] = [];
    for (const hook of commands) {
      let res;
      try {
        res = await exec(['/bin/zsh', '-c', hook.command], {
          cwd: this.base.cwd,
          timeoutMs: (hook.timeout ?? 60) * 1000,
          signal,
          input,
          env: { OPENHARNESS_PROJECT_DIR: this.base.cwd, CLAUDE_PROJECT_DIR: this.base.cwd },
        });
      } catch (err) {
        outcome.errors.push(`${hook.command}: ${(err as Error).message}`);
        continue;
      }
      if (res.code === 2) {
        outcome.block = true;
        reasons.push(res.stderr.trim() || `Blocked by hook: ${hook.command}`);
        continue;
      }
      if (res.code !== 0) {
        outcome.errors.push(`${hook.command} exited with ${res.timedOut ? 'a timeout' : res.code}: ${res.stderr.trim().slice(0, 500)}`);
        continue;
      }
      const out = res.stdout.trim();
      const json = out.startsWith('{') ? safeJson(out) : null;
      if (json) {
        const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
        const decision = specific.permissionDecision ?? json.decision;
        const reason = String(specific.permissionDecisionReason ?? json.reason ?? '');
        if (decision === 'block' || decision === 'deny') {
          outcome.block = true;
          if (event === 'PreToolUse') outcome.decision = 'deny';
          if (reason) reasons.push(reason);
        } else if (decision === 'ask' && outcome.decision !== 'deny') {
          outcome.decision = 'ask';
        } else if ((decision === 'allow' || decision === 'approve') && !outcome.decision) {
          outcome.decision = 'allow';
        }
        if (typeof specific.additionalContext === 'string') contexts.push(specific.additionalContext);
      } else if (out && event === 'UserPromptSubmit') {
        contexts.push(out);
      }
    }
    if (reasons.length) outcome.reason = reasons.join('\n');
    if (contexts.length) outcome.context = contexts.join('\n');
    return outcome;
  }

  private matching(event: HookEvent, toolName?: string): HookCommand[] {
    const names = toolName ? [toolName, CLAUDE_TOOL_NAMES[toolName]].filter(Boolean) as string[] : [];
    const out: HookCommand[] = [];
    for (const m of this.config[event] ?? []) {
      const pattern = (m.matcher ?? '').trim();
      const isToolEvent = event === 'PreToolUse' || event === 'PostToolUse';
      let ok = !isToolEvent || !pattern || pattern === '*';
      if (!ok) {
        try {
          const re = new RegExp(`^(?:${pattern})$`);
          ok = names.some((n) => re.test(n));
        } catch {
          ok = names.includes(pattern);
        }
      }
      if (ok) out.push(...(m.hooks ?? []).filter((h) => typeof h.command === 'string' && h.command.trim()));
    }
    return out;
  }
}

/** Add Claude Code's field names (file_path) next to ours (path) so existing scripts can read them. */
function claudeStyleInput(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.path === 'string' && input.file_path === undefined ? { ...input, file_path: input.path } : input;
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
