import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_SOURCES, McpManager, activeServers, discoverMcpServers, expandEnv } from '../src/index.ts';

const echoServer = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));

let home: string;
let project: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'oh-home-'));
  project = await mkdtemp(path.join(os.tmpdir(), 'oh-proj-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

const discover = (extra: Partial<Parameters<typeof discoverMcpServers>[0]> = {}) =>
  discoverMcpServers({ own: {}, sources: DEFAULT_IMPORT_SOURCES, home, ...extra });

describe('MCP import', () => {
  it('reads Codex config.toml, including disabled servers and bearer tokens from env', async () => {
    await mkdir(path.join(home, '.codex'));
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[mcp_servers.docs.env]
API_KEY = "k"

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "OH_TEST_TOKEN"

[mcp_servers.off]
command = "x"
enabled = false
`,
    );
    process.env.OH_TEST_TOKEN = 'secret';
    const found = await discover();
    const byName = Object.fromEntries(found.map((s) => [s.name, s]));
    expect(byName.docs!.config).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], env: { API_KEY: 'k' } });
    expect(byName.remote!.config).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer secret' } });
    expect(byName.off!.config.disabled).toBe(true);
    expect(activeServers(found).map((s) => s.name).sort()).toEqual(['docs', 'remote']);
  });

  it('reads Claude Code user, local and project servers, and respects .mcp.json approval', async () => {
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN:-none}' } } },
        projects: { [project]: { mcpServers: { db: { command: 'db-mcp' } }, enabledMcpjsonServers: ['approved'] } },
      }),
    );
    await writeFile(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { approved: { command: 'a' }, unknown: { command: 'b' } } }),
    );
    const found = await discover({ cwd: project });
    const byName = Object.fromEntries(found.map((s) => [s.name, s]));
    expect(byName.github!.config.headers!.Authorization).toBe('Bearer none');
    expect(byName.db!.scope).toBe('project');
    expect(byName.approved!.needsApproval).toBeUndefined();
    expect(byName.unknown!.needsApproval).toBe(true);
    expect(activeServers(found).map((s) => s.name).sort()).toEqual(['approved', 'db', 'github']);

    // Approving in Open Harness unlocks it.
    const again = await discover({ cwd: project, approved: [byName.unknown!.id] });
    expect(again.find((s) => s.name === 'unknown')!.needsApproval).toBeUndefined();
  });

  it('reads servers from enabled Claude Code plugins and resolves CLAUDE_PLUGIN_ROOT', async () => {
    const root = path.join(home, 'plugin-root');
    await mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
    await mkdir(root);
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { tool: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server' } } }));
    await writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'p@market': [{ installPath: root }], 'off@market': [{ installPath: root }] } }),
    );
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'p@market': true, 'off@market': false } }));
    const found = await discover();
    expect(found.filter((s) => s.source === 'claude-plugin')).toHaveLength(1);
    expect(found[0]!.config.command).toBe(`${root}/bin/server`);
  });

  it('prefers own servers over imported ones with the same name, and can turn sources off', async () => {
    await mkdir(path.join(home, '.codex'));
    await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.git]\ncommand = "codex-git"\n');
    const found = await discover({ own: { git: { command: 'my-git' } } });
    expect(activeServers(found).map((s) => s.config.command)).toEqual(['my-git']);
    expect(found.find((s) => s.source === 'codex')!.shadowedBy).toBe('openharness:git');
    const none = await discover({ sources: { claudeCode: false, codex: false, claudeDesktop: false } });
    expect(none).toHaveLength(0);
  });

  it('expands ${VAR} and ${VAR:-default}', () => {
    process.env.OH_X = 'x';
    expect(expandEnv('${OH_X}-${OH_MISSING:-d}-${OH_MISSING}')).toBe('x-d-');
  });
});

describe('MCP manager', () => {
  it('connects to a stdio server, calls its tools, and reports failures', async () => {
    const mcp = new McpManager();
    await mcp.ensure([
      { id: 'codex:echo', name: 'echo', config: { command: process.execPath, args: [echoServer], env: { ECHO_PREFIX: 'from-config' } } },
      { id: 'codex:missing', name: 'missing', config: { command: '/nonexistent/server' } },
    ]);
    expect(mcp.status('codex:echo')).toMatchObject({ status: 'connected', tools: ['echo'] });
    expect(mcp.status('codex:missing')).toMatchObject({ status: 'error', error: 'Command not found: /nonexistent/server' });

    const tool = mcp.toolsFor(['codex:echo'])[0]!;
    expect(tool.name).toBe('mcp__echo__echo');
    expect(tool.kind).toBe('external');
    const res = await tool.run(
      { text: 'hi' },
      { cwd: '/', callId: 'c', signal: new AbortController().signal, sandbox: { enabled: false, writableRoots: [], allowNetwork: true }, state: new Map(), emit: () => {} },
    );
    expect(res.output).toBe('echo: hi (from-config)');

    await mcp.prune((id) => id !== 'codex:echo');
    expect(mcp.getTools()).toHaveLength(0);
    await mcp.close();
  });
});
