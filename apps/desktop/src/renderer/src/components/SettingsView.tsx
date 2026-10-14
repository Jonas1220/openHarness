import { useEffect, useState } from 'react';
import type { Config, McpServerStatus, ModelInfo, PermissionMode, Skill } from '@openharness/core';
import { MODES } from './ChatView';

const SUGGESTED = ['qwen3:8b', 'qwen3:14b', 'qwen3-coder:30b', 'gpt-oss:20b', 'llama3.1:8b'];

export function SettingsView(p: {
  config: Config;
  models: ModelInfo[];
  mcp: McpServerStatus[];
  ollamaVersion: string | null;
  home: string;
  onSave: (c: Config) => Promise<void>;
  onRefreshModels: () => void;
}) {
  const [cfg, setCfg] = useState(p.config);
  const [mcpText, setMcpText] = useState(JSON.stringify(p.config.mcpServers, null, 2));
  const [mcpError, setMcpError] = useState('');
  const [pullName, setPullName] = useState('');
  const [pull, setPull] = useState<{ name: string; status: string; pct?: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [memory, setMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);

  useEffect(() => {
    void window.oh.readInstructions(null).then(setMemory);
    void window.oh.listSkills(p.home).then(setSkills);
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
    await p.onSave({ ...cfg, mcpServers });
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
                {!p.models.some((m) => m.name === cfg.defaultModel) && <option>{cfg.defaultModel}</option>}
                {p.models.map((m) => (
                  <option key={m.name}>{m.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Max context (tokens)</span>
              <input
                type="number"
                step={1024}
                min={2048}
                value={cfg.maxContext}
                onChange={(e) => setCfg({ ...cfg, maxContext: Math.max(2048, Number(e.target.value)) })}
              />
            </label>
            <label className="field toggle">
              <span>Thinking</span>
              <input type="checkbox" checked={cfg.think} onChange={(e) => setCfg({ ...cfg, think: e.target.checked })} />
            </label>
          </div>
          <p className="hint">Larger contexts use more memory. 16k–32k is a good range for 8B models on a 16 GB Mac.</p>
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
            {p.models.map((m) => (
              <li key={m.name}>
                <strong>{m.name}</strong>
                <span>
                  {m.parameterSize} · {(m.size / 1e9).toFixed(1)} GB
                </span>
              </li>
            ))}
            {!p.models.length && <li className="hint">No models installed.</li>}
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
          <h3>MCP servers</h3>
          <p className="hint">
            Same format as Claude Desktop's <code>mcpServers</code>. Add <code>"trustedTools": [...]</code> to skip approval for read-only tools.
          </p>
          <textarea className="code" rows={10} value={mcpText} onChange={(e) => setMcpText(e.target.value)} spellCheck={false} />
          {mcpError && <div className="notice error">{mcpError}</div>}
          <ul className="models">
            {p.mcp.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>
                <span className={`pill ${s.status === 'connected' ? 'ok' : s.status === 'error' ? 'bad' : ''}`}>
                  {s.status === 'connected' ? `${s.tools.length} tools` : s.status}
                </span>
                {s.error && <span className="hint">{s.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
