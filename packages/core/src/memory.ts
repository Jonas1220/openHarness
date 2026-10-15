import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.ts';
import type { Tool } from './types.ts';

/**
 * Auto memory: facts the agent decides to keep across chats, like Claude Code's auto memory
 * and Codex's memories. One file for things about the user, one per project folder.
 * Both are plain Markdown lists under ~/.openharness/memory that the user can edit.
 */
export type MemoryScope = 'user' | 'project';

const MAX_CHARS = 8000;

export function memoryFile(scope: MemoryScope, cwd: string): string {
  const dir = path.join(dataDir(), 'memory');
  if (scope === 'user') return path.join(dir, 'user.md');
  return path.join(dir, 'projects', `${path.resolve(cwd).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`);
}

export async function readMemory(scope: MemoryScope, cwd: string): Promise<string> {
  return fs.readFile(memoryFile(scope, cwd), 'utf8').catch(() => '');
}

export async function writeMemory(scope: MemoryScope, cwd: string, content: string): Promise<void> {
  const file = memoryFile(scope, cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content.trim() ? `${content.trim()}\n` : '', 'utf8');
}

export async function memoryPrompt(cwd: string): Promise<string> {
  const [user, project] = await Promise.all([readMemory('user', cwd), readMemory('project', cwd)]);
  const parts = [
    `# Memory
You can keep notes across chats with the remember and forget tools. Use remember when the user states a lasting preference ("always use pnpm") or when you learn a non-obvious fact about this project that will matter again (how to run tests, a gotcha, where something lives). Don't save things that are obvious from the code, temporary, or only relevant to this chat. Keep each fact to one short line.`,
  ];
  if (user.trim()) parts.push(`## About the user\n${user.trim()}`);
  if (project.trim()) parts.push(`## About this project\n${project.trim()}`);
  return parts.join('\n\n');
}

export function memoryTools(cwd: string, onChange?: (scope: MemoryScope) => void): Tool[] {
  const scopeOf = (v: unknown): MemoryScope => (v === 'user' ? 'user' : 'project');
  return [
    {
      name: 'remember',
      kind: 'meta',
      description:
        'Save a short fact to memory so you know it in future chats. scope "user" for the user\'s preferences, "project" (default) for facts about this project.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'One short line.' },
          scope: { type: 'string', enum: ['project', 'user'] },
        },
        required: ['fact'],
      },
      describe: (a) => `Remember: ${String(a.fact ?? '').slice(0, 80)}`,
      async run(args) {
        const scope = scopeOf(args.scope);
        const fact = String(args.fact ?? '').replace(/\s+/g, ' ').trim();
        if (!fact) return { output: 'Nothing to remember.', isError: true };
        const current = await readMemory(scope, cwd);
        const lines = current.split('\n').filter((l) => l.trim());
        if (lines.some((l) => l.replace(/^-\s*/, '').toLowerCase() === fact.toLowerCase())) return { output: 'Already in memory.' };
        const next = [...lines, `- ${fact}`].join('\n');
        if (next.length > MAX_CHARS) {
          return { output: `The ${scope} memory is full. Use forget to remove outdated facts first.`, isError: true };
        }
        await writeMemory(scope, cwd, next);
        onChange?.(scope);
        return { output: `Saved to ${scope} memory.` };
      },
    },
    {
      name: 'forget',
      kind: 'meta',
      description: 'Remove facts from memory that are wrong or outdated: every line containing the given text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text that identifies the fact(s) to remove.' },
          scope: { type: 'string', enum: ['project', 'user'] },
        },
        required: ['text'],
      },
      describe: (a) => `Forget: ${String(a.text ?? '').slice(0, 80)}`,
      async run(args) {
        const scope = scopeOf(args.scope);
        const needle = String(args.text ?? '').toLowerCase().trim();
        if (!needle) return { output: 'Say what to forget.', isError: true };
        const lines = (await readMemory(scope, cwd)).split('\n').filter((l) => l.trim());
        const kept = lines.filter((l) => !l.toLowerCase().includes(needle));
        if (kept.length === lines.length) return { output: `Nothing in ${scope} memory matches "${args.text}".` };
        await writeMemory(scope, cwd, kept.join('\n'));
        onChange?.(scope);
        return { output: `Removed ${lines.length - kept.length} line(s) from ${scope} memory.` };
      },
    },
  ];
}
