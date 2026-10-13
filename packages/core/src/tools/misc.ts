import type { Todo, Tool } from '../types.ts';
import { str, truncate } from './util.ts';

export const todoWrite: Tool = {
  name: 'todo_write',
  kind: 'meta',
  description:
    'Create or update your task checklist for multi-step work. Send the full list every time. Keep exactly one item in_progress while working, and mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  describe: () => 'Update task list',
  async run(args, ctx) {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const todos: Todo[] = raw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        content: String(t.content ?? ''),
        status: (['pending', 'in_progress', 'completed'].includes(String(t.status)) ? t.status : 'pending') as Todo['status'],
      }));
    ctx.state.set('todos', todos);
    ctx.emit({ type: 'todos', todos });
    const done = todos.filter((t) => t.status === 'completed').length;
    return { output: `Task list updated (${done}/${todos.length} completed).` };
  },
};

export const webFetch: Tool = {
  name: 'web_fetch',
  kind: 'network',
  description: 'Fetch a URL over HTTP(S) and return its content as plain text (HTML is converted to text).',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
    required: ['url'],
  },
  describe: (a) => `Fetch ${a.url}`,
  async run(args, ctx) {
    const url = new URL(str(args, 'url'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { output: 'Only http(s) URLs are supported.', isError: true };
    const res = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      headers: { 'user-agent': 'openHarness/0.1 (+https://github.com/Jonas1220/openHarness)' },
    });
    const type = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (type.includes('html')) body = htmlToText(body);
    return { output: `HTTP ${res.status} ${type}\n\n${truncate(body, 20_000)}`, isError: !res.ok };
  },
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
