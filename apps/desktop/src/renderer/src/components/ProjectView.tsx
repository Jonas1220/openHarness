import { useEffect, useState } from 'react';
import type { ModelInfo, PermissionMode, Project, SessionMeta, Skill } from '@openharness/core';
import type { McpServerView } from '../../../shared/ipc';
import { MODES } from './ChatView';
import { McpServerList } from './McpServerList';

/** Project settings: defaults for new chats, the project's AGENTS.md, skills, and its chats. */
export function ProjectView(p: {
  project: Project;
  models: ModelInfo[];
  sessions: SessionMeta[];
  onSave: (project: Project) => Promise<void>;
  onRemove: () => void;
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
}) {
  const [draft, setDraft] = useState(p.project);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [memory, setMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(p.project);
    setDirty(false);
    void window.oh.readInstructions(p.project.path).then(setInstructions);
    void window.oh.listSkills(p.project.path).then(setSkills);
    void window.oh.listMcp(p.project.path).then(setServers);
    void window.oh.readMemory('project', p.project.path).then(setMemory);
    setMemoryDirty(false);
  }, [p.project.id]);

  const save = async () => {
    await p.onSave(draft);
    if (dirty && instructions !== null) await window.oh.writeInstructions(p.project.path, instructions);
    if (memoryDirty) {
      await window.oh.writeMemory('project', p.project.path, memory);
      setMemoryDirty(false);
    }
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">▣ {p.project.name}</div>
        <div className="toolbar-controls">
          <button className="btn" onClick={p.onNewChat}>
            ＋ New chat
          </button>
          <button className="btn primary" onClick={save}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </header>
      <div className="page-body">
        <section className="form">
          <div className="row">
            <label className="field grow">
              <span>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="field grow">
              <span>Folder</span>
              <button className="input-like" onClick={() => void window.oh.revealPath(draft.path)} title="Reveal in Finder">
                {draft.path}
              </button>
            </label>
          </div>
          <div className="row">
            <label className="field grow">
              <span>Default model</span>
              <select value={draft.model ?? ''} onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}>
                <option value="">Use global default</option>
                {p.models.map((m) => (
                  <option key={m.name}>{m.name}</option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>Default mode</span>
              <select value={draft.mode ?? ''} onChange={(e) => setDraft({ ...draft, mode: (e.target.value || undefined) as PermissionMode | undefined })}>
                <option value="">Use global default</option>
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section>
          <h3>Instructions · AGENTS.md</h3>
          <p className="hint">Saved as AGENTS.md in the project folder. Every chat here reads it, and so do Codex and other agents. Ask for /init in a chat to generate one.</p>
          <textarea
            className="memory"
            rows={12}
            value={instructions ?? ''}
            placeholder="# Project notes for agents&#10;- How to build and test&#10;- Conventions to follow"
            onChange={(e) => {
              setInstructions(e.target.value);
              setDirty(true);
            }}
          />
        </section>

        <section>
          <h3>Memory</h3>
          <p className="hint">Facts the agent saved about this project. Unlike AGENTS.md, this stays on your Mac (in ~/.openharness) and isn't part of the repository.</p>
          <textarea
            className="memory"
            rows={6}
            value={memory}
            placeholder="Nothing saved yet."
            onChange={(e) => {
              setMemory(e.target.value);
              setMemoryDirty(true);
            }}
          />
        </section>

        <section>
          <h3>Skills</h3>
          {skills.length ? (
            <ul className="models">
              {skills.map((s) => (
                <li key={s.file}>
                  <strong>{s.name}</strong>
                  <span>{s.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              No skills found. Add folders with a <code>SKILL.md</code> to <code>.agents/skills/</code> in this project or <code>~/.openharness/skills/</code>.
            </p>
          )}
        </section>

        <section>
          <h3>Project MCP servers</h3>
          <p className="hint">
            From this folder's <code>.mcp.json</code> and Claude Code's per-project servers. They're only available in this project's chats. Your global servers are in Settings.
          </p>
          <McpServerList
            servers={servers}
            empty="This project has no MCP servers of its own."
            onToggle={async (id, enabled) => setServers(await window.oh.setMcpEnabled(id, enabled, p.project.path))}
            onApprove={async (id) => {
              if (confirm('Approve this MCP server? It will run on your Mac with your permissions. Only approve servers from repositories you trust.')) {
                setServers(await window.oh.approveProjectMcp(p.project.path, id));
              }
            }}
          />
        </section>

        <section>
          <h3>Chats</h3>
          {p.sessions.length ? (
            <ul className="models">
              {p.sessions.map((s) => (
                <li key={s.id}>
                  <button className="link" onClick={() => p.onOpenSession(s.id)}>
                    {s.title}
                  </button>
                  <span>{new Date(s.updatedAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No chats yet.</p>
          )}
        </section>

        <section className="danger-zone">
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Remove ${p.project.name} from Open Harness? Files and chats are kept.`)) p.onRemove();
            }}
          >
            Remove project
          </button>
        </section>
      </div>
    </div>
  );
}
