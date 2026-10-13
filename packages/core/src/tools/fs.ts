import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.ts';
import { IGNORED_DIRS, bool, num, resolvePath, str, truncate } from './util.ts';

const READ_FILES = 'readFiles';

function readSet(ctx: ToolContext): Set<string> {
  let s = ctx.state.get(READ_FILES) as Set<string> | undefined;
  if (!s) ctx.state.set(READ_FILES, (s = new Set()));
  return s;
}

export const readFile: Tool = {
  name: 'read_file',
  kind: 'read',
  description:
    'Read a text file. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      offset: { type: 'number', description: '1-based line number to start at.' },
      limit: { type: 'number', description: 'Maximum number of lines to return (default 2000).' },
    },
    required: ['path'],
  },
  describe: (a) => `Read ${a.path}`,
  async run(args, ctx) {
    const file = resolvePath(str(args, 'path'), ctx.cwd);
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { output: `${file} is a binary file (${buf.length} bytes).`, isError: true };
    const lines = buf.toString('utf8').split('\n');
    const offset = Math.max(1, num(args, 'offset') ?? 1);
    const limit = Math.max(1, num(args, 'limit') ?? 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    readSet(ctx).add(file);
    if (slice.length === 0) return { output: `(file has ${lines.length} lines; nothing at offset ${offset})` };
    const width = String(offset + slice.length).length;
    const body = slice
      .map((l, i) => `${String(offset + i).padStart(width)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`)
      .join('\n');
    const more = offset - 1 + limit < lines.length ? `\n(${lines.length - (offset - 1 + limit)} more lines — use offset to read further)` : '';
    return { output: body + more };
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  kind: 'write',
  description: 'Create a new file or completely overwrite an existing one. Prefer edit_file for changing existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
  },
  describe: (a) => `Write ${a.path}`,
  targetPaths: (a, cwd) => [resolvePath(String(a.path ?? ''), cwd)],
  async run(args, ctx) {
    const file = resolvePath(str(args, 'path'), ctx.cwd);
    const content = str(args, 'content');
    const existed = await fs.stat(file).then(() => true, () => false);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    readSet(ctx).add(file);
    return { output: `${existed ? 'Overwrote' : 'Created'} ${file} (${content.split('\n').length} lines).` };
  },
};

export const editFile: Tool = {
  name: 'edit_file',
  kind: 'write',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Include enough surrounding lines to make it unique. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  describe: (a) => `Edit ${a.path}`,
  targetPaths: (a, cwd) => [resolvePath(String(a.path ?? ''), cwd)],
  async run(args, ctx) {
    const file = resolvePath(str(args, 'path'), ctx.cwd);
    const oldStr = str(args, 'old_string');
    const newStr = str(args, 'new_string');
    if (!readSet(ctx).has(file)) {
      return { output: `You must read ${file} with read_file before editing it.`, isError: true };
    }
    if (oldStr === newStr) return { output: 'old_string and new_string are identical; nothing to do.', isError: true };
    const content = await fs.readFile(file, 'utf8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return {
        output: `old_string was not found in ${file}. Re-read the file and copy the text exactly, including whitespace. Do not include line numbers.`,
        isError: true,
      };
    }
    if (count > 1 && !bool(args, 'replace_all')) {
      return {
        output: `old_string appears ${count} times in ${file}. Add surrounding lines to make it unique, or set replace_all to true.`,
        isError: true,
      };
    }
    const updated = bool(args, 'replace_all') ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
    await fs.writeFile(file, updated, 'utf8');
    return { output: `Edited ${file} (${count} replacement${count > 1 ? 's' : ''}).` };
  },
};

export const listDir: Tool = {
  name: 'list_dir',
  kind: 'read',
  description: 'List the entries of a directory. Directories end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default: working directory).' } },
  },
  describe: (a) => `List ${a.path ?? '.'}`,
  async run(args, ctx) {
    const dir = resolvePath(str(args, 'path', '.'), ctx.cwd);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    return { output: names.length ? truncate(names.join('\n'), 20_000) : '(empty directory)' };
  },
};

export const glob: Tool = {
  name: 'glob',
  kind: 'read',
  description: 'Find files by glob pattern, e.g. "src/**/*.ts". Skips node_modules, .git and build folders.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Directory to search in (default: working directory).' },
    },
    required: ['pattern'],
  },
  describe: (a) => `Find ${a.pattern}`,
  async run(args, ctx) {
    const root = resolvePath(str(args, 'path', '.'), ctx.cwd);
    const matches: string[] = [];
    for await (const entry of fs.glob(str(args, 'pattern'), {
      cwd: root,
      exclude: (name: string) => IGNORED_DIRS.has(path.basename(name)),
    })) {
      matches.push(entry);
      if (matches.length >= 500) break;
    }
    if (!matches.length) return { output: 'No files matched.' };
    matches.sort();
    return { output: matches.join('\n') + (matches.length >= 500 ? '\n(results capped at 500)' : '') };
  },
};
