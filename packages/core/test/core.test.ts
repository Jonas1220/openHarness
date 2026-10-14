import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  DaemonManager,
  PermissionEngine,
  builtinTools,
  expandCommand,
  expandMentions,
  extractTextToolCalls,
  fuzzyFilter,
  loadCommands,
  loadSkills,
  stripAttachments,
  ruleKeys,
  toTextMode,
  wrapCommand,
  type ChatChunkLike,
  type DaemonDef,
  type Tool,
  type ToolContext,
} from './helpers.ts';
import { FakeOllama } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oh-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tool = (name: string) => builtinTools().find((t) => t.name === name)!;
const ctx = (): ToolContext => ({
  cwd: dir,
  callId: 'c',
  signal: new AbortController().signal,
  sandbox: { enabled: false, writableRoots: [], allowNetwork: true },
  state: new Map(),
  emit: () => {},
});

describe('text tool-call extraction', () => {
  const tools = [{ name: 'read_file' }, { name: 'bash' }];

  it('parses <tool_call> blocks', () => {
    const r = extractTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>', tools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.arguments).toEqual({ path: 'a.ts' });
    expect(r.text).toBe('Let me look.');
  });

  it('parses fenced and bare JSON with "parameters"', () => {
    expect(extractTextToolCalls('```json\n{"name":"bash","parameters":{"command":"ls"}}\n```', tools).calls[0]!.name).toBe('bash');
    expect(extractTextToolCalls('{"name":"bash","parameters":{"command":"ls"}}', tools).calls).toHaveLength(1);
  });

  it('ignores JSON that is not a known tool', () => {
    const r = extractTextToolCalls('```json\n{"name":"Ada","age":3}\n```', tools);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toContain('Ada');
  });
});

describe('file tools', () => {
  it('edit_file requires a prior read and a unique match', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'one\ntwo\ntwo\n');
    const c = ctx();
    expect((await tool('edit_file').run({ path: 'a.txt', old_string: 'one', new_string: '1' }, c)).isError).toBe(true);
    await tool('read_file').run({ path: 'a.txt' }, c);
    const dup = await tool('edit_file').run({ path: 'a.txt', old_string: 'two', new_string: '2' }, c);
    expect(dup.output).toMatch(/appears 2 times/);
    await tool('edit_file').run({ path: 'a.txt', old_string: 'two', new_string: '2', replace_all: true }, c);
    expect(await readFile(file, 'utf8')).toBe('one\n2\n2\n');
  });

  it('read_file numbers lines and honours offset/limit', async () => {
    await writeFile(path.join(dir, 'b.txt'), 'a\nb\nc\nd');
    const r = await tool('read_file').run({ path: 'b.txt', offset: 2, limit: 2 }, ctx());
    expect(r.output).toMatch(/^2\tb\n3\tc/);
  });

  it('write_file creates parent directories', async () => {
    await tool('write_file').run({ path: 'x/y/z.txt', content: 'hi' }, ctx());
    expect(await readFile(path.join(dir, 'x/y/z.txt'), 'utf8')).toBe('hi');
  });

  it('glob finds files', async () => {
    await writeFile(path.join(dir, 'q.ts'), '');
    const r = await tool('glob').run({ pattern: '*.ts' }, ctx());
    expect(r.output).toContain('q.ts');
  });
});

describe('permissions', () => {
  it('maps modes to verdicts', () => {
    const edit = tool('edit_file');
    const bash = tool('bash');
    const read = tool('read_file');
    const args = { path: 'a.ts' };
    expect(new PermissionEngine('ask', dir).check(read, args).kind).toBe('allow');
    expect(new PermissionEngine('ask', dir).check(edit, args).kind).toBe('ask');
    expect(new PermissionEngine('auto-edit', dir).check(edit, args).kind).toBe('allow');
    expect(new PermissionEngine('read-only', dir).check(edit, args).kind).toBe('deny');
    expect(new PermissionEngine('full-auto', dir).check(bash, { command: 'ls' })).toEqual({ kind: 'allow', sandboxed: true });
  });

  it('always asks for writes outside the workspace', () => {
    const v = new PermissionEngine('full-auto', dir).check(tool('write_file'), { path: '/etc/hosts' });
    expect(v.kind).toBe('ask');
  });

  it('session rules cover every command segment', () => {
    const bash = tool('bash');
    const p = new PermissionEngine('ask', dir);
    p.rememberForSession(bash, { command: 'npm test' });
    expect(p.check(bash, { command: 'npm run build' }).kind).toBe('allow');
    expect(p.check(bash, { command: 'npm test && rm -rf /' }).kind).toBe('ask');
    expect(ruleKeys(bash, { command: 'echo $(whoami)' })).toBeNull();
  });
});

describe('sandbox', () => {
  it('wraps commands with sandbox-exec on macOS', () => {
    const argv = wrapCommand(['/bin/echo', 'hi'], { enabled: true, writableRoots: [dir], allowNetwork: false });
    if (process.platform === 'darwin') {
      expect(argv[0]).toBe('/usr/bin/sandbox-exec');
      expect(argv.join(' ')).toContain('(deny network-outbound)');
    } else {
      expect(argv).toEqual(['/bin/echo', 'hi']);
    }
  });

  it.runIf(process.platform === 'darwin')('blocks writes outside the workspace', async () => {
    const c = { ...ctx(), sandbox: { enabled: true, writableRoots: [dir], allowNetwork: false } };
    const inside = await tool('bash').run({ command: 'echo ok > inside.txt && cat inside.txt' }, c);
    expect(inside.output).toContain('ok');
    const target = path.join(os.homedir(), `.oh-sandbox-test-${Date.now()}`);
    const outside = await tool('bash').run({ command: `echo bad > ${target}` }, c);
    expect(outside.isError).toBe(true);
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});

describe('agent loop', () => {
  it('runs tools until the model answers', async () => {
    await writeFile(path.join(dir, 'hello.txt'), 'world');
    const script: ChatChunkLike[][] = [
      [{ toolCalls: [{ name: 'read_file', arguments: { path: 'hello.txt' } }] }],
      [{ content: 'The file says world.' }],
    ];
    const client = new FakeOllama(script);
    const agent = new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'ask', approve: async () => ({ kind: 'allow' }) });
    const events: string[] = [];
    agent.on((e) => events.push(e.type));
    await agent.send('read hello.txt');
    expect(agent.messages.at(-1)!.content).toBe('The file says world.');
    expect(agent.messages.find((m) => m.role === 'tool')!.content).toContain('world');
    expect(events).toContain('tool_result');
    expect(events.at(-1)).toBe('turn_end');
  });

  it('falls back to text tool calls and stops on denial', async () => {
    const client = new FakeOllama([[{ content: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' }]], ['completion']);
    let asked = 0;
    const agent = new Agent({
      client: client as never,
      model: 'm',
      cwd: dir,
      mode: 'ask',
      approve: async () => {
        asked++;
        return { kind: 'deny' };
      },
    });
    await agent.send('list files');
    expect(asked).toBe(1);
    expect(client.requests[0]!.tools).toBeUndefined();
    expect(client.requests[0]!.messages[0]!.content).toContain('<tool_call>');
    expect(agent.messages.at(-1)!.content).toMatch(/User denied/);
  });

  it('toTextMode inlines tool calls and results', () => {
    const out = toTextMode([
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'tool', content: 'a.txt', toolName: 'bash', toolCallId: '1' },
    ]);
    expect(out[0]!.content).toContain('<tool_call>');
    expect(out[1]).toMatchObject({ role: 'user' });
  });
});

describe('daemons', () => {
  const def = (over: Partial<DaemonDef>): DaemonDef => ({
    id: 'd',
    name: 'd',
    emoji: '✦',
    goal: 'g',
    model: 'm',
    cwd: dir,
    mode: 'auto-edit',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('computes the next run', () => {
    const now = new Date('2026-05-01T12:00:00');
    expect(DaemonManager.nextRun(def({}), now)).toEqual(now);
    expect(DaemonManager.nextRun(def({ lastRunAt: '2026-05-01T11:50:00' }), now)!.getTime()).toBe(new Date('2026-05-01T12:20:00').getTime());
    expect(DaemonManager.nextRun(def({ schedule: { kind: 'manual' } }), now)).toBeNull();
    const daily = def({ schedule: { kind: 'daily', time: '09:00' }, lastRunAt: new Date('2026-05-01T09:01:00').toISOString() });
    expect(DaemonManager.nextRun(daily, now)!.getDate()).toBe(2);
  });

  it('runs, reports to the inbox and saves memory', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'update_memory', arguments: { content: 'checked once' } }] }],
      [{ toolCalls: [{ name: 'report_to_user', arguments: { title: 'Done', message: 'All good' } }] }],
      [{ content: 'Checked; all good.' }],
    ]);
    const { SessionStore } = await import('../src/store.ts');
    const mgr = new DaemonManager(() => client as never, new SessionStore(path.join(dir, 'sessions')), { dir: path.join(dir, 'daemons') });
    await mgr.load();
    const d = await mgr.upsert({ name: 'Watcher', goal: 'watch', model: 'm', cwd: dir, schedule: { kind: 'manual' } });
    await mgr.run(d.id);
    expect(await mgr.readMemory(d.id)).toBe('checked once');
    expect(mgr.getInbox().map((i) => i.title)).toContain('Done');
    expect(mgr.list()[0]!.lastSummary).toBe('Checked; all good.');
  });
});

describe('plan mode', () => {
  it('blocks edits, then switches mode when the plan is approved', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'no' } }] }],
      [{ toolCalls: [{ name: 'propose_plan', arguments: { plan: '1. write x.txt' } }] }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'yes' } }] }],
      [{ content: 'Done.' }],
    ]);
    const modes: string[] = [];
    const agent = new Agent({
      client: client as never,
      model: 'm',
      cwd: dir,
      mode: 'plan',
      skills: false,
      approve: async (req) => (req.toolName === 'propose_plan' ? { kind: 'allow', mode: 'auto-edit' } : { kind: 'deny' }),
    });
    agent.on((e) => e.type === 'mode_changed' && modes.push(e.mode));
    await agent.send('make x');
    expect(modes).toEqual(['auto-edit']);
    expect(agent.mode).toBe('auto-edit');
    expect(await readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('yes');
    expect(agent.messages.find((m) => m.role === 'tool')!.content).toMatch(/Plan mode/);
    // propose_plan is only offered in plan mode
    expect(client.requests[0]!.tools!.some((t) => t.name === 'propose_plan')).toBe(true);
    expect(client.requests[2]!.tools!.some((t) => t.name === 'propose_plan')).toBe(false);
  });
});

describe('checkpoints and rewind', () => {
  it('restores files and truncates the conversation', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'v1');
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'v2' } }] }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'new.txt', content: 'hi' } }] }],
      [{ content: 'ok' }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'v3' } }] }],
      [{ content: 'ok' }],
    ]);
    const agent = new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'auto-edit', skills: false, approve: async () => ({ kind: 'allow' }) });
    await agent.send('first', { id: 'u1' });
    await agent.send('second', { id: 'u2' });
    expect(await readFile(file, 'utf8')).toBe('v3');
    expect(agent.checkpoints.changedFiles().sort()).toEqual([file, path.join(dir, 'new.txt')].sort());

    await agent.rewind('u2');
    expect(await readFile(file, 'utf8')).toBe('v2');
    expect(agent.messages.some((m) => m.id === 'u2')).toBe(false);

    await agent.rewind('u1');
    expect(await readFile(file, 'utf8')).toBe('v1');
    await expect(readFile(path.join(dir, 'new.txt'), 'utf8')).rejects.toThrow();
    expect(agent.messages.filter((m) => m.role !== 'system')).toHaveLength(0);
  });
});

describe('subagents', () => {
  it('runs a read-only child agent and returns its report', async () => {
    await writeFile(path.join(dir, 'notes.md'), 'secret sauce');
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'task', arguments: { description: 'find notes', prompt: 'What is in notes.md?' } }] }],
      [{ toolCalls: [{ name: 'read_file', arguments: { path: 'notes.md' } }] }], // child
      [{ content: 'notes.md says: secret sauce' }], // child report
      [{ content: 'It says secret sauce.' }],
    ]);
    const agent = new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'ask', skills: false, approve: async () => ({ kind: 'allow' }) });
    const progress: string[] = [];
    agent.on((e) => e.type === 'subagent_progress' && progress.push(e.summary));
    await agent.send('ask a subagent');
    expect(progress).toEqual(['Read notes.md']);
    expect(agent.messages.find((m) => m.toolName === 'task')!.content).toBe('notes.md says: secret sauce');
    // the child only had read-only tools
    expect(client.requests[1]!.tools!.map((t) => t.name).sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file']);
  });
});

describe('commands, skills and mentions', () => {
  it('loads project commands and expands arguments', async () => {
    await mkdir(path.join(dir, '.openharness', 'commands'), { recursive: true });
    await writeFile(path.join(dir, '.openharness', 'commands', 'fix.md'), '---\ndescription: Fix an issue\n---\nFix issue #$ARGUMENTS carefully.');
    const cmds = await loadCommands(dir);
    const fix = cmds.find((c) => c.name === 'fix')!;
    expect(fix.description).toBe('Fix an issue');
    expect(expandCommand(fix, '42')).toBe('Fix issue #42 carefully.');
    expect(cmds.some((c) => c.name === 'init')).toBe(true);
  });

  it('lists skills and loads one on demand', async () => {
    await mkdir(path.join(dir, '.agents', 'skills', 'deploy'), { recursive: true });
    await writeFile(path.join(dir, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\nRun make deploy.');
    const skills = await loadSkills(dir);
    expect(skills.find((s) => s.name === 'deploy')?.description).toBe('Deploy the app');
  });

  it('inlines @mentioned files and strips them for display', async () => {
    await writeFile(path.join(dir, 'b.ts'), 'export const b = 1;');
    const out = await expandMentions('look at @b.ts please', dir);
    expect(out).toContain('<file path="b.ts">');
    expect(stripAttachments(out)).toBe('look at @b.ts please');
    expect(await expandMentions('mail me @nobody', dir)).toBe('mail me @nobody');
  });

  it('fuzzy-matches file names', () => {
    const files = ['src/agent.ts', 'src/tools/shell.ts', 'README.md', 'test/agent.test.ts'];
    expect(fuzzyFilter(files, 'agent')[0]).toBe('src/agent.ts');
    expect(fuzzyFilter(files, 'shl')).toEqual(['src/tools/shell.ts']);
  });
});

export type { Tool };
