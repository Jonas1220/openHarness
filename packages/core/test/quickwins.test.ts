import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  SessionStore,
  memoryFile,
  parseDuckDuckGo,
  rankTools,
  readMemory,
  sessionToMarkdown,
  type HooksConfig,
  type Tool,
} from '../src/index.ts';
import { FakeOllama } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oh-qw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(memoryFile('project', dir), { force: true });
});

const agent = (client: FakeOllama, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'auto-edit', skills: false, approve: async () => ({ kind: 'allow' }), ...extra });

describe('hooks', () => {
  it('PreToolUse exit code 2 blocks the call and tells the model why', async () => {
    const hooks: HooksConfig = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo "no rm allowed" >&2; exit 2' }] }] };
    const client = new FakeOllama([[{ toolCalls: [{ name: 'bash', arguments: { command: 'rm x' } }] }], [{ content: 'ok' }]]);
    const a = agent(client, { hooks, mode: 'full-auto' });
    await a.send('delete x');
    expect(a.messages.find((m) => m.role === 'tool')!.content).toBe('Blocked by a PreToolUse hook: no rm allowed');
  });

  it('PreToolUse can approve a call that would otherwise ask, using tool_input on stdin', async () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ command: `grep -q '"file_path":"${dir}' && echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }],
        },
      ],
    };
    let asked = 0;
    const client = new FakeOllama([[{ toolCalls: [{ name: 'write_file', arguments: { path: path.join(dir, 'a.txt'), content: 'hi' } }] }], [{ content: 'done' }]]);
    const a = agent(client, { hooks, mode: 'ask', approve: async () => (asked++, { kind: 'deny' }) });
    await a.send('write');
    expect(asked).toBe(0);
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('PostToolUse feedback is appended to the tool result', async () => {
    const hooks: HooksConfig = { PostToolUse: [{ matcher: 'write_file', hooks: [{ command: 'echo "lint: missing semicolon" >&2; exit 2' }] }] };
    const client = new FakeOllama([[{ toolCalls: [{ name: 'write_file', arguments: { path: 'b.ts', content: 'x' } }] }], [{ content: 'done' }]]);
    const a = agent(client, { hooks });
    await a.send('write');
    expect(a.messages.find((m) => m.role === 'tool')!.content).toContain('[PostToolUse hook] lint: missing semicolon');
  });

  it('a Stop hook can send the agent back to work, but only a few times', async () => {
    const hooks: HooksConfig = { Stop: [{ hooks: [{ command: 'echo "tests still fail" >&2; exit 2' }] }] };
    const client = new FakeOllama([[{ content: 'done 1' }], [{ content: 'done 2' }], [{ content: 'done 3' }], [{ content: 'done 4' }], [{ content: 'never' }]]);
    const a = agent(client, { hooks });
    const notices: string[] = [];
    a.on((e) => e.type === 'hook' && notices.push(e.message));
    await a.send('go');
    expect(client.requests).toHaveLength(4);
    expect(a.messages.filter((m) => m.content === '[Stop hook] tests still fail')).toHaveLength(3);
    expect(notices).toHaveLength(3);
  });

  it('UserPromptSubmit can add context or block the prompt', async () => {
    const add: HooksConfig = { UserPromptSubmit: [{ hooks: [{ command: 'echo "Today is release day."' }] }] };
    const client = new FakeOllama([[{ content: 'ok' }]]);
    const a = agent(client, { hooks: add });
    await a.send('hi');
    expect(a.messages.find((m) => m.role === 'user')!.content).toContain('<hook_context>\nToday is release day.');

    const block: HooksConfig = { UserPromptSubmit: [{ hooks: [{ command: 'echo "contains a secret" >&2; exit 2' }] }] };
    const c2 = new FakeOllama([[{ content: 'never' }]]);
    const b = agent(c2, { hooks: block });
    await b.send('my password is hunter2');
    expect(c2.requests).toHaveLength(0);
    expect(b.messages.some((m) => m.content.includes('hunter2'))).toBe(false);
  });
});

describe('auto memory', () => {
  it('remembers and forgets facts per project and shows them in the next chat', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'remember', arguments: { fact: 'Run tests with pnpm test' } }] }],
      [{ toolCalls: [{ name: 'remember', arguments: { fact: 'Run tests with pnpm test' } }] }],
      [{ content: 'noted' }],
    ]);
    const a = agent(client);
    await a.send('we use pnpm');
    expect(await readMemory('project', dir)).toBe('- Run tests with pnpm test\n');
    expect(a.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['Saved to project memory.', 'Already in memory.']);

    const next = new FakeOllama([[{ toolCalls: [{ name: 'forget', arguments: { text: 'pnpm' } }] }], [{ content: 'ok' }]]);
    const b = agent(next);
    await b.send('we switched to npm');
    expect(next.requests[0]!.messages[0]!.content).toContain('## About this project\n- Run tests with pnpm test');
    expect(await readMemory('project', dir)).toBe('');
  });

  it('is off for daemons and subagents', async () => {
    const client = new FakeOllama([[{ content: 'ok' }]]);
    const a = agent(client, { memory: false });
    await a.send('hi');
    expect(client.requests[0]!.tools!.some((t) => t.name === 'remember')).toBe(false);
  });
});

describe('tool search', () => {
  const mcpTool = (name: string, description: string): Tool => ({
    name: `mcp__srv__${name}`,
    description,
    kind: 'read',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ output: `ran ${name}` }),
  });
  const many = Array.from({ length: 12 }, (_, i) => mcpTool(`tool_${i}`, `generic tool number ${i}`)).concat(
    mcpTool('create_issue', 'Create a GitHub issue in a repository'),
  );

  it('hides MCP tools until search_tools loads them', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'search_tools', arguments: { query: 'github issue' } }] }],
      [{ toolCalls: [{ name: 'mcp__srv__create_issue', arguments: {} }] }],
      [{ content: 'filed' }],
    ]);
    const a = agent(client, { extraTools: many });
    await a.send('file an issue');
    const first = client.requests[0]!.tools!.map((t) => t.name);
    expect(first).toContain('search_tools');
    expect(first.some((n) => n.startsWith('mcp__'))).toBe(false);
    expect(client.requests[0]!.messages[0]!.content).toContain('13 more tools from MCP servers (srv)');
    expect(client.requests[1]!.tools!.map((t) => t.name)).toContain('mcp__srv__create_issue');
    expect(a.messages.filter((m) => m.role === 'tool').at(-1)!.content).toBe('ran create_issue');
  });

  it('sends all tools directly when there are only a few, or when turned off', async () => {
    const client = new FakeOllama([[{ content: 'ok' }]]);
    await agent(client, { extraTools: many.slice(0, 3) }).send('hi');
    const names = client.requests[0]!.tools!.map((t) => t.name);
    expect(names).toContain('mcp__srv__tool_0');
    expect(names).not.toContain('search_tools');

    const c2 = new FakeOllama([[{ content: 'ok' }]]);
    await agent(c2, { extraTools: many, toolSearch: 'off' }).send('hi');
    expect(c2.requests[0]!.tools!.filter((t) => t.name.startsWith('mcp__'))).toHaveLength(13);
  });

  it('ranks by name before description', () => {
    expect(rankTools(many, 'create issue')[0]!.name).toBe('mcp__srv__create_issue');
    expect(rankTools(many, 'zzz')).toEqual([]);
  });
});

describe('web search', () => {
  it('parses DuckDuckGo results and unwraps redirect links', () => {
    const html = `
      <div class="result results_links web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.ollama.com%2Ftools&amp;rut=x">Tool <b>calling</b></a>
      <a class="result__snippet" href="#">Ollama supports &amp; tool calling.</a></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: 'Tool calling', url: 'https://docs.ollama.com/tools', snippet: 'Ollama supports & tool calling.' }]);
  });
});

describe('fork and export', () => {
  it('copies a chat without its checkpoints and renders Markdown', async () => {
    const store = new SessionStore(path.join(dir, 'sessions'));
    const s = store.create({ cwd: dir, model: 'm', mode: 'ask', title: 'Fix login' });
    s.messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', id: 'u1', content: 'fix it\n\n<attached_files>\n<file path="a">secret</file>\n</attached_files>' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', content: 'code', toolCallId: 'c', toolName: 'read_file' },
      { role: 'assistant', content: 'Fixed.' },
    ];
    s.checkpoints = [{ messageId: 'u1', files: {}, createdAt: '' }];
    await store.save(s);
    const fork = (await store.fork(s.id))!;
    expect(fork.id).not.toBe(s.id);
    expect(fork.title).toBe('Fix login (fork)');
    expect(fork.messages).toHaveLength(5);
    expect(fork.checkpoints).toBeUndefined();

    const md = sessionToMarkdown(s);
    expect(md).toContain('# Fix login');
    expect(md).toContain('## You\n\nfix it');
    expect(md).not.toContain('secret');
    expect(md).toContain('🔧 `read_file`');
    expect(md).toContain('## Assistant\n\nFixed.');
  });
});

export {};
