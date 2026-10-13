import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, PermissionMode, Todo } from '@openharness/core';
import type { AppState, OpenSession } from '../../shared/ipc';
import { applyEvent, itemsFromMessages, newUserItem, type ChatItem } from './chatItems';
import { ChatView } from './components/ChatView';
import { DaemonView } from './components/DaemonView';
import { InboxView } from './components/InboxView';
import { SettingsView } from './components/SettingsView';

type View =
  | { kind: 'chat'; sessionId: string | null }
  | { kind: 'daemon'; id: string | null }
  | { kind: 'inbox' }
  | { kind: 'settings' };

interface ChatState {
  id: string;
  title: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  items: ChatItem[];
  todos: Todo[];
  running: boolean;
  usage: { used: number; window: number } | null;
  daemonId?: string;
}

const LAST_CWD = 'oh:lastCwd';
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
  const [draft, setDraft] = useState<{ cwd: string; model: string; mode: PermissionMode } | null>(null);
  const chats = useRef(new Map<string, ChatState>());
  const daemonRuns = useRef(new Map<string, string>());
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  useEffect(() => {
    void window.oh.init().then((s) => {
      setApp(s);
      setDraft({ cwd: storage.get(LAST_CWD) ?? s.home, model: pickModel(s), mode: s.config.mode });
    });
  }, []);

  const handleEvent = useCallback((sessionId: string, e: AgentEvent) => {
    const chat = chats.current.get(sessionId);
    if (!chat) return;
    chat.items = applyEvent(chat.items, e);
    if (e.type === 'turn_start') chat.running = true;
    if (e.type === 'turn_end') chat.running = false;
    if (e.type === 'todos') chat.todos = e.todos;
    if (e.type === 'usage') chat.usage = { used: e.usage.promptTokens + e.usage.completionTokens, window: e.usage.contextWindow };
    rerender();
    if (e.type === 'turn_end' && !chat.daemonId) void window.oh.listSessions().then((sessions) => setApp((a) => (a ? { ...a, sessions } : a)));
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
            id: event.sessionId,
            title: `${d?.emoji ?? ''} ${d?.name ?? 'Daemon'} · live run`,
            cwd: d?.cwd ?? '',
            model: d?.model ?? '',
            mode: d?.mode ?? 'ask',
            items: [],
            todos: [],
            running: true,
            usage: null,
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
    setView({ kind: 'chat', sessionId: id });
  };

  const newChat = () => {
    if (app) setDraft({ cwd: storage.get(LAST_CWD) ?? app.home, model: pickModel(app), mode: app.config.mode });
    setView({ kind: 'chat', sessionId: null });
  };

  const send = async (text: string) => {
    let id = view.kind === 'chat' ? view.sessionId : null;
    if (!id) {
      if (!draft) return;
      const s = await window.oh.createSession(draft);
      chats.current.set(s.id, fromSession(s));
      id = s.id;
      setView({ kind: 'chat', sessionId: id });
    }
    const chat = chats.current.get(id)!;
    chat.items = [...chat.items, newUserItem(text)];
    chat.running = true;
    if (chat.title === 'New session') chat.title = text.split('\n')[0]!.slice(0, 60);
    rerender();
    try {
      await window.oh.send(id, text);
    } catch (e) {
      chat.running = false;
      chat.items = [...chat.items, { kind: 'notice', id: `err${Date.now()}`, text: (e as Error).message, tone: 'error' }];
      rerender();
    }
  };

  if (!app || !draft) return <div className="loading">◎</div>;

  const current = view.kind === 'chat' && view.sessionId ? chats.current.get(view.sessionId) : null;
  const unread = app.inbox.filter((i) => !i.read).length;
  const pendingApprovals = app.inbox.filter((i) => i.approval?.status === 'pending').length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <button className="new-chat" onClick={newChat}>
          <span>＋</span> New chat
        </button>

        <nav>
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

          <div className="nav-section grow">
            <div className="nav-label">Chats</div>
            {app.sessions.map((s) => (
              <div key={s.id} className={`nav-item session ${view.kind === 'chat' && view.sessionId === s.id ? 'active' : ''}`}>
                <button className="nav-text" onClick={() => void openSession(s.id)} title={`${s.cwd}\n${new Date(s.updatedAt).toLocaleString()}`}>
                  {chats.current.get(s.id)?.running && <span className="status-dot running" />} {s.title}
                </button>
                <button
                  className="nav-delete"
                  title="Delete chat"
                  onClick={async () => {
                    const sessions = await window.oh.deleteSession(s.id);
                    chats.current.delete(s.id);
                    setApp({ ...app, sessions });
                    if (view.kind === 'chat' && view.sessionId === s.id) newChat();
                  }}
                >
                  ×
                </button>
              </div>
            ))}
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
            title={current?.title ?? 'New chat'}
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
            onMode={(mode) => {
              if (current) {
                current.mode = mode;
                void window.oh.updateSession(current.id, { mode });
                rerender();
              } else setDraft({ ...draft, mode });
            }}
            onPickFolder={async () => {
              const f = await window.oh.pickFolder();
              if (f) {
                storage.set(LAST_CWD, f);
                setDraft({ ...draft, cwd: f });
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
          />
        )}

        {view.kind === 'daemon' && (
          <DaemonView
            key={view.id ?? 'new'}
            daemon={app.daemons.find((d) => d.id === view.id) ?? null}
            defaults={{ model: pickModel(app), cwd: storage.get(LAST_CWD) ?? app.home }}
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

function pickModel(s: AppState): string {
  if (s.models.some((m) => m.name === s.config.defaultModel)) return s.config.defaultModel;
  return s.models[0]?.name ?? s.config.defaultModel;
}

function fromSession(s: OpenSession): ChatState {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    mode: s.mode,
    items: itemsFromMessages(s.messages),
    todos: [],
    running: s.running,
    usage: null,
    daemonId: s.daemonId,
  };
}
