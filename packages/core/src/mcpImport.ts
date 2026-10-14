import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { McpServerConfig } from './mcp.ts';

/**
 * Discovers MCP servers configured in other agents, so Open Harness can use them
 * without copying anything. The files are read live, so changes made in Claude Code
 * or Codex show up on the next refresh.
 *
 *   Claude Code     ~/.claude.json (user + per-project "local" servers), <project>/.mcp.json,
 *                   and MCP servers bundled with installed, enabled plugins
 *   Codex           ~/.codex/config.toml  [mcp_servers.<name>]
 *   Claude Desktop  ~/Library/Application Support/Claude/claude_desktop_config.json
 */

export type McpSource = 'openharness' | 'claude-code' | 'claude-plugin' | 'codex' | 'claude-desktop';

export interface DiscoveredServer {
  /** Stable key: `<source>:<name>` (plus the project path for project servers). */
  id: string;
  name: string;
  source: McpSource;
  /** user = available in every chat; project = only in chats in that folder. */
  scope: 'user' | 'project';
  /** File the server was read from. */
  origin: string;
  config: McpServerConfig;
  /** Project servers from a repo's .mcp.json must be approved before they run. */
  needsApproval?: boolean;
  /** Another source already defines a server with this name. */
  shadowedBy?: string;
}

export interface ImportSources {
  claudeCode: boolean;
  codex: boolean;
  claudeDesktop: boolean;
}

export const DEFAULT_IMPORT_SOURCES: ImportSources = { claudeCode: true, codex: true, claudeDesktop: true };

export const SOURCE_LABELS: Record<McpSource, string> = {
  openharness: 'Open Harness',
  'claude-code': 'Claude Code',
  'claude-plugin': 'Claude Code plugin',
  codex: 'Codex',
  'claude-desktop': 'Claude Desktop',
};

interface DiscoverOptions {
  own: Record<string, McpServerConfig>;
  sources: ImportSources;
  /** Include project-scoped servers for this folder. */
  cwd?: string;
  /** Project servers the user approved in Open Harness (ids). */
  approved?: string[];
  home?: string;
}

export async function discoverMcpServers(opts: DiscoverOptions): Promise<DiscoveredServer[]> {
  const home = opts.home ?? os.homedir();
  const found: DiscoveredServer[] = [];
  const add = (source: McpSource, scope: 'user' | 'project', origin: string, servers: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(servers ?? {})) {
      const config = source === 'codex' ? fromCodex(raw) : fromClaudeStyle(raw);
      if (!config) continue;
      const id = scope === 'project' ? `${source}:${opts.cwd}:${name}` : `${source}:${name}`;
      found.push({ id, name, source, scope, origin, config });
    }
  };

  add('openharness', 'user', 'config.json', opts.own as Record<string, unknown>);

  if (opts.sources.claudeCode) {
    const claudeJson = path.join(home, '.claude.json');
    const cc = await readJson<ClaudeJson>(claudeJson);
    if (cc?.mcpServers) add('claude-code', 'user', claudeJson, cc.mcpServers);
    await addClaudePlugins(home, add);
    if (opts.cwd) {
      const proj = cc?.projects?.[path.resolve(opts.cwd)];
      if (proj?.mcpServers) add('claude-code', 'project', claudeJson, proj.mcpServers);
      const mcpJson = path.join(opts.cwd, '.mcp.json');
      const shared = await readJson<{ mcpServers?: Record<string, unknown> }>(mcpJson);
      if (shared?.mcpServers) {
        const before = found.length;
        add('claude-code', 'project', mcpJson, shared.mcpServers);
        // A repo's .mcp.json can come from anyone: only run servers approved here or in Claude Code.
        for (const s of found.slice(before)) {
          const approvedInClaude =
            !proj?.disabledMcpjsonServers?.includes(s.name) && (proj?.enableAllProjectMcpServers || proj?.enabledMcpjsonServers?.includes(s.name));
          if (!approvedInClaude && !opts.approved?.includes(s.id)) s.needsApproval = true;
        }
      }
    }
  }

  if (opts.sources.codex) {
    const codexHome = (!opts.home && process.env.CODEX_HOME) || path.join(home, '.codex');
    const file = path.join(codexHome, 'config.toml');
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text) {
      try {
        const toml = parseToml(text) as { mcp_servers?: Record<string, unknown> };
        if (toml.mcp_servers) add('codex', 'user', file, toml.mcp_servers);
      } catch {
        /* malformed config: skip */
      }
    }
  }

  if (opts.sources.claudeDesktop) {
    const file = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const desktop = await readJson<{ mcpServers?: Record<string, unknown> }>(file);
    if (desktop?.mcpServers) add('claude-desktop', 'user', file, desktop.mcpServers);
  }

  // The same server name from several sources: the first one wins (own config, then
  // project, then Claude Code, plugins, Codex, Claude Desktop).
  const order: McpSource[] = ['openharness', 'claude-code', 'claude-plugin', 'codex', 'claude-desktop'];
  found.sort((a, b) => Number(b.scope === 'project') - Number(a.scope === 'project') || order.indexOf(a.source) - order.indexOf(b.source));
  const winner = new Map<string, DiscoveredServer>();
  for (const s of found) {
    const key = s.name.toLowerCase();
    const first = winner.get(key);
    if (first) s.shadowedBy = first.id;
    else winner.set(key, s);
  }
  return found;
}

interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, unknown>;
      enabledMcpjsonServers?: string[];
      disabledMcpjsonServers?: string[];
      enableAllProjectMcpServers?: boolean;
    }
  >;
}

/** MCP servers shipped by installed and enabled Claude Code plugins. */
async function addClaudePlugins(
  home: string,
  add: (source: McpSource, scope: 'user' | 'project', origin: string, servers: Record<string, unknown>) => void,
): Promise<void> {
  const installed = await readJson<{ plugins?: Record<string, { installPath?: string } | { installPath?: string }[]> }>(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
  );
  const settings = await readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(home, '.claude', 'settings.json'));
  for (const [id, entry] of Object.entries(installed?.plugins ?? {})) {
    if (settings?.enabledPlugins?.[id] === false) continue;
    const root = (Array.isArray(entry) ? entry[0] : entry)?.installPath;
    if (!root) continue;
    const mcpJson = path.join(root, '.mcp.json');
    const fromFile = await readJson<Record<string, unknown>>(mcpJson);
    const manifest = await readJson<{ mcpServers?: unknown }>(path.join(root, '.claude-plugin', 'plugin.json'));
    const servers = (fromFile?.mcpServers ?? fromFile ?? (typeof manifest?.mcpServers === 'object' ? manifest.mcpServers : null)) as Record<
      string,
      unknown
    > | null;
    if (!servers) continue;
    const withRoot = JSON.parse(JSON.stringify(servers).replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '\\\\'))) as Record<string, unknown>;
    add('claude-plugin', 'user', fromFile ? mcpJson : root, withRoot);
  }
}

/** Claude Code / Claude Desktop format: stdio { command, args, env } or remote { type, url, headers }. */
function fromClaudeStyle(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const env = stringMap(r.env);
  const expand = (v: string) => expandEnv(v, env);
  if (typeof r.url === 'string') {
    const type = r.type === 'sse' ? 'sse' : 'http';
    return {
      type,
      url: expand(r.url),
      headers: mapValues(stringMap(r.headers), expand),
      disabled: r.disabled === true,
    };
  }
  if (typeof r.command !== 'string') return null;
  return {
    type: 'stdio',
    command: expand(r.command),
    args: Array.isArray(r.args) ? r.args.map((a) => expand(String(a))) : [],
    env: mapValues(env, expand),
    cwd: typeof r.cwd === 'string' ? expand(r.cwd) : undefined,
    disabled: r.disabled === true,
  };
}

/** Codex format: see codex-rs/config/src/mcp_types.rs (RawMcpServerConfig). */
function fromCodex(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const disabled = r.enabled === false;
  if (typeof r.url === 'string') {
    const headers = stringMap(r.http_headers);
    for (const [header, envVar] of Object.entries(stringMap(r.env_http_headers))) {
      const value = process.env[envVar];
      if (value) headers[header] = value;
    }
    if (typeof r.bearer_token_env_var === 'string' && process.env[r.bearer_token_env_var]) {
      headers.Authorization = `Bearer ${process.env[r.bearer_token_env_var]}`;
    }
    return { type: 'http', url: r.url, headers, disabled };
  }
  if (typeof r.command !== 'string') return null;
  return {
    type: 'stdio',
    command: r.command,
    args: Array.isArray(r.args) ? r.args.map(String) : [],
    env: stringMap(r.env),
    cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    disabled,
  };
}

/** `${VAR}` and `${VAR:-default}`, as supported in Claude Code's .mcp.json. */
export function expandEnv(value: string, local: Record<string, string> = {}): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    return local[name] ?? process.env[name] ?? fallback ?? '';
  });
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
}

function mapValues(m: Record<string, string>, f: (v: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, f(v)]));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
