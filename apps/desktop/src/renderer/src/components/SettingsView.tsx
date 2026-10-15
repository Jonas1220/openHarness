import { useEffect, useState } from 'react';
import { modelLabel } from '../models';
import type { Config, ModelInfo, PermissionMode, ProviderConfig, Skill } from '@openharness/core';
import type { McpServerView } from '../../../shared/ipc';
import { McpServerList } from './McpServerList';
import { MODES } from './ChatView';

const PRESETS: ProviderConfig[] = [
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  { id: 'jan', name: 'Jan', baseUrl: 'http://localhost:1337/v1' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
];

const SUGGESTED = ['qwen3:8b', 'qwen3:14b', 'qwen3-coder:30b', 'gpt-oss:20b', 'llama3.1:8b'];

export function SettingsView(p: {
  config: Config;
  models: ModelInfo[];
  mcp: McpServerView[];
  ollamaVersion: string | null;
  providerErrors: Record<string, string>;
  home: string;
  onSave: (c: Config) => Promise<void>;
  onRefreshModels: () => void;
}) {
  const [cfg, setCfg] = useState(p.config);
  const [mcpText, setMcpText] = useState(JSON.stringify(p.config.mcpServers, null, 2));
  const [mcpError, setMcpError] = useState('');
  const [servers, setServers] = useState(p.mcp);
  const [hooksText, setHooksText] = useState(JSON.stringify(p.config.hooks ?? {}, null, 2));
  const [hooksError, setHooksError] = useState('');
  const [userMemory, setUserMemory] = useState('');
  const [userMemoryDirty, setUserMemoryDirty] = useState(false);
  const [browserNote, setBrowserNote] = useState('');
  const [newProvider, setNewProvider] = useState<ProviderConfig>({ ...PRESETS[0]!, apiKey: '' });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => setServers(p.mcp), [p.mcp]);
  const [pullName, setPullName] = useState('');
  const [pull, setPull] = useState<{ name: string; status: string; pct?: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [memory, setMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);

  useEffect(() => {
    void window.oh.readInstructions(null).then(setMemory);
    void window.oh.listSkills(p.home).then(setSkills);
    void window.oh.readMemory('user', p.home).then(setUserMemory);
  }, []);

  useEffect(
    () =>
      window.oh.onPullProgress((name, prog) => {
        const pct = prog.total && prog.completed ? Math.round((prog.completed / prog.total) * 100) : undefined;
        setPull({ name, status: prog.status, pct });
      }),
    [],
  );

  const save = async () => {
    let mcpServers: Config['mcpServers'];
    try {
      mcpServers = JSON.parse(mcpText || '{}');
      setMcpError('');
    } catch (e) {
      setMcpError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    let hooks: Config['hooks'];
    try {
      hooks = JSON.parse(hooksText || '{}');
      setHooksError('');
    } catch (e) {
      setHooksError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    await p.onSave({ ...cfg, mcpServers, hooks });
    if (userMemoryDirty) {
      await window.oh.writeMemory('user', p.home, userMemory);
      setUserMemoryDirty(false);
    }
    if (memoryDirty) {
      await window.oh.writeInstructions(null, memory);
      setMemoryDirty(false);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const doPull = async (name: string) => {
    setPull({ name, status: 'starting' });
    try {
      await window.oh.pullModel(name);
      setPull({ name, status: 'done' });
      p.onRefreshModels();
    } catch (e) {
      setPull({ name, status: `failed: ${(e as Error).message}` });
    }
  };

  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">Settings</div>
        <div className="toolbar-controls">
          <button className="btn primary" onClick={save}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </header>
      <div className="page-body">
        <section className="form">
          <h3>Ollama</h3>
          <div className="row">
            <label className="field grow">
              <span>Server</span>
              <input value={cfg.ollamaHost} onChange={(e) => setCfg({ ...cfg, ollamaHost: e.target.value })} />
            </label>
            <div className="field">
              <span>Status</span>
              <div className={`pill ${p.ollamaVersion ? 'ok' : 'bad'}`}>{p.ollamaVersion ? `Connected · v${p.ollamaVersion}` : 'Not reachable'}</div>
            </div>
          </div>
          <div className="row">
            <label className="field grow">
              <span>Default model</span>
              <select value={cfg.defaultModel} onChange={(e) => setCfg({ ...cfg, defaultModel: e.target.value })}>
                {!p.models.some((m) => m.name === cfg.defaultModel) && <option value={cfg.defaultModel}>{modelLabel(cfg.defaultModel)}</option>}
                {p.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {modelLabel(m.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Context limit (tokens)</span>
              <input
                type="number"
                step={1024}
                min={0}
                placeholder="Model maximum"
                value={cfg.maxContext || ''}
                onChange={(e) => setCfg({ ...cfg, maxContext: e.target.value ? Math.max(2048, Number(e.target.value)) : 0 })}
              />
            </label>
            <label className="field toggle">
              <span>Thinking</span>
              <input type="checkbox" checked={cfg.think} onChange={(e) => setCfg({ ...cfg, think: e.target.checked })} />
            </label>
          </div>
          <p className="hint">
            By default every model uses its full context window. Set a limit if long chats get slow or your Mac runs low on memory: very large windows (e.g. 128k) can need several GB of extra RAM.
          </p>
          <label className="field">
            <span>Default permission mode</span>
            <select value={cfg.mode} onChange={(e) => setCfg({ ...cfg, mode: e.target.value as PermissionMode })}>
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="form">
          <h3>Models</h3>
          <ul className="models">
            {p.models.filter((m) => !m.provider).map((m) => (
              <li key={m.name}>
                <strong>{m.name}</strong>
                <span>
                  {m.parameterSize} · {(m.size / 1e9).toFixed(1)} GB
                </span>
              </li>
            ))}
            {!p.models.some((m) => !m.provider) && <li className="hint">No Ollama models installed.</li>}
          </ul>
          <div className="row">
            <input className="grow" placeholder="Model to download, e.g. qwen3:8b" value={pullName} onChange={(e) => setPullName(e.target.value)} />
            <button className="btn" disabled={!pullName.trim() || !!(pull && pull.status !== 'done' && !pull.status.startsWith('failed'))} onClick={() => doPull(pullName.trim())}>
              Download
            </button>
          </div>
          <div className="suggested">
            {SUGGESTED.filter((s) => !p.models.some((m) => m.name === s)).map((s) => (
              <button key={s} className="chip" onClick={() => setPullName(s)}>
                {s}
              </button>
            ))}
          </div>
          {pull && (
            <div className="pull">
              {pull.name}: {pull.status}
              {pull.pct !== undefined && (
                <span className="meter-bar wide">
                  <span style={{ width: `${pull.pct}%` }} />
                </span>
              )}
            </div>
          )}
        </section>

        <section className="form">
          <h3>Model providers</h3>
          <p className="hint">
            Besides Ollama, Open Harness can use any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, Jan, or OpenRouter for hosted models. Their models appear in every model menu as
            <code> model · provider</code>. Keys are stored in <code>~/.openharness/config.json</code> (readable only by you); write <code>env:NAME</code> to read a key from an environment variable instead.
          </p>
          <ul className="models">
            {cfg.providers.map((prov) => {
              const count = p.models.filter((m) => m.name.startsWith(`${prov.id}::`)).length;
              const error = p.providerErrors[prov.id];
              return (
                <li key={prov.id}>
                  <strong>{prov.name}</strong>
                  <span>{prov.baseUrl}</span>
                  <span className={`pill ${error ? 'bad' : count ? 'ok' : ''}`} title={error}>
                    {error ? 'Not reachable' : p.config.providers.some((x) => x.id === prov.id) ? `${count} model${count === 1 ? '' : 's'}` : 'Save to connect'}
                  </span>
                  <button className="link danger" onClick={() => setCfg({ ...cfg, providers: cfg.providers.filter((x) => x.id !== prov.id) })}>
                    Remove
                  </button>
                </li>
              );
            })}
            {!cfg.providers.length && <li className="hint">Only Ollama is set up.</li>}
          </ul>
          <div className="row">
            <label className="field">
              <span>Type</span>
              <select
                value={PRESETS.some((x) => x.id === newProvider.id) ? newProvider.id : 'custom'}
                onChange={(e) => {
                  const preset = PRESETS.find((x) => x.id === e.target.value);
                  setNewProvider(preset ? { ...preset, apiKey: '' } : { id: 'custom', name: 'Custom', baseUrl: 'http://localhost:8000/v1', apiKey: '' });
                }}
              >
                {PRESETS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
                <option value="custom">Other OpenAI-compatible server</option>
              </select>
            </label>
            <label className="field grow">
              <span>Base URL</span>
              <input value={newProvider.baseUrl} onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })} />
            </label>
            <label className="field grow">
              <span>API key {newProvider.id === 'openrouter' ? '' : '(optional)'}</span>
              <input type="password" value={newProvider.apiKey ?? ''} placeholder="sk-… or env:OPENROUTER_API_KEY" onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })} />
            </label>
            <button
              className="btn"
              disabled={!newProvider.baseUrl.trim()}
              onClick={() => {
                let id = newProvider.id === 'custom' ? 'custom' : newProvider.id;
                for (let n = 2; cfg.providers.some((x) => x.id === id); n++) id = `${newProvider.id}${n}`;
                setCfg({ ...cfg, providers: [...cfg.providers, { ...newProvider, id, apiKey: newProvider.apiKey?.trim() || undefined }] });
              }}
            >
              Add
            </button>
          </div>
        </section>

        <section className="form">
          <h3>Global instructions</h3>
          <p className="hint">
            Saved to <code>~/.openharness/AGENTS.md</code> and given to every chat and daemon: your preferences, conventions, and facts about you.
          </p>
          <textarea
            className="memory"
            rows={8}
            value={memory}
            placeholder="- I prefer TypeScript and pnpm&#10;- Always run the tests before saying something works"
            onChange={(e) => {
              setMemory(e.target.value);
              setMemoryDirty(true);
            }}
          />
        </section>

        <section className="form">
          <h3>Memory</h3>
          <p className="hint">
            Facts the agent saved about you with its <code>remember</code> tool. They're shown to the agent in every chat; edit or delete them here. Facts about a single project are on its project page.
          </p>
          <textarea
            className="memory"
            rows={6}
            value={userMemory}
            placeholder="Nothing saved yet."
            onChange={(e) => {
              setUserMemory(e.target.value);
              setUserMemoryDirty(true);
            }}
          />
        </section>

        <section className="form">
          <h3>Skills</h3>
          <p className="hint">
            Folders with a <code>SKILL.md</code> in <code>~/.openharness/skills</code>, <code>~/.agents/skills</code> or <code>~/.claude/skills</code>. Projects can add their own in <code>.agents/skills</code>.
          </p>
          <ul className="models">
            {skills.map((s) => (
              <li key={s.file}>
                <strong>{s.name}</strong>
                <span>{s.description.slice(0, 120)}</span>
              </li>
            ))}
            {!skills.length && <li className="hint">No global skills installed.</li>}
          </ul>
        </section>

        <section className="form">
          <div className="section-head">
            <h3>MCP servers</h3>
            <button
              className="btn"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  setServers(await window.oh.refreshMcp());
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <p className="hint">Use the MCP servers you already set up in other agents. They're read live, so changes you make there show up here after a refresh.</p>
          <div className="row import-sources">
            {(
              [
                ['claudeCode', 'Claude Code (incl. plugins)'],
                ['codex', 'Codex'],
                ['claudeDesktop', 'Claude Desktop'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="check">
                <input type="checkbox" checked={cfg.mcpImport[key]} onChange={(e) => setCfg({ ...cfg, mcpImport: { ...cfg.mcpImport, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </div>
          <div className="row">
            <label className="field grow">
              <span>Tool search</span>
              <select value={cfg.toolSearch} onChange={(e) => setCfg({ ...cfg, toolSearch: e.target.value as Config['toolSearch'] })}>
                <option value="auto">Automatic: load MCP tools on demand when there are more than 10</option>
                <option value="on">Always load MCP tools on demand</option>
                <option value="off">Always send every tool to the model</option>
              </select>
            </label>
            {!servers.some((s) => s.name === 'browser') && (
              <div className="field">
                <span>Browser control</span>
                <button
                  className="btn"
                  onClick={async () => {
                    const { state, browser } = await window.oh.addBrowserServer();
                    setServers(state.mcp);
                    setMcpText(JSON.stringify(state.config.mcpServers, null, 2));
                    const name = browser ? (browser.split('/').pop() ?? 'your browser') : 'Google Chrome';
                    setBrowserNote(
                      `Added the Playwright browser server. It opens ${name} with a fresh profile, so you're not logged in anywhere. The first start downloads it with npx, which takes a moment.`,
                    );
                  }}
                >
                  ＋ Add browser control
                </button>
              </div>
            )}
          </div>
          {browserNote && <p className="hint">{browserNote}</p>}
          <McpServerList
            servers={servers}
            empty="No MCP servers found. Add one below, or set some up in Claude Code or Codex."
            onToggle={async (id, enabled) => {
              const next = await window.oh.setMcpEnabled(id, enabled);
              setServers(next);
              setCfg((c) => ({ ...c, mcpDisabled: enabled ? c.mcpDisabled.filter((x) => x !== id) : [...c.mcpDisabled, id] }));
            }}
          />
          <p className="hint">
            Servers that need a browser sign-in (OAuth), like the claude.ai connectors, can't be shared yet. Project servers from a repository's <code>.mcp.json</code> are listed on the project page.
          </p>
          <details className="own-servers" open={Object.keys(p.config.mcpServers).length > 0}>
            <summary>Your own servers (JSON)</summary>
            <p className="hint">
              Same format as Claude Code's <code>mcpServers</code>: <code>{'{"name": {"command": "…", "args": []}}'}</code> or <code>{'{"name": {"type": "http", "url": "…"}}'}</code>. Add{' '}
              <code>"trustedTools": [...]</code> to skip approval for read-only tools.
            </p>
            <textarea className="code" rows={8} value={mcpText} onChange={(e) => setMcpText(e.target.value)} spellCheck={false} />
            {mcpError && <div className="notice error">{mcpError}</div>}
          </details>
        </section>

        <section className="form">
          <h3>Hooks</h3>
          <p className="hint">
            Shell commands that run on <code>PreToolUse</code>, <code>PostToolUse</code>, <code>UserPromptSubmit</code> and <code>Stop</code>, in the same format as Claude Code's hooks, so you
            can copy them from <code>~/.claude/settings.json</code>. The event arrives as JSON on stdin; exit code 2 blocks and sends stderr back to the agent. Matchers accept Claude Code tool
            names (<code>Bash</code>, <code>Edit</code>, <code>Write</code>…) and Open Harness names.
          </p>
          <textarea
            className="code"
            rows={8}
            value={hooksText}
            onChange={(e) => setHooksText(e.target.value)}
            spellCheck={false}
            placeholder={'{\n  "PostToolUse": [\n    { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npm run lint --silent" }] }\n  ]\n}'}
          />
          {hooksError && <div className="notice error">{hooksError}</div>}
        </section>
      </div>
    </div>
  );
}
