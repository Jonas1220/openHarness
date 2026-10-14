import { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '../../../shared/ipc';
import { diffLines, hunks } from '../diff';

/** Review pane for the files the agent changed in this chat, with per-file revert. */
export function ChangesPanel({ sessionId, version, onClose }: { sessionId: string; version: number; onClose: () => void }) {
  const [changes, setChanges] = useState<FileChange[] | null>(null);

  useEffect(() => {
    void window.oh.getChanges(sessionId).then(setChanges);
  }, [sessionId, version]);

  return (
    <aside className="changes">
      <header className="toolbar">
        <div className="toolbar-title">Changes</div>
        <div className="toolbar-controls">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <div className="changes-body">
        {changes === null && <p className="hint">Loading…</p>}
        {changes?.length === 0 && <p className="hint">No file changes in this chat (changes made by shell commands aren't tracked).</p>}
        {changes?.map((c) => (
          <FileDiff
            key={c.path}
            change={c}
            onReveal={() => void window.oh.revealPath(c.path)}
            onRevert={async () => {
              if (confirm(`Revert ${c.rel} to how it was before this chat?`)) setChanges(await window.oh.revertFile(sessionId, c.path));
            }}
          />
        ))}
      </div>
    </aside>
  );
}

function FileDiff({ change, onRevert, onReveal }: { change: FileChange; onRevert: () => void; onReveal: () => void }) {
  const [open, setOpen] = useState(true);
  const lines = useMemo(() => hunks(diffLines(change.before ?? '', change.after ?? '')), [change]);
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  const status = change.before === null ? 'new' : change.after === null ? 'deleted' : 'modified';

  return (
    <div className="file-diff">
      <div className="file-diff-head">
        <button className="link file-name" onClick={() => setOpen(!open)} title={change.path}>
          {open ? '▾' : '▸'} {change.rel}
        </button>
        <span className={`badge-lite ${status}`}>{status}</span>
        <span className="diff-stat">
          <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
        </span>
        <button className="link" onClick={onReveal}>
          Reveal
        </button>
        <button className="link danger" onClick={onRevert}>
          Revert
        </button>
      </div>
      {open && (
        <pre className="diff-view">
          {lines.map((l, i) =>
            l.type === 'gap' ? (
              <div key={i} className="gap">
                ⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div key={i} className={l.type}>
                <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                {l.text || ' '}
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  );
}
