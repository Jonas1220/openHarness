import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from './tools/shell.ts';
import { IGNORED_DIRS, resolvePath, truncate } from './tools/util.ts';

export const ATTACHMENTS_OPEN = '<attached_files>';
export const ATTACHMENTS_CLOSE = '</attached_files>';

/**
 * Expand `@path` mentions: the referenced files (or directory listings) are appended
 * to the message so the model doesn't need a tool call to see them.
 */
export async function expandMentions(text: string, cwd: string): Promise<string> {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const raw = m[1]!.replace(/[.,;:!?)]+$/, '');
    const file = resolvePath(raw, cwd);
    if (seen.has(file)) continue;
    seen.add(file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file, { withFileTypes: true });
      const list = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      blocks.push(`<directory path="${raw}">\n${list.join('\n')}\n</directory>`);
    } else if (stat.size <= 256_000) {
      const content = await fs.readFile(file, 'utf8');
      if (!content.includes('\u0000')) blocks.push(`<file path="${raw}">\n${truncate(content, 60_000)}\n</file>`);
    }
  }
  if (!blocks.length) return text;
  return `${text}\n\n${ATTACHMENTS_OPEN}\n${blocks.join('\n')}\n${ATTACHMENTS_CLOSE}`;
}

/** Remove the attached-file block for display. */
export function stripAttachments(text: string): string {
  const i = text.indexOf(`\n\n${ATTACHMENTS_OPEN}`);
  return i >= 0 ? text.slice(0, i) : text;
}

const fileCache = new Map<string, { at: number; files: string[] }>();

/** Files in a workspace for @-completion: `git ls-files` when possible, otherwise a bounded walk. */
export async function listWorkspaceFiles(cwd: string, limit = 8000): Promise<string[]> {
  const cached = fileCache.get(cwd);
  if (cached && Date.now() - cached.at < 30_000) return cached.files;
  let files: string[] = [];
  try {
    const r = await exec(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 5000 });
    if (r.code === 0) files = r.stdout.split('\n').filter(Boolean).slice(0, limit);
  } catch {
    /* not a git repo */
  }
  if (!files.length) files = await walk(cwd, limit);
  fileCache.set(cwd, { at: Date.now(), files });
  return files;
}

async function walk(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < limit) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) queue.push(p);
      } else out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Subsequence fuzzy match, ranked by how early and how tightly the query matches. */
export function fuzzyFilter(files: string[], query: string, max = 20): string[] {
  if (!query) return files.slice(0, max);
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const f of files) {
    const s = f.toLowerCase();
    let i = 0;
    let first = -1;
    let last = 0;
    for (let k = 0; k < s.length && i < q.length; k++) {
      if (s[k] === q[i]) {
        if (first < 0) first = k;
        last = k;
        i++;
      }
    }
    if (i < q.length) continue;
    const base = s.lastIndexOf('/') + 1;
    const nameHit = s.indexOf(q, base) >= 0 ? -100 : 0;
    scored.push([nameHit + (last - first) + first * 0.1 + s.length * 0.01, f]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, max)
    .map(([, f]) => f);
}
