import type { DaemonDef, InboxItem } from '@openharness/core';
import { Markdown } from './Markdown';

export function InboxList(p: {
  items: InboxItem[];
  daemons: DaemonDef[];
  onOpenSession: (id: string) => void;
  onResolve: (itemId: string, allow: boolean) => void;
}) {
  if (!p.items.length) return <p className="hint">Nothing here yet.</p>;
  return (
    <ul className="inbox">
      {p.items.map((item) => {
        const d = p.daemons.find((x) => x.id === item.daemonId);
        const pending = item.approval?.status === 'pending';
        return (
          <li key={item.id} className={`inbox-item ${item.kind} ${item.read ? '' : 'unread'}`} onMouseEnter={() => !item.read && void window.oh.markInboxRead(item.id)}>
            <div className="inbox-head">
              <span className="inbox-from">
                {d?.emoji} {d?.name ?? 'Daemon'}
              </span>
              <span className="inbox-time">{new Date(item.createdAt).toLocaleString()}</span>
            </div>
            <div className="inbox-title">{item.title}</div>
            {item.body && item.kind !== 'approval' && <Markdown text={item.body} />}
            {item.approval && (
              <div className="approval">
                <pre>{JSON.stringify(item.approval.request.args, null, 2)}</pre>
                {pending ? (
                  <div className="approval-actions">
                    <button className="btn primary" onClick={() => p.onResolve(item.id, true)}>
                      Allow
                    </button>
                    <button className="btn danger" onClick={() => p.onResolve(item.id, false)}>
                      Deny
                    </button>
                  </div>
                ) : (
                  <span className={`badge ${item.approval.status}`}>{item.approval.status}</span>
                )}
              </div>
            )}
            {item.sessionId && (
              <button className="link" onClick={() => p.onOpenSession(item.sessionId!)}>
                View run transcript →
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function InboxView(p: Parameters<typeof InboxList>[0]) {
  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">Inbox</div>
      </header>
      <div className="page-body">
        <p className="hint">Reports and approval requests from your daemons.</p>
        <InboxList {...p} />
      </div>
    </div>
  );
}
