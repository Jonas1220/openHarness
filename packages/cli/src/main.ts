#!/usr/bin/env -S npx tsx
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { Agent, McpManager, OllamaClient, PERMISSION_MODES, loadConfig, type PermissionMode } from '@openharness/core';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `openharness — agent harness for local models

Usage:
  openharness [options] [prompt]

Options:
  -m, --model <name>   Ollama model (default from ~/.openharness/config.json)
  -C, --cwd <dir>      Working directory (default: current directory)
      --mode <mode>    ${PERMISSION_MODES.map((m) => m.id).join(' | ')}
  -p, --print          Run the prompt once, print the answer, and exit
  -h, --help           Show this help

In the REPL: /mode <mode>, /model <name>, /compact, /clear, /exit`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      cwd: { type: 'string', short: 'C' },
      mode: { type: 'string' },
      print: { type: 'boolean', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);

  const config = await loadConfig();
  const client = new OllamaClient(config.ollamaHost);
  if (!(await client.version())) {
    console.error(c.red(`Ollama is not reachable at ${client.host}. Start it with \`ollama serve\`.`));
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const mcp = new McpManager();
  if (Object.keys(config.mcpServers).length) {
    await mcp.connect(config.mcpServers);
    for (const s of mcp.statuses) console.log(c.dim(`mcp ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ''}`));
  }

  const agent = new Agent({
    client,
    model: values.model ?? config.defaultModel,
    cwd: values.cwd ?? process.cwd(),
    mode: (values.mode as PermissionMode) ?? (values.print ? 'read-only' : config.mode),
    maxContext: config.maxContext,
    think: config.think,
    extraTools: mcp.getTools(),
    approve: async (req) => {
      if (values.print) return { kind: 'deny', feedback: 'Non-interactive mode: approvals are not available.' };
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

  console.log(c.bold('openHarness') + c.dim(` · ${agent.model} · ${agent.permissions.mode} · ${agent.cwd}`));
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
      else console.log(c.red(`Unknown command: ${next}`));
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
