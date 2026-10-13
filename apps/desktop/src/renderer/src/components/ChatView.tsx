import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ModelInfo, PermissionMode, Todo } from '@openharness/core';
import type { ChatItem } from '../chatItems';
import { Markdown } from './Markdown';

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
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
  onSend: (text: string) => void;
  onAbort: () => void;
  onApprove: (requestId: string, decision: ApprovalDecision) => void;
  onModel: (model: string) => void;
  onMode: (mode: PermissionMode) => void;
  onPickFolder: () => void;
  onCompact: () => void;
}

export function ChatView(p: ChatViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.items]);

  const folderName = p.cwd.split('/').filter(Boolean).pop() ?? p.cwd;

  return (
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
            title={MODES.find((m) => m.id === p.mode)?.hint}
            disabled={p.readOnlyTranscript}
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {p.usage && <ContextMeter used={p.usage.used} window={p.usage.window} onCompact={p.onCompact} />}
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
        {p.items.length === 0 && <EmptyState folder={p.cwd} model={p.model} />}
        {p.items.map((item) => (
          <Item key={item.id} item={item} onApprove={p.onApprove} />
        ))}
        {p.running && !p.items.some((i) => i.kind === 'tool' && i.status === 'awaiting') && <Working />}
      </div>

      {p.todos.length > 0 && <TodoPanel todos={p.todos} />}
      {!p.readOnlyTranscript && <Composer running={p.running} onSend={p.onSend} onAbort={p.onAbort} onCompact={p.onCompact} />}
    </div>
  );
}

function EmptyState({ folder, model }: { folder: string; model: string }) {
  return (
    <div className="empty">
      <div className="empty-logo">◎</div>
      <h2>What should we work on?</h2>
      <p>
        <code>{model}</code> will work in <code>{folder}</code>.
      </p>
      <ul className="examples">
        <li>Explain how this project is structured</li>
        <li>Find and fix the failing test</li>
        <li>Add a README section describing the setup</li>
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

function Item({ item, onApprove }: { item: ChatItem; onApprove: ChatViewProps['onApprove'] }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
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
      return <ToolCard item={item} onApprove={onApprove} />;
    case 'notice':
      return <div className={`notice ${item.tone}`}>{item.text}</div>;
  }
}

function ToolCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'tool' }>; onApprove: ChatViewProps['onApprove'] }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const icon = { running: '◌', awaiting: '?', done: '✓', error: '✕', denied: '⊘' }[item.status];
  const diff = item.name === 'edit_file' ? (item.args as { old_string?: string; new_string?: string }) : null;
  const preview =
    item.name === 'write_file' && typeof item.args.content === 'string' ? item.args.content.slice(0, 4000) : null;

  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-icon ${item.status}`}>{icon}</span>
        <span className="tool-summary">{item.summary}</span>
        <span className="tool-name">{item.name}</span>
      </button>
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
          {item.output && <pre className="output">{item.output}</pre>}
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

function Composer({ running, onSend, onAbort, onCompact }: { running: boolean; onSend: (t: string) => void; onAbort: () => void; onCompact: () => void }) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || running) return;
    if (t === '/compact') onCompact();
    else onSend(t);
    setText('');
  };

  return (
    <div className="composer">
      <textarea
        rows={1}
        autoFocus
        placeholder={running ? 'Working… (Esc to stop)' : 'Ask openHarness to do something…  (/compact to free context)'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape' && running) onAbort();
        }}
      />
      {running ? (
        <button className="send stop" onClick={onAbort} title="Stop">
          ■
        </button>
      ) : (
        <button className="send" onClick={submit} disabled={!text.trim()} title="Send">
          ↑
        </button>
      )}
    </div>
  );
}
