import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, PermissionMode, Project, SessionMeta, Todo } from '@openharness/core';
import type { AppState, MenuAction, OpenSession } from '../../shared/ipc';
import { applyEvent, itemsFromMessages, newUserItem, uid, type ChatItem } from './chatItems';
import { ChangesPanel } from './components/ChangesPanel';
import { ChatView } from './components/ChatView';
import { DaemonView } from './components/DaemonView';
import { InboxView } from './components/InboxView';
import { ProjectView } from './components/ProjectView';
import { SettingsView } from './components/SettingsView';

type View =
  | { kind: 'chat'; sessionId: string | null }
  | { kind: 'project'; id: string }
  | { kind: 'daemon'; id: string | null }
  | { kind: 'inbox' }
  | { kind: 'settings' };

interface ChatState {
  id: string;
  title: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  projectId?: string;
  items: ChatItem[];
  todos: Todo[];
  running: boolean;
  usage: { used: number; window: number } | null;
  daemonId?: string;
  changed: Set<string>;
  changesVersion: number;
}

interface Draft {
  cwd: string;
  model: string;
  mode: PermissionMode;
  projectId?: string;
}

const LAST_CWD = 'oh:lastCwd';
const COLLAPSED = 'oh:collapsedProjects';
const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [view, setView] = useState<View>({ kind: 'chat', sessionId: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(storage.get(COLLAPSED) ?? '[]') as string[]));
  const [renaming, setRenaming] = useState<string | null>(null);
  const chats = useRef(new Map<string, ChatState>());
  const daemonRuns = useRef(new Map<string, string>());
  const searchRef = useRef<HTMLInputElement>(null);
  const appRef = useRef<AppState | null>(null);
  appRef.current = app;
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  useEffect(() => {
    void window.oh.init().then((s) => {
      setApp(s);
      setDraft(draftFor(s, null));
    });
  }, []);

  const refreshSessions = () => void window.oh.listSessions().then((sessions) => setApp((a) => (a ? { ...a, sessions } : a)));

  const handleEvent = useCallback((sessionId: string, e: AgentEvent) => {
    const chat = chats.current.get(sessionId);
    if (!chat) return;
    chat.items = applyEvent(chat.items, e);
    if (e.type === 'turn_start') chat.running = true;
    if (e.type === 'turn_end') {
      chat.running = false;
      chat.changesVersion++;
    }
    if (e.type === 'todos') chat.todos = e.todos;
    if (e.type === 'mode_changed') chat.mode = e.mode;
    if (e.type === 'checkpoint') {
      for (const f of Object.keys(e.checkpoint.files)) chat.changed.add(f);
      chat.changesVersion++;
    }
    if (e.type === 'tool_result' && (e.name === 'write_file' || e.name === 'edit_file')) chat.changesVersion++;
    if (e.type === 'usage') chat.usage = { used: e.usage.promptTokens + e.usage.completionTokens, window: e.usage.contextWindow };
    rerender();
    if (e.type === 'turn_end' && !chat.daemonId) refreshSessions();
  }, []);

  useEffect(() => window.oh.onAgentEvent(handleEvent), [handleEvent]);

  useEffect(
    () =>
      window.oh.onDaemonEvent((event, state) => {
        setApp((a) => (a ? { ...a, ...state } : a));
        if (event.type === 'run_started') {
          const d = state.daemons.find((x) => x.id === event.daemonId);
          daemonRuns.current.set(event.daemonId, event.sessionId);
          chats.current.set(event.sessionId, {
            ...emptyChat(event.sessionId),
            title: `${d?.emoji ?? ''} ${d?.name ?? 'Daemon'} · live run`,
            cwd: d?.cwd ?? '',
            model: d?.model ?? '',
            mode: d?.mode ?? 'ask',
            running: true,
            daemonId: event.daemonId,
          });
        }
        if (event.type === 'run_event') handleEvent(event.sessionId, event.event);
        if (event.type === 'run_finished') daemonRuns.current.delete(event.daemonId);
      }),
    [handleEvent],
  );

  const openSession = async (id: string) => {
    if (!chats.current.has(id)) {
      const s = await window.oh.openSession(id);
      if (!s) return;
      chats.current.set(id, fromSession(s));
    }
    setShowChanges(false);
    setView({ kind: 'chat', sessionId: id });
  };

  const newChat = (project?: Project | null) => {
    const a = appRef.current;
    if (a) setDraft(draftFor(a, project ?? null));
    setShowChanges(false);
    setView({ kind: 'chat', sessionId: null });
  };

  const addProject = async () => {
    const folder = await window.oh.pickFolder();
    if (!folder) return;
    const projects = await window.oh.upsertProject({ path: folder });
    setApp((a) => (a ? { ...a, projects } : a));
    const p = projects.find((x) => x.path === folder);
    if (p) newChat(p);
  };

  // Keyboard shortcuts arrive from the app menu.
  useEffect(
    () =>
      window.oh.onMenu((action: MenuAction) => {
        if (action === 'new-chat') newChat(currentProject());
        if (action === 'settings') setView({ kind: 'settings' });
        if (action === 'add-project') void addProject();
        if (action === 'focus-search') searchRef.current?.focus();
        if (action === 'toggle-plan') togglePlan();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, draft],
  );

  if (!app || !draft) return <div className="loading">◎</div>;

  const current = view.kind === 'chat' && view.sessionId ? chats.current.get(view.sessionId) : null;
  const unread = app.inbox.filter((i) => !i.read).length;
  const pendingApprovals = app.inbox.filter((i) => i.approval?.status === 'pending').length;
  const projectOf = (s: { projectId?: string; cwd: string }) => app.projects.find((p) => p.id === s.projectId) ?? app.projects.find((p) => p.path === s.cwd);
  const matches = (s: SessionMeta) => !search || s.title.toLowerCase().includes(search.toLowerCase());
  const looseSessions = app.sessions.filter((s) => !projectOf(s) && matches(s));

  function currentProject(): Project | null {
    const a = appRef.current;
    if (!a) return null;
    if (view.kind === 'project') return a.projects.find((p) => p.id === view.id) ?? null;
    const c = view.kind === 'chat' && view.sessionId ? chats.current.get(view.sessionId) : null;
    const ref = c ?? draft;
    return ref ? (a.projects.find((p) => p.id === ref.projectId) ?? a.projects.find((p) => p.path === ref.cwd) ?? null) : null;
  }

  function togglePlan() {
    const c = view.kind === 'chat' && view.sessionId ? chats.current.get(view.sessionId) : null;
    const target = c ?? draft;
    if (!target) return;
    const next: PermissionMode = target.mode === 'plan' ? (appRef.current?.config.mode ?? 'ask') : 'plan';
    setMode(next);
  }

  function setMode(mode: PermissionMode) {
    if (current) {
      current.mode = mode;
      void window.oh.updateSession(current.id, { mode });
      rerender();
    } else setDraft((d) => (d ? { ...d, mode } : d));
  }

  const send = async (text: string, opts?: { images?: string[]; display?: string }) => {
    let id = view.kind === 'chat' ? view.sessionId : null;
    if (!id) {
      const s = await window.oh.createSession(draft);
      chats.current.set(s.id, fromSession(s));
      id = s.id;
      setView({ kind: 'chat', sessionId: id });
    }
    const chat = chats.current.get(id)!;
    const messageId = uid();
    chat.items = [...chat.items, newUserItem(opts?.display ?? text, messageId, opts?.images)];
    chat.running = true;
    if (chat.title === 'New session') chat.title = (opts?.display ?? text).split('\n')[0]!.slice(0, 60);
    rerender();
    try {
      await window.oh.send(id, text, { images: opts?.images, id: messageId });
    } catch (e) {
      chat.running = false;
      chat.items = [...chat.items, { kind: 'notice', id: uid(), text: (e as Error).message, tone: 'error' }];
      rerender();
    }
  };

  const rewind = async (messageId: string) => {
    if (!current) return;
    const files = current.changed.size;
    const ok = confirm(
      `Rewind to before this message?\n\nThe message and everything after it will be removed${files ? ', and files the agent changed since then will be restored' : ''}. Changes made by shell commands are not undone.`,
    );
    if (!ok) return;
    const { session } = await window.oh.rewind(current.id, messageId, { code: true, conversation: true });
    chats.current.set(current.id, { ...fromSession(session), changesVersion: current.changesVersion + 1 });
    rerender();
    refreshSessions();
  };

  const sessionRow = (s: SessionMeta, indent = false) => {
    const active = view.kind === 'chat' && view.sessionId === s.id;
    return (
      <div key={s.id} className={`nav-item session ${indent ? 'indent' : ''} ${active ? 'active' : ''}`}>
        {renaming === s.id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={s.title}
            onBlur={() => setRenaming(null)}
            onKeyDown={async (e) => {
              if (e.key === 'Escape') setRenaming(null);
              if (e.key === 'Enter') {
                const title = e.currentTarget.value;
                const sessions = await window.oh.renameSession(s.id, title);
                const c = chats.current.get(s.id);
                if (c) c.title = title;
                setApp({ ...app, sessions });
                setRenaming(null);
              }
            }}
          />
        ) : (
          <button
            className="nav-text"
            onClick={() => void openSession(s.id)}
            onDoubleClick={() => setRenaming(s.id)}
            title={`${s.title}\n${s.cwd}\n${new Date(s.updatedAt).toLocaleString()}\nDouble-click to rename`}
          >
            {chats.current.get(s.id)?.running && <span className="status-dot running" />} {s.title}
          </button>
        )}
        <button
          className="nav-delete"
          title="Delete chat"
          onClick={async () => {
            if (!confirm(`Delete "${s.title}"?`)) return;
            const sessions = await window.oh.deleteSession(s.id);
            chats.current.delete(s.id);
            setApp({ ...app, sessions });
            if (active) newChat();
          }}
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="sidebar-top">
          <button className="new-chat" onClick={() => newChat(currentProject())} title="New chat (⌘N)">
            <span>＋</span> New chat
          </button>
          <input ref={searchRef} className="search" placeholder="Search chats  ⌘K" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <nav>
          <div className="nav-section grow">
            <div className="nav-label">
              Projects
              <button className="nav-add" title="Add project (⇧⌘O)" onClick={() => void addProject()}>
                ＋
              </button>
            </div>
            {app.projects.map((p) => {
              const projectSessions = app.sessions.filter((s) => projectOf(s)?.id === p.id && matches(s));
              const isCollapsed = collapsed.has(p.id) && !search;
              return (
                <div key={p.id} className="project">
                  <div className={`nav-item project-row ${view.kind === 'project' && view.id === p.id ? 'active' : ''}`}>
                    <button
                      className="caret"
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        setCollapsed(next);
                        storage.set(COLLAPSED, JSON.stringify([...next]));
                      }}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <button className="nav-text" onClick={() => setView({ kind: 'project', id: p.id })} title={p.path}>
                      {p.name}
                    </button>
                    <button className="nav-add" title={`New chat in ${p.name}`} onClick={() => newChat(p)}>
                      ＋
                    </button>
                  </div>
                  {!isCollapsed && projectSessions.slice(0, 8).map((s) => sessionRow(s, true))}
                  {!isCollapsed && projectSessions.length > 8 && (
                    <button className="nav-item indent muted" onClick={() => setView({ kind: 'project', id: p.id })}>
                      {projectSessions.length - 8} more…
                    </button>
                  )}
                </div>
              );
            })}
            {!app.projects.length && (
              <button className="nav-item muted" onClick={() => void addProject()}>
                Add a project folder…
              </button>
            )}

            {looseSessions.length > 0 && (
              <>
                <div className="nav-label spaced">Chats</div>
                {looseSessions.map((s) => sessionRow(s))}
              </>
            )}
          </div>

          <div className="nav-section">
            <div className="nav-label">
              Daemons
              <button className="nav-add" title="New daemon" onClick={() => setView({ kind: 'daemon', id: null })}>
                ＋
              </button>
            </div>
            {app.daemons.map((d) => (
              <button key={d.id} className={`nav-item ${view.kind === 'daemon' && view.id === d.id ? 'active' : ''}`} onClick={() => setView({ kind: 'daemon', id: d.id })}>
                <span className="nav-emoji">{d.emoji}</span>
                <span className="nav-text">{d.name}</span>
                <span className={`status-dot ${app.runningDaemons.includes(d.id) ? 'running' : !d.enabled ? 'disabled' : (d.lastStatus ?? 'idle')}`} />
              </button>
            ))}
            {!app.daemons.length && (
              <button className="nav-item muted" onClick={() => setView({ kind: 'daemon', id: null })}>
                Create an always-on agent…
              </button>
            )}
            <button className={`nav-item ${view.kind === 'inbox' ? 'active' : ''}`} onClick={() => setView({ kind: 'inbox' })}>
              <span className="nav-emoji">✉︎</span>
              <span className="nav-text">Inbox</span>
              {unread > 0 && <span className={`badge ${pendingApprovals ? 'pending' : ''}`}>{unread}</span>}
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <button className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
            <span className="nav-emoji">⚙︎</span>
            <span className="nav-text">Settings</span>
            <span className={`status-dot ${app.ollamaVersion ? 'ok' : 'error'}`} title={app.ollamaVersion ? `Ollama ${app.ollamaVersion}` : 'Ollama not reachable'} />
          </button>
        </div>
      </aside>

      <main className="main">
        {!app.ollamaVersion && view.kind !== 'settings' && (
          <div className="banner">
            Ollama isn't running at <code>{app.config.ollamaHost}</code>. Install it from <a href="https://ollama.com/download">ollama.com</a> and open it, then{' '}
            <button className="link" onClick={async () => setApp({ ...app, ...(await refresh()) })}>
              retry
            </button>
            .
          </div>
        )}
        {app.ollamaVersion && !app.models.length && view.kind === 'chat' && (
          <div className="banner">
            No models installed yet.{' '}
            <button className="link" onClick={() => setView({ kind: 'settings' })}>
              Download one in Settings
            </button>{' '}
            — <code>qwen3:8b</code> is a good start.
          </div>
        )}

        {view.kind === 'chat' && (
          <ChatView
            key={view.sessionId ?? 'draft'}
            title={current?.title ?? (draft.projectId ? `New chat · ${app.projects.find((p) => p.id === draft.projectId)?.name}` : 'New chat')}
            cwd={current?.cwd ?? draft.cwd}
            model={current?.model ?? draft.model}
            mode={current?.mode ?? draft.mode}
            models={app.models}
            items={current?.items ?? []}
            todos={current?.todos ?? []}
            running={current?.running ?? false}
            usage={current?.usage ?? null}
            canChangeFolder={!current}
            readOnlyTranscript={!!current?.daemonId}
            changedCount={current?.changed.size ?? 0}
            showChanges={showChanges && !!current}
            changesPanel={current && <ChangesPanel sessionId={current.id} version={current.changesVersion} onClose={() => setShowChanges(false)} />}
            onToggleChanges={() => setShowChanges(!showChanges)}
            onSend={send}
            onAbort={() => current && void window.oh.abort(current.id)}
            onApprove={(requestId, decision) => current && void window.oh.respondApproval(current.id, requestId, decision)}
            onModel={(model) => {
              if (current) {
                current.model = model;
                void window.oh.updateSession(current.id, { model });
                rerender();
              } else setDraft({ ...draft, model });
            }}
            onMode={setMode}
            onPickFolder={async () => {
              const f = await window.oh.pickFolder();
              if (f) {
                storage.set(LAST_CWD, f);
                const project = app.projects.find((p) => p.path === f);
                setDraft({ ...draft, cwd: f, projectId: project?.id });
              }
            }}
            onCompact={async () => {
              if (!current || current.running) return;
              current.running = true;
              rerender();
              try {
                await window.oh.compact(current.id);
              } finally {
                current.running = false;
                current.usage = null;
                rerender();
              }
            }}
            onClear={() => newChat(currentProject())}
            onRewind={rewind}
          />
        )}

        {view.kind === 'project' &&
          (() => {
            const project = app.projects.find((p) => p.id === view.id);
            if (!project) return null;
            return (
              <ProjectView
                key={project.id}
                project={project}
                models={app.models}
                sessions={app.sessions.filter((s) => projectOf(s)?.id === project.id)}
                onSave={async (p) => setApp({ ...app, projects: await window.oh.upsertProject(p) })}
                onRemove={async () => {
                  setApp({ ...app, projects: await window.oh.removeProject(project.id) });
                  newChat();
                }}
                onNewChat={() => newChat(project)}
                onOpenSession={(id) => void openSession(id)}
              />
            );
          })()}

        {view.kind === 'daemon' && (
          <DaemonView
            key={view.id ?? 'new'}
            daemon={app.daemons.find((d) => d.id === view.id) ?? null}
            defaults={{ model: pickModel(app), cwd: currentProject()?.path ?? storage.get(LAST_CWD) ?? app.home }}
            models={app.models}
            running={!!view.id && app.runningDaemons.includes(view.id)}
            inbox={app.inbox.filter((i) => i.daemonId === view.id)}
            onSave={async (d) => {
              const saved = await window.oh.upsertDaemon(d);
              setView({ kind: 'daemon', id: saved.id });
              return saved;
            }}
            onDelete={async (id) => {
              await window.oh.removeDaemon(id);
              newChat();
            }}
            onRun={(id, message) => void window.oh.runDaemon(id, message)}
            onStop={(id) => void window.oh.stopDaemon(id)}
            onOpenSession={(id) => void openSession(id)}
            onResolve={(itemId, allow) => void window.oh.resolveInbox(itemId, allow ? { kind: 'allow' } : { kind: 'deny' })}
            pickFolder={() => window.oh.pickFolder()}
            liveSessionId={view.id ? daemonRuns.current.get(view.id) : undefined}
          />
        )}

        {view.kind === 'inbox' && (
          <InboxView
            items={app.inbox}
            daemons={app.daemons}
            onOpenSession={(id) => void openSession(id)}
            onResolve={(itemId, allow) => void window.oh.resolveInbox(itemId, allow ? { kind: 'allow' } : { kind: 'deny' })}
          />
        )}

        {view.kind === 'settings' && (
          <SettingsView
            config={app.config}
            models={app.models}
            mcp={app.mcp}
            ollamaVersion={app.ollamaVersion}
            home={app.home}
            onSave={async (c) => setApp(await window.oh.saveConfig(c))}
            onRefreshModels={async () => setApp({ ...app, ...(await refresh()) })}
          />
        )}
      </main>
    </div>
  );
}

async function refresh(): Promise<Pick<AppState, 'ollamaVersion' | 'models'>> {
  const r = await window.oh.refreshModels();
  return { ollamaVersion: r.version, models: r.models };
}

function pickModel(s: AppState, preferred?: string): string {
  for (const m of [preferred, s.config.defaultModel]) if (m && s.models.some((x) => x.name === m)) return m;
  return s.models[0]?.name ?? s.config.defaultModel;
}

function draftFor(s: AppState, project: Project | null): Draft {
  if (project) return { cwd: project.path, projectId: project.id, model: pickModel(s, project.model), mode: project.mode ?? s.config.mode };
  return { cwd: storage.get(LAST_CWD) ?? s.home, model: pickModel(s), mode: s.config.mode };
}

function emptyChat(id: string): ChatState {
  return { id, title: '', cwd: '', model: '', mode: 'ask', items: [], todos: [], running: false, usage: null, changed: new Set(), changesVersion: 0 };
}

function fromSession(s: OpenSession): ChatState {
  return {
    ...emptyChat(s.id),
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    mode: s.mode,
    projectId: s.projectId,
    items: itemsFromMessages(s.messages),
    running: s.running,
    daemonId: s.daemonId,
    changed: new Set(s.changedFiles),
  };
}
