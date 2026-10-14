import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpSource } from './mcpImport.ts';
import type { JsonSchema, Tool } from './types.ts';
import { truncate } from './tools/util.ts';

/** Same shape as the `mcpServers` entries used by Claude Code, Claude Desktop and Cursor. */
export interface McpServerConfig {
  /** stdio (default when `command` is set), or a remote server over streamable HTTP / SSE. */
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Tools from this server that need no approval (read-only tools you trust). */
  trustedTools?: string[];
}

export interface McpServerEntry {
  id: string;
  name: string;
  config: McpServerConfig;
  source?: McpSource;
  scope?: 'user' | 'project';
  origin?: string;
}

export type McpStatusKind = 'connecting' | 'connected' | 'error' | 'needs-auth' | 'disabled';

export interface McpServerStatus {
  id: string;
  name: string;
  status: McpStatusKind;
  error?: string;
  tools: string[];
}

interface Live {
  entry: McpServerEntry;
  key: string;
  client?: Client;
  tools: Tool[];
  status: McpServerStatus;
  ready: Promise<void>;
}

/**
 * Keeps connections to MCP servers and exposes their tools as `mcp__<server>__<tool>`.
 * `ensure` connects servers that aren't connected yet (or whose config changed);
 * `prune` disconnects the ones no longer wanted.
 */
export class McpManager {
  private live = new Map<string, Live>();

  /** Connect the given servers (in parallel) and wait until each has connected or failed. */
  async ensure(entries: McpServerEntry[]): Promise<void> {
    await Promise.all(entries.map((e) => this.ensureOne(e)));
  }

  private ensureOne(entry: McpServerEntry): Promise<void> {
    const key = JSON.stringify(entry.config);
    const existing = this.live.get(entry.id);
    if (existing && existing.key === key) return existing.ready;
    if (existing) void existing.client?.close().catch(() => {});

    const state: Live = {
      entry,
      key,
      tools: [],
      status: { id: entry.id, name: entry.name, status: 'connecting', tools: [] },
      ready: Promise.resolve(),
    };
    this.live.set(entry.id, state);
    if (entry.config.disabled) {
      state.status = { ...state.status, status: 'disabled' };
      return state.ready;
    }
    state.ready = this.connect(state);
    return state.ready;
  }

  private async connect(state: Live): Promise<void> {
    const { entry } = state;
    try {
      const client = await connectClient(entry.config, entry.name);
      // A newer ensure() may have replaced this connection while we were connecting.
      if (this.live.get(entry.id) !== state) {
        void client.close().catch(() => {});
        return;
      }
      const listed = await client.listTools();
      state.client = client;
      state.tools = listed.tools.map((t) => toTool(entry, client, t));
      state.status = { ...state.status, status: 'connected', tools: listed.tools.map((t) => t.name) };
    } catch (err) {
      const message = (err as Error).message;
      const auth = /\b401\b|unauthori[sz]ed|invalid_token|oauth/i.test(message);
      state.status = { ...state.status, status: auth ? 'needs-auth' : 'error', error: explain(message, entry.config, auth) };
    }
  }

  /** Disconnect every server whose id doesn't pass `keep`. */
  async prune(keep: (id: string) => boolean): Promise<void> {
    for (const [id, s] of this.live) {
      if (keep(id)) continue;
      this.live.delete(id);
      await s.client?.close().catch(() => {});
    }
  }

  /** Tools of connected servers, optionally limited to the given ids. */
  toolsFor(ids?: Iterable<string>): Tool[] {
    const wanted = ids ? new Set(ids) : null;
    return [...this.live.values()].filter((s) => !wanted || wanted.has(s.entry.id)).flatMap((s) => s.tools);
  }

  getTools(): Tool[] {
    return this.toolsFor();
  }

  status(id: string): McpServerStatus | undefined {
    return this.live.get(id)?.status;
  }

  get statuses(): McpServerStatus[] {
    return [...this.live.values()].map((s) => s.status);
  }

  async close(): Promise<void> {
    await this.prune(() => false);
  }
}

async function connectClient(cfg: McpServerConfig, name: string): Promise<Client> {
  const make = () => new Client({ name: 'open-harness', version: '0.1.0' });
  const type = cfg.type ?? (cfg.url ? 'http' : 'stdio');

  if (type === 'stdio') {
    if (!cfg.command) throw new Error('No command configured');
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      cwd: cfg.cwd,
      stderr: 'ignore',
    });
    return connectWithTimeout(make(), transport, name);
  }

  if (!cfg.url) throw new Error('No url configured');
  const url = new URL(cfg.url);
  const requestInit = { headers: cfg.headers ?? {} };
  if (type === 'sse') return connectWithTimeout(make(), new SSEClientTransport(url, { requestInit }), name);
  try {
    return await connectWithTimeout(make(), new StreamableHTTPClientTransport(url, { requestInit }), name);
  } catch (err) {
    // Older servers only speak the deprecated HTTP+SSE transport.
    if (/\b(404|405)\b/.test((err as Error).message)) {
      return connectWithTimeout(make(), new SSEClientTransport(url, { requestInit }), name);
    }
    throw err;
  }
}

async function connectWithTimeout(client: Client, transport: Transport, name: string): Promise<Client> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP server "${name}" did not respond within 30s`)), 30_000);
      }),
    ]);
    return client;
  } catch (err) {
    void client.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function toTool(
  entry: McpServerEntry,
  client: Client,
  t: { name: string; description?: string; inputSchema?: unknown },
): Tool {
  const trusted = new Set(entry.config.trustedTools ?? []);
  return {
    name: `mcp__${sanitize(entry.name)}__${sanitize(t.name)}`.slice(0, 64),
    description: `[${entry.name}] ${t.description ?? t.name}`.slice(0, 1024),
    parameters: (t.inputSchema as JsonSchema) ?? { type: 'object', properties: {} },
    // Annotations like readOnlyHint are only hints from the server, so approval is skipped only for tools the user trusted.
    kind: trusted.has(t.name) ? 'read' : 'external',
    describe: (a) => `${entry.name} › ${t.name} ${JSON.stringify(a).slice(0, 120)}`,
    run: async (args, ctx) => {
      const res = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 300_000 });
      const parts = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = parts
        .map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`))
        .filter(Boolean)
        .join('\n');
      return { output: truncate(text || JSON.stringify(res.structuredContent ?? {}), 30_000), isError: res.isError === true };
    },
  };
}

function explain(message: string, cfg: McpServerConfig, auth: boolean): string {
  if (auth) return 'This server requires signing in (OAuth), which Open Harness does not support yet.';
  if (/ENOENT/.test(message)) return `Command not found: ${cfg.command}`;
  if (/fetch failed|ECONNREFUSED/.test(message)) return `Could not reach ${cfg.url} — is the server running?`;
  return message;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Servers from discovery that should actually run: not disabled by the user, approved, and not shadowed. */
export function activeServers<T extends McpServerEntry & { needsApproval?: boolean; shadowedBy?: string }>(
  found: T[],
  disabledIds: string[] = [],
): T[] {
  return found.filter((s) => !s.shadowedBy && !s.needsApproval && !disabledIds.includes(s.id) && !s.config.disabled);
}
