import type { Message, Tool, ToolCall } from './types.ts';

export interface ModelInfo {
  name: string;
  size: number;
  parameterSize?: string;
  family?: string;
  modifiedAt?: string;
}

export interface ModelDetails {
  capabilities: string[];
  contextLength?: number;
}

export interface ChatChunk {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  done: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  think?: boolean;
  numCtx?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

let callCounter = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;

/** Minimal client for Ollama's native HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md). */
export class OllamaClient {
  readonly host: string;

  constructor(host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434') {
    this.host = host.startsWith('http') ? host.replace(/\/$/, '') : `http://${host}`;
  }

  async version(): Promise<string | null> {
    try {
      const res = await fetch(`${this.host}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      return ((await res.json()) as { version: string }).version;
    } catch {
      return null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request('/api/tags', undefined, 'GET');
    const body = (await res.json()) as {
      models: { name: string; size: number; modified_at?: string; details?: { parameter_size?: string; family?: string } }[];
    };
    return body.models.map((m) => ({
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size,
      family: m.details?.family,
      modifiedAt: m.modified_at,
    }));
  }

  async showModel(model: string): Promise<ModelDetails> {
    const res = await this.request('/api/show', { model });
    const body = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
    const info = body.model_info ?? {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    return {
      capabilities: body.capabilities ?? [],
      contextLength: ctxKey ? Number(info[ctxKey]) : undefined,
    };
  }

  async *pull(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
    const res = await this.request('/api/pull', { model, stream: true }, 'POST', signal);
    for await (const line of readLines(res, signal)) {
      const obj = JSON.parse(line) as PullProgress & { error?: string };
      if (obj.error) throw new Error(obj.error);
      yield obj;
    }
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      options: {
        ...(req.numCtx ? { num_ctx: req.numCtx } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };
    if (req.tools?.length) body.tools = req.tools.map(toOllamaTool);
    if (req.think !== undefined) body.think = req.think;

    const res = await this.request('/api/chat', body, 'POST', req.signal);
    for await (const line of readLines(res, req.signal)) {
      const obj = JSON.parse(line) as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
        };
        done: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      if (obj.error) throw new Error(obj.error);
      yield {
        content: obj.message?.content ?? '',
        thinking: obj.message?.thinking ?? '',
        toolCalls: (obj.message?.tool_calls ?? []).map((c) => ({
          id: newCallId(),
          name: c.function.name,
          arguments: typeof c.function.arguments === 'string' ? safeParse(c.function.arguments) : c.function.arguments,
        })),
        done: obj.done,
        promptTokens: obj.prompt_eval_count,
        completionTokens: obj.eval_count,
      };
    }
  }

  private async request(path: string, body?: unknown, method = 'POST', signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.host}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new Error(`Cannot reach Ollama at ${this.host}. Is it running? (${(err as Error).message})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* not JSON */
      }
      throw new OllamaError(res.status, message || res.statusText);
    }
    return res;
  }
}

export class OllamaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OllamaError';
  }

  get toolsUnsupported(): boolean {
    return /does not support tools/i.test(this.message);
  }
}

function toOllamaMessage(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.images?.length) out.images = m.images;
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
  }
  if (m.role === 'tool' && m.toolName) out.tool_name = m.toolName;
  return out;
}

function toOllamaTool(t: Tool) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    reader.releaseLock();
  }
}
