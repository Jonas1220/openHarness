import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.ts';
import { exec } from './tools/shell.ts';

/**
 * Git worktrees give a chat its own checkout on its own branch, so several chats can change
 * the same repository in parallel without stepping on each other (like `claude --worktree`
 * and Codex's /worktree). Worktrees live in ~/.openharness/worktrees; branches are named oh/<name>.
 */
export interface WorktreeInfo {
  /** Working directory for the chat (the worktree, or a subfolder of it). */
  cwd: string;
  /** Root of the worktree checkout. */
  path: string;
  branch: string;
  /** Branch the worktree was created from. */
  base: string;
  /** Root of the original repository. */
  repo: string;
  /** The repository's shared .git directory; sandboxed commands need write access to commit. */
  gitDir: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await exec(['git', ...args], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout.trim();
}

export async function gitRoot(dir: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--show-toplevel'], dir);
  } catch {
    return null;
  }
}

export async function createWorktree(dir: string, name?: string): Promise<WorktreeInfo> {
  const repo = await gitRoot(dir);
  if (!repo) throw new Error(`${dir} is not inside a git repository.`);
  const id = randomBytes(3).toString('hex');
  const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const branch = `oh/${slug ? `${slug}-${id}` : id}`;
  const base = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).catch(() => 'HEAD');
  const wtPath = path.join(dataDir(), 'worktrees', `${path.basename(repo)}-${id}`);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await git(['worktree', 'add', '-b', branch, wtPath, 'HEAD'], repo);
  const gitDir = path.resolve(repo, await git(['rev-parse', '--git-common-dir'], repo));
  // Keep the same subfolder when the chat was started below the repository root.
  const sub = path.relative(await fs.realpath(repo), await fs.realpath(dir));
  return { cwd: sub && !sub.startsWith('..') ? path.join(wtPath, sub) : wtPath, path: wtPath, branch, base, repo, gitDir };
}

export async function worktreeStatus(info: Pick<WorktreeInfo, 'path' | 'base'>): Promise<{ changedFiles: number; commits: number } | null> {
  try {
    const status = await git(['status', '--porcelain'], info.path);
    const commits = await git(['rev-list', '--count', `${info.base}..HEAD`], info.path).catch(() => '0');
    return { changedFiles: status ? status.split('\n').length : 0, commits: Number(commits) || 0 };
  } catch {
    return null;
  }
}

/** Remove the checkout. The branch is kept, so committed work is never lost. */
export async function removeWorktree(info: Pick<WorktreeInfo, 'path' | 'repo'>): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', info.path], info.repo);
  } catch {
    await fs.rm(info.path, { recursive: true, force: true });
    await git(['worktree', 'prune'], info.repo).catch(() => {});
  }
}
