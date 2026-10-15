import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, OllamaClient, RoutingClient, createWorktree, parseModelRef, removeWorktree, worktreeStatus } from '../src/index.ts';
import { FakeOllama } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oh-next-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible provider, against a local fake server
// ---------------------------------------------------------------------------

describe('OpenAI-compatible providers', () => {
  let server: Server;
  let base: string;
  const requests: Record<string, unknown>[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'qwen3-8b', context_length: 40960 }] }));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          requests.push({ ...parsed, auth: req.headers.authorization });
          res.setHeader('content-type', 'text/event-stream');
          const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          const isFollowUp = (parsed.messages as { role: string }[]).some((m) => m.role === 'tool');
          if (!isFollowUp) {
            send({ choices: [{ delta: { reasoning_content: 'Let me check. ' } }] });
            // Tool call arguments arrive split across chunks, as real servers stream them.
            send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
            send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] });
          } else {
            send({ choices: [{ delta: { content: 'It says ' } }] });
            send({ choices: [{ delta: { content: 'hello.' } }] });
          }
          send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8 } });
          res.end('data: [DONE]\n\n');
          return;
        }
        res.statusCode = 404;
        res.end('{"error":{"message":"not found"}}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  it('parses model references', () => {
    expect(parseModelRef('qwen3:8b')).toEqual({ provider: null, model: 'qwen3:8b' });
    expect(parseModelRef('openrouter::anthropic/claude-sonnet')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet' });
  });

  it('lists models, routes by prefix, streams thinking and split tool calls', async () => {
    process.env.OH_TEST_KEY = 'sk-test';
    const client = new RoutingClient(new OllamaClient('http://127.0.0.1:1'), [{ id: 'local', name: 'Local server', baseUrl: base, apiKey: 'env:OH_TEST_KEY' }]);
    const models = await client.listModels();
    expect(models).toEqual([{ name: 'local::qwen3-8b', size: 0, provider: 'Local server' }]);
    expect((await client.showModel('local::qwen3-8b')).contextLength).toBe(40960);

    await writeFile(path.join(dir, 'a.txt'), 'hello');
    const agent = new Agent({ client, model: 'local::qwen3-8b', cwd: dir, mode: 'ask', skills: false, memory: false, approve: async () => ({ kind: 'allow' }) });
    const events: string[] = [];
    agent.on((e) => {
      if (e.type === 'thinking_delta') events.push(`think:${e.text}`);
      if (e.type === 'usage') events.push(`usage:${e.usage.promptTokens}`);
    });
    await agent.send('what is in a.txt?');

    expect(agent.messages.find((m) => m.role === 'tool')!.content).toContain('hello');
    expect(agent.messages.at(-1)!.content).toBe('It says hello.');
    expect(events).toContain('think:Let me check. ');
    expect(events).toContain('usage:120');
    expect(requests[0]!.model).toBe('qwen3-8b');
    expect(requests[0]!.auth).toBe('Bearer sk-test');
    const second = requests[1]!.messages as { role: string; tool_call_id?: string; tool_calls?: unknown[] }[];
    expect(second.find((m) => m.role === 'assistant')!.tool_calls).toHaveLength(1);
    expect(second.find((m) => m.role === 'tool')!.tool_call_id).toBe('call_1');
  });

  it('reports unknown providers clearly', async () => {
    const client = new RoutingClient(new OllamaClient('http://127.0.0.1:1'), []);
    await expect(client.showModel('nope::x')).rejects.toThrow(/Unknown model provider "nope"/);
  });
});

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

describe('general subagents', () => {
  it('edit files with the parent approving, and their edits can be rewound with the parent turn', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'old');
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'task', arguments: { kind: 'general', description: 'update a', prompt: 'Write "new" to a.txt' } }] }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'new' } }] }], // child
      [{ content: 'Updated a.txt.' }], // child report
      [{ content: 'Done.' }],
    ]);
    const asked: string[] = [];
    const agent = new Agent({
      client: client as never,
      model: 'm',
      cwd: dir,
      mode: 'ask',
      skills: false,
      memory: false,
      approve: async (req) => (asked.push(req.summary), { kind: 'allow' }),
    });
    const seen: string[] = [];
    agent.on((e) => e.type === 'tool_call' && seen.push(e.summary));
    await agent.send('update a via subagent', { id: 'turn1' });

    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('new');
    expect(asked).toEqual(['[update a] Write a.txt']);
    expect(seen).toContain('↳ update a: Write a.txt');
    expect(agent.messages.find((m) => m.toolName === 'task')!.content).toBe('Updated a.txt.');

    await agent.rewind('turn1');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
  });

  it('stay read-only when the parent is in plan mode', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'task', arguments: { kind: 'general', prompt: 'write b.txt' } }] }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: 'x' } }] }],
      [{ content: 'Could not write.' }],
      [{ content: 'ok' }],
    ]);
    const agent = new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'plan', skills: false, memory: false, approve: async () => ({ kind: 'allow' }) });
    await agent.send('go');
    await expect(readFile(path.join(dir, 'b.txt'), 'utf8')).rejects.toThrow();
  });

  it('run in parallel when several are requested at once', async () => {
    let active = 0;
    let maxActive = 0;
    const slow = {
      async showModel() {
        return { capabilities: ['completion', 'tools'], contextLength: 8192 };
      },
      async *chat(req: { messages: { role: string; content: string }[] }) {
        const isChild = req.messages[0]!.content.includes('subagent');
        const hasToolResult = req.messages.some((m) => m.role === 'tool');
        if (isChild) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 100));
          active--;
          yield { content: 'report', thinking: '', toolCalls: [], done: true };
        } else if (!hasToolResult) {
          yield {
            content: '',
            thinking: '',
            toolCalls: [1, 2, 3].map((n) => ({ id: `t${n}`, name: 'task', arguments: { prompt: `research ${n}` } })),
            done: true,
          };
        } else {
          yield { content: 'all done', thinking: '', toolCalls: [], done: true };
        }
      },
    };
    const agent = new Agent({ client: slow as never, model: 'm', cwd: dir, mode: 'ask', skills: false, memory: false, approve: async () => ({ kind: 'allow' }) });
    await agent.send('research three things');
    expect(maxActive).toBe(3);
    expect(agent.messages.filter((m) => m.toolName === 'task').map((m) => m.toolCallId)).toEqual(['t1', 't2', 't3']);
  });
});

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

describe('worktrees', () => {
  it('creates an isolated checkout on its own branch and removes it again', async () => {
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    await writeFile(path.join(dir, 'f.txt'), 'one');
    g('add', '.');
    g('commit', '-q', '-m', 'init');

    const wt = await createWorktree(dir, 'Fix Login');
    expect(wt.branch).toMatch(/^oh\/fix-login-[0-9a-f]{6}$/);
    expect(wt.base).toBe('main');
    expect(await readFile(path.join(wt.cwd, 'f.txt'), 'utf8')).toBe('one');

    await writeFile(path.join(wt.cwd, 'f.txt'), 'two');
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('one'); // original untouched
    expect(await worktreeStatus(wt)).toEqual({ changedFiles: 1, commits: 0 });

    await removeWorktree(wt);
    expect(g('branch', '--list', wt.branch)).toContain(wt.branch); // branch kept
    await expect(readFile(path.join(wt.path, 'f.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses folders that are not git repositories', async () => {
    await expect(createWorktree(dir)).rejects.toThrow(/not inside a git repository/);
  });
});
