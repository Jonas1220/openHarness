import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ModelInfo, PermissionMode, SlashCommand, Todo } from '@openharness/core';
import type { ChatItem } from '../chatItems';
import { Markdown } from './Markdown';

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'Explores and proposes a plan. Changes nothing until you approve.' },
  { id: 'read-only', label: 'Read only', hint: 'Reads and searches. Never edits.' },
  { id: 'ask', label: 'Ask', hint: 'Asks before every edit and command.' },
  { id: 'auto-edit', label: 'Auto edit', hint: 'Edits the workspace freely; asks before commands.' },
  { id: 'full-auto', label: 'Full auto', hint: 'No prompts. Commands are sandboxed: no network, no writes outside the workspace.' },
];

export interface ChatViewProps {
  title: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  models: ModelInfo[];
  items: ChatItem[];
  todos: Todo[];
  running: boolean;
  usage: { used: number; window: number } | null;
  canChangeFolder: boolean;
  readOnlyTranscript?: boolean;
  changedCount: number;
  showChanges: boolean;
  changesPanel?: React.ReactNode;
  onSend: (text: string, opts?: { images?: string[]; display?: string }) => void;
  onAbort: () => void;
  onApprove: (requestId: string, decision: ApprovalDecision) => void;
  onModel: (model: string) => void;
  onMode: (mode: PermissionMode) => void;
  onPickFolder: () => void;
  onCompact: () => void;
  onClear: () => void;
  onRewind: (messageId: string) => void;
  onToggleChanges: () => void;
  /** Present once the chat exists. */
  onFork?: () => void;
  onExport?: () => void;
}

export function ChatView(p: ChatViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.items]);

  const folderName = p.cwd.split('/').filter(Boolean).pop() ?? p.cwd;
  const lastUser = [...p.items].reverse().find((i) => i.kind === 'user');

  return (
    <div className="chat-wrap">
      <div className="chat">
        <header className="toolbar">
          <div className="toolbar-title" title={p.title}>
            {p.title}
          </div>
          <div className="toolbar-controls">
            <button className="chip" onClick={p.onPickFolder} disabled={!p.canChangeFolder} title={p.cwd}>
              <span className="chip-icon">▣</span> {folderName}
            </button>
            <select className="chip" value={p.model} onChange={(e) => p.onModel(e.target.value)} disabled={p.readOnlyTranscript}>
              {!p.models.some((m) => m.name === p.model) && <option value={p.model}>{p.model}</option>}
              {p.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <select
              className={`chip mode-${p.mode}`}
              value={p.mode}
              onChange={(e) => p.onMode(e.target.value as PermissionMode)}
              title={`${MODES.find((m) => m.id === p.mode)?.hint}\nShift+Tab in the composer cycles modes.`}
              disabled={p.readOnlyTranscript}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {p.usage && <ContextMeter used={p.usage.used} window={p.usage.window} onCompact={p.onCompact} />}
            {p.onFork && (
              <button className="chip icon" onClick={p.onFork} title="Fork: continue in a copy of this chat (/fork)">
                ⑂
              </button>
            )}
            {p.onExport && (
              <button className="chip icon" onClick={p.onExport} title="Export as Markdown (/export)">
                ⇩
              </button>
            )}
            {p.changedCount > 0 && (
              <button className={`chip ${p.showChanges ? 'on' : ''}`} onClick={p.onToggleChanges} title="Files changed in this chat">
                ± {p.changedCount}
              </button>
            )}
          </div>
        </header>

        <div
          className="transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {p.items.length === 0 && <EmptyState folder={p.cwd} model={p.model} mode={p.mode} />}
          {p.items.map((item) => (
            <Item
              key={item.id}
              item={item}
              onApprove={p.onApprove}
              onRewind={!p.running && !p.readOnlyTranscript ? p.onRewind : undefined}
            />
          ))}
          {p.running && !p.items.some((i) => i.kind === 'tool' && i.status === 'awaiting') && <Working />}
        </div>

        {p.todos.length > 0 && <TodoPanel todos={p.todos} />}
        {!p.readOnlyTranscript && (
          <Composer
            cwd={p.cwd}
            mode={p.mode}
            running={p.running}
            onSend={p.onSend}
            onAbort={p.onAbort}
            onCompact={p.onCompact}
            onClear={p.onClear}
            onMode={p.onMode}
            onRewindLast={() => lastUser && p.onRewind(lastUser.id)}
            onFork={p.onFork}
            onExport={p.onExport}
          />
        )}
      </div>
      {p.showChanges && p.changesPanel}
    </div>
  );
}

function EmptyState({ folder, model, mode }: { folder: string; model: string; mode: PermissionMode }) {
  return (
    <div className="empty">
      <div className="empty-logo">◎</div>
      <h2>What should we work on?</h2>
      <p>
        <code>{model}</code> will work in <code>{folder}</code>
        {mode === 'plan' ? ' and propose a plan first' : ''}.
      </p>
      <ul className="examples">
        <li>
          <code>/init</code> — write an AGENTS.md for this project
        </li>
        <li>
          <code>@file</code> — attach a file · paste an image for vision models
        </li>
        <li>
          <code>Shift+Tab</code> — switch to Plan mode for bigger changes
        </li>
      </ul>
    </div>
  );
}

function Working() {
  return (
    <div className="working">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

function Item({ item, onApprove, onRewind }: { item: ChatItem; onApprove: ChatViewProps['onApprove']; onRewind?: (id: string) => void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          {onRewind && (
            <button className="rewind" title="Rewind: undo this message and the file changes after it" onClick={() => onRewind(item.id)}>
              ↺
            </button>
          )}
          <div className="bubble">
            {item.images?.length ? (
              <div className="thumbs">
                {item.images.map((img, i) => (
                  <img key={i} src={`data:image/png;base64,${img}`} alt="" />
                ))}
              </div>
            ) : null}
            {item.text}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          {item.thinking && (
            <details className="thinking" open={item.streaming && !item.text}>
              <summary>{item.streaming && !item.text ? 'Thinking…' : 'Thought process'}</summary>
              <div className="thinking-body">{item.thinking}</div>
            </details>
          )}
          {item.text && <Markdown text={item.text} />}
        </div>
      );
    case 'tool':
      return item.name === 'propose_plan' ? <PlanCard item={item} onApprove={onApprove} /> : <ToolCard item={item} onApprove={onApprove} />;
    case 'notice':
      return <div className={`notice ${item.tone}`}>{item.text}</div>;
  }
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

function PlanCard({ item, onApprove }: { item: ToolItem; onApprove: ChatViewProps['onApprove'] }) {
  const [feedback, setFeedback] = useState('');
  const plan = typeof item.args.plan === 'string' ? item.args.plan : '';
  const awaiting = item.status === 'awaiting';
  return (
    <div className={`plan-card ${item.status}`}>
      <div className="plan-head">
        <span>📋 Plan</span>
        {!awaiting && <span className="plan-status">{item.status === 'denied' ? 'Revising' : 'Approved'}</span>}
      </div>
      <div className="plan-body">
        <Markdown text={plan} />
      </div>
      {awaiting && (
        <div className="approval">
          <div className="approval-actions">
            <button className="btn primary" onClick={() => onApprove(item.id, { kind: 'allow', mode: 'auto-edit' })}>
              Approve · auto edit
            </button>
            <button className="btn" onClick={() => onApprove(item.id, { kind: 'allow', mode: 'ask' })}>
              Approve · ask each step
            </button>
            <input
              className="feedback"
              placeholder="Or say what to change in the plan…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && feedback.trim()) onApprove(item.id, { kind: 'deny', feedback });
              }}
            />
            <button className="btn" disabled={!feedback.trim()} onClick={() => onApprove(item.id, { kind: 'deny', feedback })}>
              Revise
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCard({ item, onApprove }: { item: ToolItem; onApprove: ChatViewProps['onApprove'] }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const icon = { running: '◌', awaiting: '?', done: '✓', error: '✕', denied: '⊘' }[item.status];
  const diff = item.name === 'edit_file' ? (item.args as { old_string?: string; new_string?: string }) : null;
  const preview = item.name === 'write_file' && typeof item.args.content === 'string' ? item.args.content.slice(0, 4000) : null;

  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-icon ${item.status}`}>{icon}</span>
        <span className="tool-summary">{item.summary}</span>
        <span className="tool-name">{item.name === 'task' ? 'subagent' : item.name}</span>
      </button>
      {item.progress && item.progress.length > 0 && (item.status === 'running' || open) && (
        <ul className="subagent">
          {item.progress.slice(open ? 0 : -3).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {(open || item.status === 'awaiting') && (
        <div className="tool-body">
          {diff && (
            <div className="diff">
              <pre className="del">{diff.old_string}</pre>
              <pre className="add">{diff.new_string}</pre>
            </div>
          )}
          {preview !== null && <pre className="add">{preview}</pre>}
          {!diff && preview === null && item.name !== 'bash' && <pre>{JSON.stringify(item.args, null, 2)}</pre>}
          {item.output && (item.name === 'task' ? <Markdown text={item.output} /> : <pre className="output">{item.output}</pre>)}
        </div>
      )}
      {item.status === 'awaiting' && (
        <div className="approval">
          <div className="approval-reason">{item.reason ?? 'Approval needed'}</div>
          <div className="approval-actions">
            <button className="btn primary" onClick={() => onApprove(item.id, { kind: 'allow' })}>
              Allow
            </button>
            <button className="btn" onClick={() => onApprove(item.id, { kind: 'allow-session' })}>
              Allow for session
            </button>
            <input
              className="feedback"
              placeholder="Or tell it what to do instead…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onApprove(item.id, { kind: 'deny', feedback: feedback || undefined });
              }}
            />
            <button className="btn danger" onClick={() => onApprove(item.id, { kind: 'deny', feedback: feedback || undefined })}>
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TodoPanel({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <details className="todos" open>
      <summary>
        Tasks · {done}/{todos.length}
      </summary>
      <ul>
        {todos.map((t, i) => (
          <li key={i} className={t.status}>
            <span>{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'}</span> {t.content}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ContextMeter({ used, window, onCompact }: { used: number; window: number; onCompact: () => void }) {
  const pct = Math.min(100, Math.round((used / window) * 100));
  return (
    <button className="meter" onClick={onCompact} title={`${used.toLocaleString()} / ${window.toLocaleString()} tokens — click to compact`}>
      <span className="meter-bar">
        <span style={{ width: `${pct}%` }} className={pct > 75 ? 'hot' : ''} />
      </span>
      {pct}%
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer: slash commands, @file mentions, image attachments, Shift+Tab modes
// ---------------------------------------------------------------------------

type Suggestion = { label: string; detail?: string; insert: string };
type Popup = { kind: 'slash' | 'file'; items: Suggestion[]; index: number; start: number; end: number };

const MODE_CYCLE: PermissionMode[] = ['ask', 'auto-edit', 'full-auto', 'plan'];

function Composer(p: {
  cwd: string;
  mode: PermissionMode;
  running: boolean;
  onSend: ChatViewProps['onSend'];
  onAbort: () => void;
  onCompact: () => void;
  onClear: () => void;
  onMode: (m: PermissionMode) => void;
  onRewindLast: () => void;
  onFork?: () => void;
  onExport?: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileReq = useRef(0);

  useEffect(() => {
    void window.oh.listCommands(p.cwd).then(setCommands);
  }, [p.cwd]);

  const updatePopup = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash) {
      const q = slash[1]!.toLowerCase();
      const items = commands
        .filter((c) => c.name.toLowerCase().startsWith(q))
        .map((c) => ({ label: `/${c.name}`, detail: c.description, insert: `/${c.name} ` }));
      setPopup(items.length ? { kind: 'slash', items, index: 0, start: 0, end: caret } : null);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const query = at[2]!;
      const start = caret - query.length - 1;
      const req = ++fileReq.current;
      void window.oh.listFiles(p.cwd, query).then((files) => {
        if (req !== fileReq.current) return;
        const items = files.map((f) => ({ label: f, insert: `@${f} ` }));
        setPopup(items.length ? { kind: 'file', items, index: 0, start, end: caret } : null);
      });
      return;
    }
    fileReq.current++;
    setPopup(null);
  };

  const accept = (s: Suggestion) => {
    if (!popup) return;
    const next = text.slice(0, popup.start) + s.insert + text.slice(popup.end);
    setText(next);
    setPopup(null);
    const caret = popup.start + s.insert.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };

  const addImageFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => setImages((imgs) => [...imgs, String(reader.result).split(',')[1] ?? '']);
      reader.readAsDataURL(f);
    }
  };

  const submit = () => {
    const t = text.trim();
    if ((!t && !images.length) || p.running) return;
    setText('');
    setPopup(null);
    const imgs = images;
    setImages([]);

    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
    if (m) {
      const [, name, args] = m as unknown as [string, string, string];
      if (name === 'compact') return p.onCompact();
      if (name === 'clear') return p.onClear();
      if (name === 'rewind') return p.onRewindLast();
      if (name === 'fork') return p.onFork?.();
      if (name === 'export') return p.onExport?.();
      if (name === 'plan') {
        p.onMode('plan');
        if (args.trim()) p.onSend(args.trim(), { images: imgs });
        return;
      }
      const cmd = commands.find((c) => c.name === name && c.body);
      if (cmd) {
        const body = cmd.body!;
        const prompt = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args).trim() : `${body.trim()}\n\n${args}`.trim();
        return p.onSend(prompt, { images: imgs, display: t });
      }
    }
    p.onSend(t, { images: imgs });
  };

  return (
    <div className="composer-wrap">
      {popup && (
        <ul className="popup">
          {popup.items.map((s, i) => (
            <li
              key={s.label}
              className={i === popup.index ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
            >
              <span className="popup-label">{s.label}</span>
              {s.detail && <span className="popup-detail">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            addImageFiles(e.dataTransfer.files);
          }
        }}
      >
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div key={i} className="attachment">
                <img src={`data:image/png;base64,${img}`} alt="" />
                <button onClick={() => setImages(images.filter((_, k) => k !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={ref}
            rows={1}
            autoFocus
            placeholder={
              p.running ? 'Working… (Esc to stop)' : p.mode === 'plan' ? 'Describe what to plan…' : 'Ask Open Harness…  / for commands · @ for files'
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              updatePopup(e.target.value, e.target.selectionStart);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addImageFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (popup) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const d = e.key === 'ArrowDown' ? 1 : -1;
                  setPopup({ ...popup, index: (popup.index + d + popup.items.length) % popup.items.length });
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  accept(popup.items[popup.index]!);
                  return;
                }
                if (e.key === 'Escape') {
                  setPopup(null);
                  return;
                }
              }
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                const i = MODE_CYCLE.indexOf(p.mode);
                p.onMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape' && p.running) p.onAbort();
            }}
          />
          {p.running ? (
            <button className="send stop" onClick={p.onAbort} title="Stop">
              ■
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!text.trim() && !images.length} title="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
