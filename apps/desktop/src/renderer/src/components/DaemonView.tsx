import { useEffect, useState } from 'react';
import type { DaemonDef, DaemonSchedule, InboxItem, ModelInfo, PermissionMode } from '@openharness/core';
import { MODES } from './ChatView';
import { InboxList } from './InboxView';

type Draft = Partial<DaemonDef> & Pick<DaemonDef, 'name' | 'goal' | 'model' | 'cwd'>;

const EMOJIS = ['✦', '🛰️', '🔭', '🧹', '📰', '🧪', '🐛', '📈', '🛡️', '📬'];

export const DAEMON_TEMPLATES: { title: string; emoji: string; goal: string; schedule: DaemonSchedule; mode: PermissionMode }[] = [
  {
    title: 'Repo caretaker',
    emoji: '🧹',
    goal: 'Keep this repository healthy. Each run: pull the latest changes if it is a git repo, run the test suite, and if something fails, find the cause. Report failures with the likely fix. Do not commit or push.',
    schedule: { kind: 'daily', time: '09:00' },
    mode: 'full-auto',
  },
  {
    title: 'Release watcher',
    emoji: '🔭',
    goal: 'Watch https://github.com/ollama/ollama/releases for new releases. When a new version appears that is not in your memory, report the highlights that matter for running local models. Keep the last seen version in memory.',
    schedule: { kind: 'interval', minutes: 360 },
    mode: 'auto-edit',
  },
  {
    title: 'TODO miner',
    emoji: '🐛',
    goal: 'Scan this project for TODO and FIXME comments. Keep a prioritized list in TODO_REPORT.md in the workspace, and report when new high-priority items appear.',
    schedule: { kind: 'daily', time: '17:00' },
    mode: 'auto-edit',
  },
];

export function DaemonView(p: {
  daemon: DaemonDef | null;
  defaults: { model: string; cwd: string };
  models: ModelInfo[];
  running: boolean;
  inbox: InboxItem[];
  onSave: (d: Draft) => Promise<DaemonDef>;
  onDelete: (id: string) => void;
  onRun: (id: string, message?: string) => void;
  onStop: (id: string) => void;
  onOpenSession: (id: string) => void;
  onResolve: (itemId: string, allow: boolean) => void;
  pickFolder: () => Promise<string | null>;
  liveSessionId?: string;
}) {
  const blank: Draft = { name: '', goal: '', model: p.defaults.model, cwd: p.defaults.cwd, emoji: '✦', mode: 'auto-edit', schedule: { kind: 'interval', minutes: 60 }, enabled: true };
  const [draft, setDraft] = useState<Draft>(p.daemon ?? blank);
  const [memory, setMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(p.daemon ?? blank);
    setMemoryDirty(false);
    if (p.daemon) void window.oh.getDaemonMemory(p.daemon.id).then(setMemory);
    else setMemory('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.daemon?.id]);

  // Refresh memory after each run, unless the user is editing it.
  useEffect(() => {
    if (p.daemon && !p.running && !memoryDirty) void window.oh.getDaemonMemory(p.daemon.id).then(setMemory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.running, p.daemon?.lastRunAt]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const valid = draft.name.trim() && draft.goal.trim() && draft.model && draft.cwd;

  const save = async () => {
    const d = await p.onSave(draft);
    if (memoryDirty) {
      await window.oh.setDaemonMemory(d.id, memory);
      setMemoryDirty(false);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const schedule = draft.schedule ?? { kind: 'manual' };
  const live = p.daemon;

  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">{live ? `${live.emoji} ${live.name}` : 'New daemon'}</div>
        <div className="toolbar-controls">
          {live && p.running && p.liveSessionId && (
            <button className="btn" onClick={() => p.onOpenSession(p.liveSessionId!)}>
              Watch live
            </button>
          )}
          {live &&
            (p.running ? (
              <button className="btn" onClick={() => p.onStop(live.id)}>
                ■ Stop run
              </button>
            ) : (
              <button className="btn" onClick={() => p.onRun(live.id)}>
                ▶ Run now
              </button>
            ))}
          <button className="btn primary" disabled={!valid} onClick={save}>
            {saved ? 'Saved ✓' : live ? 'Save' : 'Create daemon'}
          </button>
        </div>
      </header>

      <div className="page-body">
        {!live && (
          <section className="templates">
            <h3>Start from a template</h3>
            <div className="template-grid">
              {DAEMON_TEMPLATES.map((t) => (
                <button
                  key={t.title}
                  className="template"
                  onClick={() => setDraft({ ...draft, name: t.title, emoji: t.emoji, goal: t.goal, schedule: t.schedule, mode: t.mode })}
                >
                  <span className="template-emoji">{t.emoji}</span>
                  <strong>{t.title}</strong>
                  <span>{t.goal.slice(0, 90)}…</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {live && (
          <section className="status-row">
            <span className={`status-dot ${p.running ? 'running' : live.lastStatus ?? 'idle'}`} />
            {p.running ? 'Running now…' : live.lastRunAt ? `Last run ${new Date(live.lastRunAt).toLocaleString()}` : 'Never run'}
            {live.lastSummary && !p.running && <div className="last-summary">{live.lastSummary}</div>}
          </section>
        )}

        <section className="form">
          <div className="row">
            <label className="field narrow">
              <span>Icon</span>
              <select value={draft.emoji} onChange={(e) => set('emoji', e.target.value)}>
                {EMOJIS.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>Name</span>
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Repo caretaker" />
            </label>
            <label className="field toggle">
              <span>Enabled</span>
              <input type="checkbox" checked={draft.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} />
            </label>
          </div>

          <label className="field">
            <span>Goal</span>
            <textarea
              rows={5}
              value={draft.goal}
              onChange={(e) => set('goal', e.target.value)}
              placeholder="What should this daemon keep working toward? Be specific about what to check, what to do, and when to report back."
            />
          </label>

          <div className="row">
            <label className="field grow">
              <span>Model</span>
              <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
                {!p.models.some((m) => m.name === draft.model) && <option>{draft.model}</option>}
                {p.models.map((m) => (
                  <option key={m.name}>{m.name}</option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>Workspace</span>
              <button
                className="input-like"
                onClick={async () => {
                  const f = await p.pickFolder();
                  if (f) set('cwd', f);
                }}
              >
                {draft.cwd}
              </button>
            </label>
          </div>

          <div className="row">
            <label className="field grow">
              <span>Permissions</span>
              <select value={draft.mode} onChange={(e) => set('mode', e.target.value as PermissionMode)}>
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Schedule</span>
              <select
                value={schedule.kind}
                onChange={(e) => {
                  const k = e.target.value as DaemonSchedule['kind'];
                  set('schedule', k === 'manual' ? { kind: 'manual' } : k === 'interval' ? { kind: 'interval', minutes: 60 } : { kind: 'daily', time: '09:00' });
                }}
              >
                <option value="manual">Manual only</option>
                <option value="interval">Every…</option>
                <option value="daily">Daily at…</option>
              </select>
            </label>
            {schedule.kind === 'interval' && (
              <label className="field narrow">
                <span>Minutes</span>
                <input type="number" min={5} value={schedule.minutes} onChange={(e) => set('schedule', { kind: 'interval', minutes: Math.max(5, Number(e.target.value)) })} />
              </label>
            )}
            {schedule.kind === 'daily' && (
              <label className="field narrow">
                <span>Time</span>
                <input type="time" value={schedule.time} onChange={(e) => set('schedule', { kind: 'daily', time: e.target.value })} />
              </label>
            )}
          </div>
          <p className="hint">
            {MODES.find((m) => m.id === draft.mode)?.hint} Approvals a daemon needs while you're away appear in its inbox and as a notification. They expire after 30 minutes.
          </p>
        </section>

        {live && (
          <>
            <section>
              <h3>Message {live.name}</h3>
              <div className="row">
                <input
                  className="grow"
                  value={message}
                  placeholder="Ask a question or give new instructions — starts a run"
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && message.trim() && !p.running) {
                      p.onRun(live.id, message.trim());
                      setMessage('');
                    }
                  }}
                />
                <button
                  className="btn"
                  disabled={!message.trim() || p.running}
                  onClick={() => {
                    p.onRun(live.id, message.trim());
                    setMessage('');
                  }}
                >
                  Send
                </button>
              </div>
            </section>

            <section>
              <h3>Memory</h3>
              <textarea
                className="memory"
                rows={8}
                value={memory}
                placeholder="The daemon writes its notes here between runs. You can edit them."
                onChange={(e) => {
                  setMemory(e.target.value);
                  setMemoryDirty(true);
                }}
              />
            </section>

            <section>
              <h3>Inbox</h3>
              <InboxList items={p.inbox} daemons={[live]} onOpenSession={p.onOpenSession} onResolve={p.onResolve} />
            </section>

            <section className="danger-zone">
              <button
                className="btn danger"
                onClick={() => {
                  if (confirm(`Delete ${live.name}? Its memory and inbox will be removed.`)) p.onDelete(live.id);
                }}
              >
                Delete daemon
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
