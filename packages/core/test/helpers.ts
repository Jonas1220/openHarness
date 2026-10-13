import type { ChatRequest } from '../src/ollama.ts';
import type { ToolCall } from '../src/types.ts';

export * from '../src/index.ts';

export interface ChatChunkLike {
  content?: string;
  toolCalls?: Omit<ToolCall, 'id'>[];
}

/** Scripted stand-in for OllamaClient: each chat() call plays the next response. */
export class FakeOllama {
  requests: ChatRequest[] = [];
  private i = 0;

  constructor(
    private script: ChatChunkLike[][],
    private capabilities: string[] = ['completion', 'tools'],
  ) {}

  async showModel() {
    return { capabilities: this.capabilities, contextLength: 8192 };
  }

  async *chat(req: ChatRequest) {
    this.requests.push(req);
    const chunks = this.script[this.i++] ?? [{ content: '(script exhausted)' }];
    for (const [n, c] of chunks.entries()) {
      yield {
        content: c.content ?? '',
        thinking: '',
        toolCalls: (c.toolCalls ?? []).map((t, k) => ({ ...t, id: `t${this.i}_${k}` })),
        done: n === chunks.length - 1,
        promptTokens: 100,
        completionTokens: 10,
      };
    }
  }
}
