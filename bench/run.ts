/**
 * Open Harness benchmark: realistic coding tasks with automatic checks.
 *
 *   npm run bench -- -m qwen3:8b                 run every task with a model
 *   npm run bench -- -m lmstudio::qwen3-8b --tasks off-by-one,cli-flag
 *   npm run bench -- --validate                  check the tasks themselves (no model)
 *
 * Each task in bench/tasks/<id> has:
 *   task.json   { prompt, check, timeoutSec, tags }
 *   repo/       the starting project, copied into a fresh git repo for the agent
 *   solution/   reference files (used by --validate), never shown to the agent
 *   check.*     scripts the check command may call via $TASK_DIR
 *
 * Results are written to bench/results/ and compared with the previous run of the same model.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Agent, OllamaClient, RoutingClient, exec, loadConfig, type ModelClient } from '@openharness/core';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BENCH_DIR, '..');
const TASKS_DIR = path.join(BENCH_DIR, 'tasks');
const RESULTS_DIR = path.join(BENCH_DIR, 'results');

export interface Task {
  id: string;
  dir: string;
  prompt: string;
  check: string;
  timeoutSec: number;
  tags: string[];
}

export interface TaskResult {
  id: string;
  passed: boolean;
  seconds: number;
  toolCalls: number;
  tokens: number;
  error?: string;
  checkOutput?: string;
}

export async function loadTasks(filter?: string[]): Promise<Task[]> {
  const ids = (await readdir(TASKS_DIR)).sort();
  const tasks: Task[] = [];
  for (const id of ids) {
    if (filter?.length && !filter.includes(id)) continue;
    const dir = path.join(TASKS_DIR, id);
    const meta = JSON.parse(await readFile(path.join(dir, 'task.json'), 'utf8')) as Omit<Task, 'id' | 'dir'>;
    tasks.push({ id, dir, ...meta, timeoutSec: meta.timeoutSec ?? 300, tags: meta.tags ?? [] });
  }
  return tasks;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com' };

async function git(args: string[], cwd: string): Promise<void> {
  const r = await exec(['git', ...args], { cwd, timeoutMs: 30_000, env: GIT_ENV });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** Copy a task's starting project into a fresh git repository. */
export async function prepare(task: Task): Promise<string> {
  const work = await mkdtemp(path.join(os.tmpdir(), `oh-bench-${task.id}-`));
  await cp(path.join(task.dir, 'repo'), work, { recursive: true });
  await git(['init', '-q', '-b', 'main'], work);
  await git(['config', 'user.name', 'bench'], work);
  await git(['config', 'user.email', 'bench@example.com'], work);
  await git(['add', '-A'], work);
  await git(['commit', '-q', '-m', 'initial'], work);
  return work;
}

export async function runCheck(task: Task, work: string): Promise<{ passed: boolean; output: string }> {
  const r = await exec(['/bin/zsh', '-c', task.check], {
    cwd: work,
    timeoutMs: 120_000,
    env: { TASK_DIR: task.dir, WORK_DIR: work, OH_ROOT: ROOT, ...GIT_ENV },
  });
  return { passed: r.code === 0, output: `${r.stdout}${r.stderr}`.trim().slice(-2000) };
}

/** Apply the reference solution: overlay its files; `.bench-commit` holds a commit message to commit with. */
async function applySolution(task: Task, work: string): Promise<void> {
  await cp(path.join(task.dir, 'solution'), work, { recursive: true });
  const msgFile = path.join(work, '.bench-commit');
  const message = await readFile(msgFile, 'utf8').catch(() => null);
  if (message) {
    await rm(msgFile);
    await git(['add', '-A'], work);
    await git(['commit', '-q', '-m', message.trim()], work);
  }
}

/** Every task's check must fail on the starting project and pass with the reference solution. */
export async function validate(tasks: Task[]): Promise<{ id: string; ok: boolean; problem?: string }[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const work = await prepare(task);
      try {
        const before = await runCheck(task, work);
        if (before.passed) return { id: task.id, ok: false, problem: 'check already passes on the starting project' };
        await applySolution(task, work);
        const after = await runCheck(task, work);
        if (!after.passed) return { id: task.id, ok: false, problem: `check fails with the reference solution:\n${after.output}` };
        return { id: task.id, ok: true };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }),
  );
}

export async function runTask(task: Task, client: ModelClient, model: string, maxSteps: number): Promise<TaskResult> {
  const work = await prepare(task);
  const started = Date.now();
  let toolCalls = 0;
  let tokens = 0;
  let error: string | undefined;
  const agent = new Agent({
    client,
    model,
    cwd: work,
    mode: 'full-auto',
    maxSteps,
    skills: false,
    memory: false,
    approve: async () => ({ kind: 'allow' }),
  });
  agent.on((e) => {
    if (e.type === 'tool_call') toolCalls++;
    if (e.type === 'usage') tokens += e.usage.promptTokens + e.usage.completionTokens;
    if (e.type === 'error') error = e.message;
  });
  const timer = setTimeout(() => agent.abort(), task.timeoutSec * 1000);
  try {
    await agent.send(task.prompt);
  } finally {
    clearTimeout(timer);
  }
  const check = await runCheck(task, work);
  await rm(work, { recursive: true, force: true });
  return {
    id: task.id,
    passed: check.passed,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    toolCalls,
    tokens,
    ...(error ? { error } : {}),
    ...(check.passed ? {} : { checkOutput: check.output }),
  };
}

async function previousRun(model: string): Promise<{ results: TaskResult[]; file: string } | null> {
  const files = (await readdir(RESULTS_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(`${safe(model)}.json`)).sort();
  const last = files.at(-1);
  if (!last) return null;
  return { file: last, ...(JSON.parse(await readFile(path.join(RESULTS_DIR, last), 'utf8')) as { results: TaskResult[] }) };
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9.-]+/g, '_');

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      tasks: { type: 'string' },
      validate: { type: 'boolean' },
      'max-steps': { type: 'string' },
    },
  });
  const tasks = await loadTasks(values.tasks?.split(','));
  if (!tasks.length) throw new Error('No matching tasks.');

  if (values.validate) {
    const report = await validate(tasks);
    for (const r of report) console.log(`${r.ok ? '✓' : '✕'} ${r.id}${r.problem ? `  ${r.problem}` : ''}`);
    const bad = report.filter((r) => !r.ok).length;
    console.log(`\n${report.length - bad}/${report.length} tasks valid`);
    process.exit(bad ? 1 : 0);
  }

  const config = await loadConfig();
  const model = values.model ?? config.defaultModel;
  const client = new RoutingClient(new OllamaClient(config.ollamaHost), config.providers);
  const maxSteps = Number(values['max-steps'] ?? 30);
  console.log(`Running ${tasks.length} tasks with ${model}\n`);

  const results: TaskResult[] = [];
  for (const task of tasks) {
    const r = await runTask(task, client, model, maxSteps);
    results.push(r);
    console.log(`${r.passed ? '✓' : '✕'} ${task.id.padEnd(22)} ${String(r.seconds).padStart(6)}s  ${String(r.toolCalls).padStart(3)} tool calls${r.error ? `  (${r.error.slice(0, 80)})` : ''}`);
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)}%)`);

  const prev = await previousRun(model);
  if (prev) {
    const before = new Map(prev.results.map((r) => [r.id, r.passed]));
    const regressions = results.filter((r) => before.get(r.id) === true && !r.passed).map((r) => r.id);
    const fixes = results.filter((r) => before.get(r.id) === false && r.passed).map((r) => r.id);
    console.log(`Compared with ${prev.file}: ${regressions.length ? `regressions: ${regressions.join(', ')}` : 'no regressions'}${fixes.length ? `; newly passing: ${fixes.join(', ')}` : ''}`);
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(RESULTS_DIR, `${stamp}-${safe(model)}.json`);
  await writeFile(file, JSON.stringify({ model, date: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`Saved ${path.relative(ROOT, file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
