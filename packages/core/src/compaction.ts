import type { OllamaClient } from './ollama.ts';
import type { Message } from './types.ts';

const COMPACT_PROMPT = `Your conversation is about to run out of context. Write a handoff summary so that you can continue the work with only this summary and the latest messages.

Include:
- The user's goal and any constraints or preferences they stated
- What has been done so far, with file paths and key decisions
- Important facts discovered (errors, commands that work, code locations)
- What remains to be done, as a short ordered list

Be concise and concrete. Output only the summary.`;

/** Rough token estimate for when Ollama hasn't reported a count yet (~4 chars per token). */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 8;
    for (const c of m.toolCalls ?? []) chars += JSON.stringify(c.arguments).length + c.name.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Replace older history with a model-written summary, keeping the system prompt
 * and the most recent messages. Never splits an assistant tool call from its results.
 */
export async function compact(
  client: OllamaClient,
  model: string,
  messages: Message[],
  opts: { keepRecent?: number; numCtx?: number; signal?: AbortSignal } = {},
): Promise<{ messages: Message[]; removed: number }> {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const body = system ? messages.slice(1) : messages;
  let cut = Math.max(0, body.length - (opts.keepRecent ?? 6));
  // Move the cut back until it lands on a user message, so tool results stay with their call.
  while (cut > 0 && body[cut]?.role !== 'user') cut--;
  if (cut <= 1) return { messages, removed: 0 };

  const older = body.slice(0, cut);
  let transcript = older
    .map((m) => {
      const calls = m.toolCalls?.map((c) => `\n[called ${c.name} ${JSON.stringify(c.arguments).slice(0, 500)}]`).join('') ?? '';
      const content = m.role === 'tool' ? m.content.slice(0, 2000) : m.content;
      return `### ${m.role}${m.toolName ? ` (${m.toolName})` : ''}\n${content}${calls}`;
    })
    .join('\n\n');
  // The summary request itself has to fit: keep the most recent part of the transcript.
  const maxChars = Math.floor((opts.numCtx ?? 8192) * 2.5);
  if (transcript.length > maxChars) transcript = `…\n${transcript.slice(-maxChars)}`;

  let summary = '';
  for await (const chunk of client.chat({
    model,
    numCtx: opts.numCtx,
    signal: opts.signal,
    messages: [
      { role: 'system', content: 'You summarize agent transcripts for handoff.' },
      { role: 'user', content: `${transcript}\n\n---\n\n${COMPACT_PROMPT}` },
    ],
  })) {
    summary += chunk.content;
  }

  const summaryMsg: Message = {
    role: 'user',
    summary: true,
    content: `[Context summary — earlier conversation was compacted]\n\n${summary.trim()}`,
  };
  return { messages: [...(system ? [system] : []), summaryMsg, ...body.slice(cut)], removed: older.length };
}
