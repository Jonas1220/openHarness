#!/usr/bin/env -S npx tsx
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import {
  Agent,
  McpManager,
  OllamaClient,
  PERMISSION_MODES,
  RoutingClient,
  createWorktree,
  SOURCE_LABELS,
  activeServers,
  discoverMcpServers,
  expandCommand,
  loadCommands,
  loadConfig,
  type PermissionMode,
} from '@openharness/core';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `Open Harness — agent harness for local models

Usage:
  openharness [options] [prompt]

Options:
  -m, --model <name>   Model: an Ollama name (qwen3:8b) or provider::model (lmstudio::qwen3-8b)
  -C, --cwd <dir>      Working directory (default: current directory)
      --mode <mode>    ${PERMISSION_MODES.map((m) => m.id).join(' | ')}
  -w, --worktree       Work in a new git worktree on its own branch
  -p, --print          Run the prompt once, print the answer, and exit
  -h, --help           Show this help

In the REPL: /mode <mode>, /plan, /model <name>, /compact, /rewind, /clear, /exit,
plus /init, /review and your custom commands (~/.openharness/commands/*.md).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      cwd: { type: 'string', short: 'C' },
      mode: { type: 'string' },
      worktree: { type: 'boolean', short: 'w' },
      print: { type: 'boolean', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);

  const config = await loadConfig();
  const ollama = new OllamaClient(config.ollamaHost);
  const client = new RoutingClient(ollama, config.providers);
  const model = values.model ?? config.defaultModel;
  if (!model.includes('::') && !(await ollama.version())) {
    console.error(c.red(`Ollama is not reachable at ${ollama.host}. Start it with \`ollama serve\`.`));
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  // Own MCP servers plus those configured in Claude Code, Codex and Claude Desktop.
  const mcp = new McpManager();
  let cwd = values.cwd ?? process.cwd();
  let writableRoots: string[] | undefined;
  if (values.worktree) {
    const wt = await createWorktree(cwd, positionals.join(' ').slice(0, 40) || undefined);
    console.log(c.dim(`worktree ${wt.path} on branch ${wt.branch}`));
    cwd = wt.cwd;
    writableRoots = [wt.gitDir];
  }
  const servers = activeServers(
    await discoverMcpServers({ own: config.mcpServers, sources: config.mcpImport, cwd }),
    config.mcpDisabled,
  );
  if (servers.length) {
    await mcp.ensure(servers);
    for (const s of servers) {
      const st = mcp.status(s.id);
      console.log(c.dim(`mcp ${s.name} (${SOURCE_LABELS[s.source]}): ${st?.status}${st?.error ? ` — ${st.error}` : ''}`));
    }
  }

  const agent = new Agent({
    client,
    model,
    writableRoots,
    cwd,
    mode: (values.mode as PermissionMode) ?? (values.print ? 'read-only' : config.mode),
    maxContext: config.maxContext,
    think: config.think,
    hooks: config.hooks,
    toolSearch: config.toolSearch,
    extraTools: mcp.getTools(),
    approve: async (req) => {
      if (values.print) return { kind: 'deny', feedback: 'Non-interactive mode: approvals are not available.' };
      if (req.toolName === 'propose_plan') console.log(`\n${String(req.args.plan ?? '')}\n`);
      const answer = (await rl.question(c.yellow(`\n? ${req.reason}: ${req.summary}\n  [y]es / [a]lways this session / [n]o (or type feedback) › `))).trim();
      if (/^y(es)?$/i.test(answer)) return { kind: 'allow' };
      if (/^a(lways)?$/i.test(answer)) return { kind: 'allow-session' };
      return { kind: 'deny', feedback: /^n(o)?$/i.test(answer) || !answer ? undefined : answer };
    },
  });

  let inThinking = false;
  agent.on((e) => {
    switch (e.type) {
      case 'thinking_delta':
        if (!inThinking) stdout.write(c.dim('\nthinking… '));
        inThinking = true;
        stdout.write(c.dim(e.text));
        break;
      case 'assistant_delta':
        if (inThinking) stdout.write('\n\n');
        inThinking = false;
        stdout.write(e.text);
        break;
      case 'tool_call':
        stdout.write(`\n${c.cyan('●')} ${e.summary}\n`);
        break;
      case 'tool_result': {
        const first = e.result.output.split('\n').slice(0, 4).join('\n  ');
        stdout.write(c.dim(`  ${first}${e.result.output.split('\n').length > 4 ? '\n  …' : ''}\n`));
        break;
      }
      case 'todos':
        for (const t of e.todos) stdout.write(c.dim(`  ${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'} ${t.content}\n`));
        break;
      case 'compacted':
        stdout.write(c.dim(`\n[context compacted: ${e.removedMessages} messages summarized]\n`));
        break;
      case 'error':
        stdout.write(c.red(`\nError: ${e.message}\n`));
        break;
      case 'turn_end':
        stdout.write('\n');
        break;
    }
  });

  process.on('SIGINT', () => {
    if (agent.running) agent.abort();
    else process.exit(0);
  });

  const initial = positionals.join(' ').trim();
  if (values.print) {
    if (!initial) throw new Error('--print needs a prompt');
    await agent.send(initial);
    rl.close();
    await mcp.close();
    return;
  }

  console.log(c.bold('Open Harness') + c.dim(` · ${agent.model} · ${agent.permissions.mode} · ${agent.cwd}`));
  console.log(c.dim('Type /help for commands. Ctrl+C interrupts.\n'));
  let next = initial;
  while (true) {
    if (!next) next = (await rl.question(c.bold('› '))).trim();
    if (!next) continue;
    if (next.startsWith('/')) {
      const [cmd, ...rest] = next.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'exit' || cmd === 'quit') break;
      else if (cmd === 'help') console.log(HELP);
      else if (cmd === 'mode' && PERMISSION_MODES.some((m) => m.id === arg)) agent.setMode(arg as PermissionMode);
      else if (cmd === 'model' && arg) agent.setModel(arg);
      else if (cmd === 'clear') agent.reset();
      else if (cmd === 'compact') console.log(c.dim(`compacted ${await agent.compactNow()} messages`));
      else if (cmd === 'plan') {
        agent.setMode('plan');
        console.log(c.dim('plan mode: the agent explores and proposes a plan before changing anything'));
        if (arg) {
          next = arg;
          await agent.send(next);
        }
      } else if (cmd === 'rewind') {
        const last = [...agent.messages].reverse().find((m) => m.role === 'user' && m.id);
        if (last?.id) console.log(c.dim(`rewound; restored ${(await agent.rewind(last.id)).length} file(s)`));
      } else {
        const custom = (await loadCommands(agent.cwd)).find((x) => x.name === cmd && x.body);
        if (custom) await agent.send(expandCommand(custom, arg));
        else console.log(c.red(`Unknown command: ${next}`));
      }
      next = '';
      continue;
    }
    await agent.send(next);
    next = '';
  }
  rl.close();
  await mcp.close();
}

main().catch((err) => {
  console.error(c.red((err as Error).message));
  process.exit(1);
});
