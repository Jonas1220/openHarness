/**
 * In-browser stand-in for the Electron preload API, so the UI can be developed
 * and previewed with `vite` alone (open http://localhost:5173 in a browser).
 * It plays back a scripted agent run; nothing touches the filesystem or Ollama.
 */
import type { AgentEvent, DaemonDef, DaemonEvent, InboxItem, OhApi, PullProgress } from '../../shared/ipc';

const now = () => new Date().toISOString();
const agentListeners = new Set<(id: string, e: AgentEvent) => void>();
const daemonListeners = new Set<Parameters<OhApi['onDaemonEvent']>[0]>();
const pullListeners = new Set<(n: string, p: PullProgress) => void>();
const approvals = new Map<string, () => void>();

const daemons: DaemonDef[] = [
  {
    id: 'd1',
    name: 'Repo caretaker',
    emoji: '🧹',
    goal: 'Run the tests every morning and report failures.',
    model: 'qwen3:8b',
    cwd: '/Users/demo/projects/app',
    mode: 'full-auto',
    schedule: { kind: 'daily', time: '09:00' },
    enabled: true,
    createdAt: now(),
    lastRunAt: now(),
    lastStatus: 'ok',
    lastSummary: 'All 128 tests passed. No action needed.',
  },
];
const inbox: InboxItem[] = [
  { id: 'i1', daemonId: 'd1', kind: 'report', title: '2 tests failing after the last pull', body: '`auth.test.ts` fails because the token TTL changed from 3600 to 600. Likely fix: update the fixture.', createdAt: now(), read: false },
];

const emit = (id: string, e: AgentEvent) => agentListeners.forEach((l) => l(id, e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scriptedRun(id: string, text: string) {
  emit(id, { type: 'turn_start' });
  for (const w of 'Let me look at the project first.'.split(/(?= )/)) {
    emit(id, { type: 'assistant_delta', text: w });
    await wait(40);
  }
  emit(id, { type: 'assistant_message', message: { role: 'assistant', content: 'Let me look at the project first.', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] } });
  emit(id, { type: 'tool_call', call: { id: 'c1', name: 'list_dir', arguments: { path: '.' } }, summary: 'List .' });
  await wait(300);
  emit(id, { type: 'tool_result', callId: 'c1', name: 'list_dir', result: { output: 'src/\ntest/\npackage.json\nREADME.md' } });
  emit(id, { type: 'todos', todos: [{ content: 'Inspect project', status: 'completed' }, { content: `Handle: ${text.slice(0, 40)}`, status: 'in_progress' }, { content: 'Verify with tests', status: 'pending' }] });
  const call = { id: 'c2', name: 'edit_file', arguments: { path: 'README.md', old_string: '# App', new_string: '# App\n\nNow with setup notes.' } };
  emit(id, { type: 'assistant_message', message: { role: 'assistant', content: '', toolCalls: [call] } });
  emit(id, { type: 'tool_call', call, summary: 'Edit README.md' });
  emit(id, { type: 'approval_request', request: { id: 'c2', toolName: 'edit_file', summary: 'Edit README.md', args: call.arguments, reason: 'Edit file' } });
  await new Promise<void>((r) => approvals.set(`${id}:c2`, r));
  emit(id, { type: 'tool_result', callId: 'c2', name: 'edit_file', result: { output: 'Edited README.md (1 replacement).' } });
  emit(id, { type: 'usage', usage: { promptTokens: 5400, completionTokens: 300, contextWindow: 16384 } });
  const answer = 'Done. I added a **setup** section to `README.md`:\n\n```md\n# App\n\nNow with setup notes.\n```';
  emit(id, { type: 'assistant_delta', text: answer });
  emit(id, { type: 'assistant_message', message: { role: 'assistant', content: answer } });
  emit(id, { type: 'turn_end', reason: 'done' });
}

const state = () => ({ daemons, inbox, runningDaemons: [] as string[] });

const mock: OhApi = {
  init: async () => ({
    config: { ollamaHost: 'http://127.0.0.1:11434', defaultModel: 'qwen3:8b', mode: 'ask', maxContext: 16384, think: true, mcpServers: {} },
    ollamaVersion: '0.32.1',
    models: [
      { name: 'qwen3:8b', size: 5.2e9, parameterSize: '8.2B' },
      { name: 'qwen2.5:7b', size: 4.7e9, parameterSize: '7.6B' },
    ],
    sessions: [{ id: 's0', title: 'Explain the build setup', cwd: '/Users/demo/projects/app', model: 'qwen3:8b', mode: 'ask', createdAt: now(), updatedAt: now() }],
    daemons,
    runningDaemons: [],
    inbox,
    mcp: [],
    home: '/Users/demo',
  }),
  refreshModels: async () => ({ version: '0.32.1', models: [] }),
  pullModel: async (name) => {
    for (let i = 0; i <= 10; i++) {
      pullListeners.forEach((l) => l(name, { status: 'downloading', total: 100, completed: i * 10 }));
      await wait(150);
    }
  },
  saveConfig: async (c) => ({ ...(await mock.init()), config: c }),
  pickFolder: async () => '/Users/demo/projects/app',
  createSession: async (o) => ({ id: `s${Date.now()}`, title: 'New session', ...o, createdAt: now(), updatedAt: now(), messages: [], running: false }),
  openSession: async (id) => ({
    id,
    title: 'Explain the build setup',
    cwd: '/Users/demo/projects/app',
    model: 'qwen3:8b',
    mode: 'ask',
    createdAt: now(),
    updatedAt: now(),
    running: false,
    messages: [
      { role: 'user', content: 'Explain the build setup' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: { path: 'package.json' } }] },
      { role: 'tool', content: '{ "scripts": { "build": "vite build" } }', toolCallId: 'x', toolName: 'read_file' },
      { role: 'assistant', content: 'The project builds with **Vite** (`npm run build`).' },
    ],
  }),
  deleteSession: async () => [],
  listSessions: async () => (await mock.init()).sessions,
  send: async (id, text) => void scriptedRun(id, text),
  abort: async () => {},
  updateSession: async () => {},
  respondApproval: async (id, req) => approvals.get(`${id}:${req}`)?.(),
  compact: async () => 0,
  upsertDaemon: async (d) => {
    const def = { ...daemons[0]!, ...d, id: d.id ?? `d${Date.now()}` } as DaemonDef;
    const i = daemons.findIndex((x) => x.id === def.id);
    if (i >= 0) daemons[i] = def;
    else daemons.push(def);
    daemonListeners.forEach((l) => l({ type: 'daemons_changed' } as DaemonEvent, state()));
    return def;
  },
  removeDaemon: async () => {},
  runDaemon: async () => {},
  stopDaemon: async () => {},
  getDaemonMemory: async () => '## State\n- Tests green as of today\n\n## Next run\n- Check flaky e2e test',
  setDaemonMemory: async () => {},
  resolveInbox: async () => {},
  markInboxRead: async () => {},
  onAgentEvent: (cb) => (agentListeners.add(cb), () => agentListeners.delete(cb)),
  onDaemonEvent: (cb) => (daemonListeners.add(cb), () => daemonListeners.delete(cb)),
  onPullProgress: (cb) => (pullListeners.add(cb), () => pullListeners.delete(cb)),
};

window.oh = mock;
