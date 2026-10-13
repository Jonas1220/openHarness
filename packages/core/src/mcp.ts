import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JsonSchema, Tool } from './types.ts';
import { truncate } from './tools/util.ts';

/** Same shape as the `mcpServers` entries used by Claude Desktop, Cursor and others. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /** Tools from this server that need no approval (read-only tools you trust). */
  trustedTools?: string[];
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'error' | 'disabled';
  error?: string;
  tools: string[];
}

/** Connects to configured MCP servers over stdio and exposes their tools as `mcp__<server>__<tool>`. */
export class McpManager {
  private clients = new Map<string, Client>();
  private tools: Tool[] = [];
  statuses: McpServerStatus[] = [];

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.close();
    const entries = Object.entries(servers);
    const results = await Promise.all(entries.map(([name, cfg]) => this.connectOne(name, cfg)));
    this.statuses = results;
  }

  private async connectOne(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    if (cfg.disabled) return { name, status: 'disabled', tools: [] };
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        cwd: cfg.cwd,
        stderr: 'ignore',
      });
      const client = new Client({ name: 'openharness', version: '0.1.0' });
      await withTimeout(client.connect(transport), 30_000, `MCP server "${name}" did not start within 30s`);
      const listed = await client.listTools();
      this.clients.set(name, client);
      const trusted = new Set(cfg.trustedTools ?? []);
      for (const t of listed.tools) {
        const fullName = `mcp__${sanitize(name)}__${sanitize(t.name)}`;
        this.tools.push({
          name: fullName,
          description: `[${name}] ${t.description ?? t.name}`.slice(0, 1024),
          parameters: (t.inputSchema as JsonSchema) ?? { type: 'object', properties: {} },
          // Annotations like readOnlyHint are only hints from the server, so approval is skipped only for tools the user trusted.
          kind: trusted.has(t.name) ? 'read' : 'external',
          describe: (a) => `${name} › ${t.name} ${JSON.stringify(a).slice(0, 120)}`,
          run: async (args, ctx) => {
            const res = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 300_000 });
            const parts = (res.content as { type: string; text?: string }[] | undefined) ?? [];
            const text = parts
              .map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`))
              .filter(Boolean)
              .join('\n');
            return { output: truncate(text || JSON.stringify(res.structuredContent ?? {}), 30_000), isError: res.isError === true };
          },
        });
      }
      return { name, status: 'connected', tools: listed.tools.map((t) => t.name) };
    } catch (err) {
      return { name, status: 'error', error: (err as Error).message, tools: [] };
    }
  }

  getTools(): Tool[] {
    return this.tools;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
    this.tools = [];
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
