import { newCallId } from './ollama.ts';
import type { Tool, ToolCall } from './types.ts';

/**
 * Many open models — or any model whose Ollama template has no tool support —
 * print tool calls as text instead of using the structured `tool_calls` field.
 * This recovers them from the common formats:
 *
 *   <tool_call>{"name": "read_file", "arguments": {...}}</tool_call>   (Hermes / Qwen)
 *   ```json\n{"name": "read_file", "arguments": {...}}\n```            (fenced JSON)
 *   {"name": "read_file", "parameters": {...}}                         (bare JSON, Llama style)
 *
 * Only names of known tools are accepted, so ordinary JSON in an answer is left alone.
 */
export function extractTextToolCalls(text: string, tools: Pick<Tool, 'name'>[]): { calls: ToolCall[]; text: string } {
  const known = new Set(tools.map((t) => t.name));
  const calls: ToolCall[] = [];
  let remaining = text;

  const take = (raw: string): boolean => {
    for (const obj of parseJsonObjects(raw)) {
      const call = toCall(obj, known);
      if (!call) return false;
      calls.push(call);
    }
    return calls.length > 0;
  };

  remaining = remaining.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (m, body: string) => (take(body) ? '' : m));
  remaining = remaining.replace(/```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n?```/g, (m, body: string) => (take(body) ? '' : m));

  if (calls.length === 0) {
    const trimmed = remaining.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const before = calls.length;
      if (take(trimmed) && calls.length > before) remaining = '';
    }
  }

  return { calls, text: remaining.trim() };
}

function toCall(obj: unknown, known: Set<string>): ToolCall | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const fn = (o.function && typeof o.function === 'object' ? o.function : o) as Record<string, unknown>;
  const name = fn.name ?? fn.tool ?? fn.tool_name;
  if (typeof name !== 'string' || !known.has(name)) return null;
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { id: newCallId(), name, arguments: (args ?? {}) as Record<string, unknown> };
}

/** Parse one JSON value, an array of them, or several objects back to back. */
function parseJsonObjects(raw: string): unknown[] {
  const s = raw.trim();
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {
    /* fall through to scanning */
  }
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          return [];
        }
        start = -1;
      }
    }
  }
  return out;
}

/** System-prompt section that teaches a model without native tool support how to call tools. */
export function textToolPrompt(tools: Tool[]): string {
  const specs = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters.properties)}`)
    .join('\n');
  return `# Tools

You can call tools. To call one, reply with exactly one block like this and nothing after it:

<tool_call>
{"name": "<tool name>", "arguments": { ... }}
</tool_call>

The result will come back in the next message. Available tools:

${specs}`;
}
