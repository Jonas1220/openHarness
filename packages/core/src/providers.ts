import { OllamaClient, OllamaError, newCallId, type ChatChunk, type ChatRequest, type ModelDetails, type ModelInfo } from './ollama.ts';
import type { Message, Tool, ToolCall } from './types.ts';

/** What the agent needs from a model backend. OllamaClient implements it natively. */
export interface ModelClient {
  listModels(): Promise<ModelInfo[]>;
  showModel(model: string): Promise<ModelDetails>;
  chat(req: ChatRequest): AsyncGenerator<ChatChunk>;
}

/** An OpenAI-compatible server: LM Studio, llama.cpp, vLLM, Jan, OpenRouter, … */
export interface ProviderConfig {
  /** Short id used in model references: `<id>::<model>`. */
  id: string;
  name: string;
  /** Base URL including /v1, e.g. http://localhost:1234/v1 */
  baseUrl: string;
  /** API key, or `env:VAR_NAME` to read it from the environment. */
  apiKey?: string;
  /** Context window to assume when the server doesn't report one (default 32768). */
  contextLength?: number;
}

export const PROVIDER_PRESETS: Omit<ProviderConfig, 'apiKey'>[] = [
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  { id: 'jan', name: 'Jan', baseUrl: 'http://localhost:1337/v1' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
];

/** Separates provider id and model name in a model reference. Ollama names never contain it. */
export const MODEL_SEPARATOR = '::';

export function parseModelRef(ref: string): { provider: string | null; model: string } {
  const i = ref.indexOf(MODEL_SEPARATOR);
  return i < 0 ? { provider: null, model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + MODEL_SEPARATOR.length) };
}

/** Client for the OpenAI chat-completions API with streaming and tool calls. */
export class OpenAICompatClient implements ModelClient {
  private contextLengths = new Map<string, number>();
  private toolSupport = new Map<string, boolean>();

  constructor(private cfg: ProviderConfig) {}

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const key = resolveKey(this.cfg.apiKey);
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      // OpenRouter uses these for attribution; other servers ignore them.
      'HTTP-Referer': 'https://github.com/Jonas1220/openHarness',
      'X-Title': 'Open Harness',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request('/models', undefined, 'GET', AbortSignal.timeout(5000));
    const body = (await res.json()) as {
      data?: { id: string; context_length?: number; max_context_length?: number; supported_parameters?: string[] }[];
    };
    const models = body.data ?? [];
    for (const m of models) {
      const ctx = m.context_length ?? m.max_context_length;
      if (ctx) this.contextLengths.set(m.id, ctx);
      if (m.supported_parameters) this.toolSupport.set(m.id, m.supported_parameters.includes('tools'));
    }
    await this.lmStudioContext().catch(() => {});
    return models.map((m) => ({ name: m.id, size: 0 }));
  }

  /** LM Studio reports each model's context length on its own REST endpoint. */
  private async lmStudioContext(): Promise<void> {
    const root = this.base.replace(/\/v1$/, '');
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { id: string; max_context_length?: number; loaded_context_length?: number }[] };
    for (const m of body.data ?? []) {
      const ctx = m.loaded_context_length ?? m.max_context_length;
      if (ctx) this.contextLengths.set(m.id, ctx);
    }
  }

  async showModel(model: string): Promise<ModelDetails> {
    if (!this.contextLengths.has(model)) await this.listModels().catch(() => []);
    const tools = this.toolSupport.get(model) ?? true;
    return {
      capabilities: ['completion', ...(tools ? ['tools'] : [])],
      contextLength: this.contextLengths.get(model) ?? this.cfg.contextLength ?? 32768,
    };
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) body.tools = req.tools.map(toOpenAITool);
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const res = await this.request('/chat/completions', body, 'POST', req.signal);
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    for await (const data of readSse(res, req.signal)) {
      if (data === '[DONE]') break;
      let obj: OpenAIChunk;
      try {
        obj = JSON.parse(data) as OpenAIChunk;
      } catch {
        continue;
      }
      if (obj.error) throw new OllamaError(500, obj.error.message ?? 'Provider error');
      if (obj.usage) {
        promptTokens = obj.usage.prompt_tokens;
        completionTokens = obj.usage.completion_tokens;
      }
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: tc.id ?? newCallId(), name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }
      const thinking = delta.reasoning_content ?? delta.reasoning ?? '';
      if (delta.content || thinking) {
        yield { content: delta.content ?? '', thinking, toolCalls: [], done: false };
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id, name: c.name, arguments: parseArgs(c.args) }));
    yield { content: '', thinking: '', toolCalls, done: true, promptTokens, completionTokens };
  }

  private async request(path: string, body: unknown, method: string, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') throw err;
      throw new Error(`Cannot reach ${this.cfg.name} at ${this.base}. Is it running? (${(err as Error).message})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
      } catch {
        /* not JSON */
      }
      throw new OllamaError(res.status, `${this.cfg.name}: ${message || res.statusText}`);
    }
    return res;
  }
}

/**
 * Routes each request to the right backend by model reference: plain names go to Ollama,
 * `<provider>::<model>` goes to that OpenAI-compatible provider.
 */
export class RoutingClient implements ModelClient {
  readonly providers = new Map<string, OpenAICompatClient>();
  /** Errors from the last listModels(), per provider id. */
  providerErrors = new Map<string, string>();

  constructor(
    readonly ollama: OllamaClient,
    private configs: ProviderConfig[] = [],
  ) {
    for (const c of configs) this.providers.set(c.id, new OpenAICompatClient(c));
  }

  private route(ref: string): { client: ModelClient; model: string } {
    const { provider, model } = parseModelRef(ref);
    if (!provider) return { client: this.ollama, model };
    const client = this.providers.get(provider);
    if (!client) throw new Error(`Unknown model provider "${provider}". Add it in Settings → Model providers.`);
    return { client, model };
  }

  async listModels(): Promise<ModelInfo[]> {
    this.providerErrors.clear();
    const lists = await Promise.all([
      this.ollama.listModels().catch(() => [] as ModelInfo[]),
      ...this.configs.map(async (c) => {
        try {
          const models = await this.providers.get(c.id)!.listModels();
          return models.map((m) => ({ ...m, name: `${c.id}${MODEL_SEPARATOR}${m.name}`, provider: c.name }));
        } catch (err) {
          this.providerErrors.set(c.id, (err as Error).message);
          return [];
        }
      }),
    ]);
    return lists.flat();
  }

  async showModel(ref: string): Promise<ModelDetails> {
    const { client, model } = this.route(ref);
    return client.showModel(model);
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const { client, model } = this.route(req.model);
    yield* client.chat({ ...req, model });
  }
}

function resolveKey(key?: string): string | undefined {
  if (!key) return undefined;
  return key.startsWith('env:') ? process.env[key.slice(4)] : key;
}

function parseArgs(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content || (m.toolCalls?.length ? null : ''),
      ...(m.toolCalls?.length
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
        : {}),
    };
  }
  if (m.role === 'user' && m.images?.length) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

function toOpenAITool(t: Tool) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
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
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
