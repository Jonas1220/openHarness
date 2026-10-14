import type { McpServerView } from '../../../shared/ipc';

export const SOURCE_LABELS: Record<McpServerView['source'], string> = {
  openharness: 'Open Harness',
  'claude-code': 'Claude Code',
  'claude-plugin': 'Claude plugin',
  codex: 'Codex',
  'claude-desktop': 'Claude Desktop',
};

const STATUS_TEXT: Record<McpServerView['status'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
  'needs-auth': 'Needs sign-in',
  disabled: 'Off',
  shadowed: 'Duplicate',
  'needs-approval': 'Needs approval',
};

/** MCP servers with their source, status and an on/off switch. */
export function McpServerList(p: {
  servers: McpServerView[];
  onToggle: (id: string, enabled: boolean) => void;
  onApprove?: (id: string) => void;
  empty: string;
}) {
  if (!p.servers.length) return <p className="hint">{p.empty}</p>;
  return (
    <ul className="mcp-list">
      {p.servers.map((s) => {
        const on = s.status !== 'disabled' && s.status !== 'shadowed';
        const shadow = s.shadowedBy ? p.servers.find((x) => x.id === s.shadowedBy) : undefined;
        return (
          <li key={s.id} className={`mcp-server ${s.status}`}>
            <div className="mcp-main">
              <div className="mcp-title">
                <strong>{s.name}</strong>
                <span className={`source source-${s.source}`} title={s.origin}>
                  {SOURCE_LABELS[s.source]}
                </span>
                <span className={`pill ${s.status === 'connected' ? 'ok' : s.status === 'error' || s.status === 'needs-auth' ? 'bad' : ''}`}>
                  {s.status === 'connected' ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : STATUS_TEXT[s.status]}
                </span>
              </div>
              <code className="mcp-summary" title={s.summary}>
                {s.summary}
              </code>
              {s.error && <div className="mcp-error">{s.error}</div>}
              {s.status === 'shadowed' && <div className="hint">Same name as {shadow ? `${shadow.name} from ${SOURCE_LABELS[shadow.source]}` : 'another server'}, which is used instead.</div>}
              {s.disabledInSource && <div className="hint">Switched off in {SOURCE_LABELS[s.source]}. Turn it on there to use it.</div>}
              {s.status === 'connected' && s.tools.length > 0 && (
                <details className="mcp-tools">
                  <summary>Tools</summary>
                  {s.tools.join(', ')}
                </details>
              )}
            </div>
            {s.status === 'needs-approval' && p.onApprove ? (
              <button className="btn" onClick={() => p.onApprove!(s.id)} title="This server comes from the repository's .mcp.json. Only approve servers you trust.">
                Approve
              </button>
            ) : (
              !s.disabledInSource &&
              s.status !== 'shadowed' && (
                <label className="switch" title={on ? 'Turn off' : 'Turn on'}>
                  <input type="checkbox" checked={on} onChange={(e) => p.onToggle(s.id, e.target.checked)} />
                  <span />
                </label>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}
