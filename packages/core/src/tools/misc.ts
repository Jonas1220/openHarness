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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearch: Tool = {
  name: 'web_search',
  kind: 'network',
  description:
    'Search the web and return the top results (title, URL, snippet). Use web_fetch afterwards to read a result. Good for documentation, error messages, recent releases and facts you are unsure about.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      max_results: { type: 'number', description: 'Number of results (default 8, max 15).' },
    },
    required: ['query'],
  },
  describe: (a) => `Search the web: ${a.query}`,
  async run(args, ctx) {
    const query = str(args, 'query');
    const max = Math.min(Math.max(Number(args.max_results) || 8, 1), 15);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]);
    const results = process.env.BRAVE_API_KEY ? await braveSearch(query, signal) : await duckDuckGo(query, signal);
    if (!results.length) return { output: `No results for "${query}".` };
    return {
      output: results
        .slice(0, max)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
        .join('\n\n'),
    };
  },
};

/** DuckDuckGo's HTML endpoint needs no API key. */
async function duckDuckGo(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh) OpenHarness/0.1' },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text());
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = decodeEntities(link[1]!);
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]!);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    results.push({ title: htmlToText(link[2]!), url, snippet: htmlToText(snippet) });
  }
  return results;
}

/** Brave Search API, used when BRAVE_API_KEY is set. */
async function braveSearch(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=15`, {
    signal,
    headers: { accept: 'application/json', 'x-subscription-token': process.env.BRAVE_API_KEY! },
  });
  if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (body.web?.results ?? []).map((r) => ({ title: htmlToText(r.title), url: r.url, snippet: htmlToText(r.description ?? '') }));
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&quot;/g, '"');
}

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
