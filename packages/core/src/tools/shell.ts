import { spawn } from 'node:child_process';
import { wrapCommand } from '../sandbox.ts';
import type { SandboxPolicy, Tool } from '../types.ts';
import { num, resolvePath, str, truncate } from './util.ts';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Run argv, optionally inside the Seatbelt sandbox, with a timeout and abort support. */
export function exec(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; sandbox?: SandboxPolicy; maxBytes?: number; input?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const finalArgv = opts.sandbox ? wrapCommand(argv, opts.sandbox) : argv;
  const max = opts.maxBytes ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(finalArgv[0]!, finalArgv.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1', CI: '1', ...opts.env },
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // the process may exit without reading its input
      child.stdin.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString('utf8');
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export const bash: Tool = {
  name: 'bash',
  kind: 'exec',
  description:
    'Run a shell command (zsh) and return its output. Use for git, builds, tests, package managers and other CLI tools. Do not use it to read or edit files — use the file tools. Commands are non-interactive; avoid commands that wait for input or run forever.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run.' },
      workdir: { type: 'string', description: 'Directory to run in (default: working directory).' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000).' },
    },
    required: ['command'],
  },
  describe: (a) => `$ ${a.command}`,
  async run(args, ctx) {
    const command = str(args, 'command');
    const cwd = resolvePath(str(args, 'workdir', '.'), ctx.cwd);
    const timeoutMs = Math.min(num(args, 'timeout_ms') ?? 120_000, 600_000);
    const res = await exec(['/bin/zsh', '-c', command], { cwd, timeoutMs, signal: ctx.signal, sandbox: ctx.sandbox });
    let out = res.stdout;
    if (res.stderr.trim()) out += (out ? '\n' : '') + res.stderr;
    out = truncate(out.trimEnd() || '(no output)');
    if (res.timedOut) out += `\n[timed out after ${timeoutMs} ms]`;
    if (ctx.sandbox.enabled && /Operation not permitted|sandbox/i.test(res.stderr)) {
      out += '\n[note: this command ran in a sandbox that blocks writes outside the workspace and network access]';
    }
    return { output: `${out}\n[exit code ${res.code ?? 'killed'}]`, isError: res.code !== 0 };
  },
};

let rgPath: string | null | undefined;
async function findRipgrep(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  for (const p of ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']) {
    try {
      const r = await exec([p, '--version'], { cwd: '/', timeoutMs: 3000 });
      if (r.code === 0) return (rgPath = p);
    } catch {
      /* not here */
    }
  }
  return (rgPath = null);
}

export const grep: Tool = {
  name: 'grep',
  kind: 'read',
  description:
    'Search file contents with a regular expression (ripgrep syntax when available). Returns matching lines with file:line prefixes, or only file names with files_only.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search (default: working directory).' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      files_only: { type: 'boolean', description: 'Only list matching file paths.' },
    },
    required: ['pattern'],
  },
  describe: (a) => `Search for /${a.pattern}/`,
  async run(args, ctx) {
    const pattern = str(args, 'pattern');
    const target = resolvePath(str(args, 'path', '.'), ctx.cwd);
    const rg = await findRipgrep();
    let argv: string[];
    if (rg) {
      argv = [rg, '--line-number', '--no-heading', '--color=never', '--max-columns=400', '--max-count=50'];
      if (args.ignore_case === true) argv.push('-i');
      if (args.files_only === true) argv.push('--files-with-matches');
      if (typeof args.glob === 'string') argv.push('--glob', args.glob);
      argv.push('--', pattern, target);
    } else {
      argv = ['/usr/bin/grep', '-rnE', '--exclude-dir=node_modules', '--exclude-dir=.git'];
      if (args.ignore_case === true) argv.push('-i');
      if (args.files_only === true) argv.push('-l');
      if (typeof args.glob === 'string') argv.push(`--include=${args.glob}`);
      argv.push('--', pattern, target);
    }
    const res = await exec(argv, { cwd: ctx.cwd, timeoutMs: 30_000, signal: ctx.signal });
    if (res.code === 1) return { output: 'No matches.' };
    if (res.code !== 0) return { output: res.stderr || 'Search failed.', isError: true };
    const lines = res.stdout.split('\n').filter(Boolean);
    const shown = lines.slice(0, 300).map((l) => (l.startsWith(ctx.cwd + '/') ? l.slice(ctx.cwd.length + 1) : l));
    return { output: shown.join('\n') + (lines.length > 300 ? `\n(${lines.length - 300} more matches not shown)` : '') };
  },
};
