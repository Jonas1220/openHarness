import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';

export interface SlashCommand {
  name: string;
  description: string;
  /** Prompt template; `$ARGUMENTS` is replaced with whatever follows the command. Absent for UI actions. */
  body?: string;
  source: 'builtin' | 'user' | 'project';
}

/** Commands handled by the app itself rather than sent to the model. */
export const UI_COMMANDS: SlashCommand[] = [
  { name: 'plan', description: 'Switch to plan mode (optionally followed by a task)', source: 'builtin' },
  { name: 'compact', description: 'Summarize the conversation to free up context', source: 'builtin' },
  { name: 'clear', description: 'Start a new chat in the same folder', source: 'builtin' },
  { name: 'rewind', description: 'Undo the last turn: restore files and conversation', source: 'builtin' },
  { name: 'fork', description: 'Copy this chat into a new chat to try a different direction', source: 'builtin' },
  { name: 'export', description: 'Save this chat as a Markdown file', source: 'builtin' },
];

export const PROMPT_COMMANDS: SlashCommand[] = [
  {
    name: 'init',
    description: 'Create an AGENTS.md that explains this codebase to agents',
    source: 'builtin',
    body: `Analyze this codebase and create an AGENTS.md file in the working directory (or improve the existing one).

Look at the README, package/build files, the directory layout and a few representative source files first. Then write a concise AGENTS.md that covers:
- What the project is, in one or two sentences
- How to install dependencies, build, run, and test (exact commands)
- The architecture: main directories and what lives where
- Code style and conventions that are not obvious from the code
- Anything an agent must not do (generated files, secrets, protected branches)

Keep it under 150 lines. Only state things you verified in the repository. $ARGUMENTS`,
  },
  {
    name: 'review',
    description: 'Review the uncommitted changes for bugs',
    source: 'builtin',
    body: `Review the uncommitted changes in this repository. Run \`git status\` and \`git diff\` (and \`git diff --staged\`) to see them, and read surrounding code where needed.

Report concrete problems only — bugs, missed edge cases, security issues, broken error handling — ordered by severity, each with file:line and a suggested fix. Do not modify any files. If the changes look correct, say so briefly. $ARGUMENTS`,
  },
  {
    name: 'commit',
    description: 'Commit the current changes with a good message',
    source: 'builtin',
    body: `Create a git commit for the current changes.

1. Run \`git status\` and \`git diff\` (staged and unstaged) to see what changed, and \`git log --oneline -5\` to match the repository's commit message style.
2. If you are on the default branch (main or master) and the user didn't say otherwise, create a new branch with a short descriptive name first.
3. Stage only files that belong to this change. Never stage secrets (.env files, keys, credentials).
4. Write a concise commit message: a short summary line, then a blank line and a few lines on what changed and why if it isn't obvious.
5. Commit and show the result with \`git log --oneline -1\`. Do not push unless asked. $ARGUMENTS`,
  },
  {
    name: 'pr',
    description: 'Push the branch and open a pull request with gh',
    source: 'builtin',
    body: `Open a pull request for the current branch.

1. Check \`git status\`; if there are uncommitted changes, ask whether to commit them first.
2. Find the base branch (usually main) and review the commits and diff that the PR will contain (\`git log\` and \`git diff\` against the base).
3. Push the branch with \`git push -u origin HEAD\`.
4. Create the PR with \`gh pr create\`: a clear title and a description that summarizes what changed, why, and how it was tested. If \`gh\` isn't installed or logged in, tell the user what to run instead.
5. Reply with the PR URL. $ARGUMENTS`,
  },
  {
    name: 'explain',
    description: 'Explain how something in this codebase works',
    source: 'builtin',
    body: 'Explain how this works in this codebase, with references to the relevant files and functions: $ARGUMENTS',
  },
];

/**
 * Custom commands are Markdown files: `~/.openharness/commands/<name>.md` (user) and
 * `<project>/.openharness/commands/<name>.md` (project). Claude Code's `.claude/commands`
 * folders are read too, so existing commands keep working. Optional frontmatter: `description`.
 */
export async function loadCommands(cwd: string): Promise<SlashCommand[]> {
  const dirs: [string, SlashCommand['source']][] = [
    [path.join(os.homedir(), '.openharness', 'commands'), 'user'],
    [path.join(os.homedir(), '.claude', 'commands'), 'user'],
    [path.join(cwd, '.claude', 'commands'), 'project'],
    [path.join(cwd, '.openharness', 'commands'), 'project'],
  ];
  const byName = new Map<string, SlashCommand>();
  for (const c of [...UI_COMMANDS, ...PROMPT_COMMANDS]) byName.set(c.name, c);
  for (const [dir, source] of dirs) {
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3).replace(/[^\w:-]/g, '-');
      if (UI_COMMANDS.some((c) => c.name === name)) continue;
      const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
      const { data, body } = parseFrontmatter(text);
      byName.set(name, { name, description: data.description || firstLine(body), body, source });
    }
  }
  return [...byName.values()];
}

/** Turn `/name args` into the prompt to send. */
export function expandCommand(cmd: SlashCommand, args: string): string {
  const body = cmd.body ?? '';
  return body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args).trim() : `${body.trim()}\n\n${args}`.trim();
}

function firstLine(s: string): string {
  return (s.trim().split('\n')[0] ?? '').slice(0, 80);
}
