import type { AgentEvent, ApprovalDecision, Message } from '../../shared/ipc';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      args: Record<string, unknown>;
      status: 'running' | 'awaiting' | 'done' | 'error' | 'denied';
      output?: string;
      reason?: string;
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' };

let seq = 0;
const uid = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Rebuild the chat view from a saved transcript. */
export function itemsFromMessages(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      items.push(
        m.summary
          ? { kind: 'notice', id: uid(), text: 'Earlier messages were summarized to save context.', tone: 'info' }
          : { kind: 'user', id: uid(), text: m.content },
      );
    } else if (m.role === 'assistant') {
      if (m.content || m.thinking) items.push({ kind: 'assistant', id: uid(), text: m.content, thinking: m.thinking ?? '', streaming: false });
      for (const c of m.toolCalls ?? []) {
        items.push({ kind: 'tool', id: c.id, name: c.name, summary: summarize(c.name, c.arguments), args: c.arguments, status: 'done' });
      }
    } else if (m.role === 'tool') {
      const t = items.find((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.id === m.toolCallId);
      if (t) {
        t.output = m.content;
        if (m.content.startsWith('User denied')) t.status = 'denied';
        else if (m.content.startsWith('Error')) t.status = 'error';
      }
    }
  }
  return items;
}

function summarize(name: string, args: Record<string, unknown>): string {
  if (name === 'bash') return `$ ${args.command}`;
  if (typeof args.path === 'string') return `${name.replace(/_/g, ' ')} ${args.path}`;
  if (typeof args.pattern === 'string') return `${name} ${args.pattern}`;
  if (typeof args.url === 'string') return `fetch ${args.url}`;
  return name;
}

/** Apply one streamed agent event to the chat view. */
export function applyEvent(items: ChatItem[], e: AgentEvent): ChatItem[] {
  const last = items[items.length - 1];
  const streaming = last?.kind === 'assistant' && last.streaming ? last : null;
  const replaceLast = (item: ChatItem) => [...items.slice(0, -1), item];

  switch (e.type) {
    case 'assistant_delta':
      return streaming
        ? replaceLast({ ...streaming, text: streaming.text + e.text })
        : [...items, { kind: 'assistant', id: uid(), text: e.text, thinking: '', streaming: true }];
    case 'thinking_delta':
      return streaming
        ? replaceLast({ ...streaming, thinking: streaming.thinking + e.text })
        : [...items, { kind: 'assistant', id: uid(), text: '', thinking: e.text, streaming: true }];
    case 'assistant_message': {
      const { content, thinking } = e.message;
      if (streaming) {
        if (!content && !streaming.thinking) return items.slice(0, -1);
        return replaceLast({ ...streaming, text: content, streaming: false });
      }
      if (!content && !thinking) return items;
      return [...items, { kind: 'assistant', id: uid(), text: content, thinking: thinking ?? '', streaming: false }];
    }
    case 'tool_call':
      return [...items, { kind: 'tool', id: e.call.id, name: e.call.name, summary: e.summary, args: e.call.arguments, status: 'running' }];
    case 'approval_request':
      return updateTool(items, e.request.id, { status: 'awaiting', reason: e.request.reason });
    case 'approval_resolved':
      return updateTool(items, e.requestId, { status: decisionStatus(e.decision) });
    case 'tool_result': {
      const denied = e.result.output.startsWith('User denied');
      return updateTool(items, e.callId, { status: denied ? 'denied' : e.result.isError ? 'error' : 'done', output: e.result.output });
    }
    case 'compacted':
      return [...items, { kind: 'notice', id: uid(), text: `Context compacted — ${e.removedMessages} earlier messages summarized.`, tone: 'info' }];
    case 'error':
      return [...items, { kind: 'notice', id: uid(), text: e.message, tone: 'error' }];
    case 'turn_end': {
      const settled = items.map((i) =>
        i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i.kind === 'tool' && (i.status === 'running' || i.status === 'awaiting') ? { ...i, status: 'error' as const, output: i.output ?? 'Interrupted.' } : i,
      );
      if (e.reason === 'aborted') return [...settled, { kind: 'notice', id: uid(), text: 'Stopped.', tone: 'info' }];
      if (e.reason === 'max_steps') return [...settled, { kind: 'notice', id: uid(), text: 'Stopped after the maximum number of steps. Send a message to continue.', tone: 'info' }];
      return settled;
    }
    default:
      return items;
  }
}

function decisionStatus(d: ApprovalDecision): 'running' | 'denied' {
  return d.kind === 'deny' ? 'denied' : 'running';
}

function updateTool(items: ChatItem[], id: string, patch: Partial<Extract<ChatItem, { kind: 'tool' }>>): ChatItem[] {
  return items.map((i) => (i.kind === 'tool' && i.id === id ? { ...i, ...patch } : i));
}

export const newUserItem = (text: string): ChatItem => ({ kind: 'user', id: uid(), text });
