import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Agent,
  DaemonManager,
  McpManager,
  OllamaClient,
  ProjectStore,
  SessionStore,
  activeServers,
  dataDir,
  discoverMcpServers,
  fuzzyFilter,
  isInside,
  listWorkspaceFiles,
  loadCommands,
  loadConfig,
  loadSkills,
  readMemory,
  saveConfig,
  sessionToMarkdown,
  writeMemory,
  type MemoryScope,
  titleFrom,
  type ApprovalDecision,
  type Config,
  type DiscoveredServer,
  type Project,
  type Session,
} from '@openharness/core';
import { APP_NAME, CHANNELS, type AppState, type FileChange, type McpServerView, type MenuAction, type OpenSession } from '../shared/ipc';

app.setName(APP_NAME);

fixPath();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: Config;
let client: OllamaClient;
const mcp = new McpManager();
const sessions = new SessionStore();
const projects = new ProjectStore();
let daemons: DaemonManager;

/** Live agents for open sessions, plus approvals waiting on the UI. */
const live = new Map<string, { agent: Agent; session: Session }>();
const approvals = new Map<string, (d: ApprovalDecision) => void>();

/**
 * Apps launched from Finder get a minimal PATH, so tools like git, node or
 * Homebrew binaries are missing. Ask the user's login shell for the real PATH.
 */
function fixPath(): void {
  if (process.platform !== 'darwin') return;
  try {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shellPath, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    const p = out.split('__PATH__').pop()?.trim();
    if (p) process.env.PATH = p;
  } catch {
    process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function daemonState() {
  return {
    daemons: daemons.list(),
    inbox: daemons.getInbox(),
    runningDaemons: daemons.list().filter((d) => daemons.isRunning(d.id)).map((d) => d.id),
  };
}

async function appState(): Promise<AppState> {
  const version = await client.version();
  return {
    config,
    ollamaVersion: version,
    models: version ? await client.listModels().catch(() => []) : [],
    sessions: (await sessions.list()).filter((s) => !s.daemonId),
    projects: projects.list(),
    mcp: await mcpViews(),
    home: os.homedir(),
    ...daemonState(),
  };
}

async function getLive(id: string) {
  const existing = live.get(id);
  if (existing) return existing;
  const session = await sessions.load(id);
  if (!session) throw new Error(`Session ${id} not found`);
  return attach(session);
}

function attach(session: Session) {
  const agent = new Agent({
    client,
    model: session.model,
    cwd: session.cwd,
    mode: session.mode,
    maxContext: config.maxContext,
    think: config.think,
    hooks: config.hooks,
    toolSearch: config.toolSearch,
    sessionId: session.id,
    history: session.messages,
    checkpoints: session.checkpoints,
    extraTools: mcp.toolsFor(globalMcpIds),
    approve: (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvals.set(`${session.id}:${req.id}`, resolve);
        if (win && !win.isFocused() && Notification.isSupported()) {
          new Notification({ title: `${APP_NAME} needs approval`, body: req.summary }).show();
        }
      }),
  });
  agent.on((event) => {
    send(CHANNELS.agentEvent, session.id, event);
    if (event.type === 'mode_changed') session.mode = event.mode;
    if (event.type === 'turn_end' || event.type === 'mode_changed') void persist({ agent, session });
  });
  const entry = { agent, session };
  live.set(session.id, entry);
  void attachProjectMcp(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// MCP: own servers + servers imported from Claude Code, Codex and Claude Desktop
// ---------------------------------------------------------------------------

/** Ids of the user-scope servers every chat gets. */
let globalMcpIds: string[] = [];
/** Project-scope server ids per session. */
const sessionMcpIds = new Map<string, string[]>();

function projectFor(cwd: string): Project | undefined {
  return projects.findByPath(cwd);
}

async function discover(cwd?: string): Promise<DiscoveredServer[]> {
  return discoverMcpServers({ own: config.mcpServers, sources: config.mcpImport, cwd, approved: cwd ? projectFor(cwd)?.mcpApproved : undefined });
}

/** (Re)discover user-scope servers, connect what's new or changed, and update every live chat. */
async function refreshMcp(): Promise<void> {
  const active = activeServers(await discover(), config.mcpDisabled).filter((s) => s.scope === 'user');
  globalMcpIds = active.map((s) => s.id);
  await mcp.ensure(active);
  const inUse = new Set([...globalMcpIds, ...[...sessionMcpIds.values()].flat()]);
  await mcp.prune((id) => inUse.has(id));
  for (const entry of live.values()) await attachProjectMcp(entry);
}

/** Connect the project-scoped servers for a chat's folder and give the agent all its MCP tools. */
async function attachProjectMcp({ agent, session }: Live): Promise<void> {
  const found = await discover(session.cwd);
  const project = activeServers(found, config.mcpDisabled).filter((s) => s.scope === 'project');
  await mcp.ensure(project);
  sessionMcpIds.set(session.id, project.map((s) => s.id));
  agent.setExtraTools(mcp.toolsFor([...globalMcpIds, ...project.map((s) => s.id)]));
}

/** Discovered servers with live status, for the settings and project pages. Secrets are not sent to the UI. */
async function mcpViews(cwd?: string): Promise<McpServerView[]> {
  const found = await discover(cwd);
  return found
    .filter((s) => (cwd ? s.scope === 'project' : s.scope === 'user'))
    .map((s) => {
      const st = mcp.status(s.id);
      const disabled = config.mcpDisabled.includes(s.id) || !!s.config.disabled;
      return {
        id: s.id,
        name: s.name,
        source: s.source,
        scope: s.scope,
        origin: s.origin,
        summary: summarize(s),
        status: s.shadowedBy ? 'shadowed' : s.needsApproval ? 'needs-approval' : disabled ? 'disabled' : (st?.status ?? 'connecting'),
        error: st?.error,
        shadowedBy: s.shadowedBy,
        tools: st?.tools ?? [],
        disabledInSource: !!s.config.disabled,
      };
    });
}

/** Playwright drives Chrome by default; fall back to another installed Chromium-based browser. */
function findChromiumBrowser(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ];
  for (const c of candidates) if (existsSync(c)) return c.includes('Google Chrome') ? null : c;
  return null;
}

function summarize(s: DiscoveredServer): string {
  if (s.config.url) {
    try {
      const u = new URL(s.config.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return 'remote server';
    }
  }
  // Arguments can contain tokens: hide anything that looks like a secret.
  const args = (s.config.args ?? []).map((a, i, all) =>
    /^[A-Za-z0-9_\-]{24,}$/.test(a) || /(token|key|secret|password)/i.test(all[i - 1] ?? '') ? '•••' : a,
  );
  return [s.config.command, ...args].join(' ').slice(0, 160);
}

type Live = { agent: Agent; session: Session };

async function persist({ agent, session }: Live): Promise<void> {
  session.messages = agent.messages;
  session.checkpoints = agent.checkpoints.list;
  await sessions.save(session);
}

function toOpen({ agent, session }: Live): OpenSession {
  const { checkpoints: _checkpoints, ...rest } = session;
  return { ...rest, messages: agent.messages, running: agent.running, changedFiles: agent.checkpoints.changedFiles() };
}

async function readOrNull(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

async function changes({ agent, session }: Live): Promise<FileChange[]> {
  const out: FileChange[] = [];
  for (const file of agent.checkpoints.changedFiles()) {
    const before = agent.checkpoints.original(file) ?? null;
    const after = await readOrNull(file);
    if (before === after) continue;
    out.push({ path: file, rel: isInside(file, session.cwd) ? path.relative(session.cwd, file) : file, before, after });
  }
  return out;
}

/** Only ever touch a file called AGENTS.md: in a project folder, or the global one. */
function instructionsFile(dir: string | null): string {
  return path.join(dir ? path.resolve(dir) : dataDir(), 'AGENTS.md');
}

async function nonDaemonSessions() {
  return (await sessions.list()).filter((s) => !s.daemonId);
}

function registerIpc(): void {
  ipcMain.handle('init', () => appState());

  ipcMain.handle('refreshModels', async () => {
    const version = await client.version();
    return { version, models: version ? await client.listModels().catch(() => []) : [] };
  });

  ipcMain.handle('pullModel', async (_e, name: string) => {
    for await (const p of client.pull(name)) send(CHANNELS.pullProgress, name, p);
  });

  ipcMain.handle('saveConfig', async (_e, next: Config) => {
    config = next;
    await saveConfig(config);
    client = new OllamaClient(config.ollamaHost);
    for (const { agent } of live.values()) {
      agent.setOptions({ maxContext: config.maxContext, think: config.think, toolSearch: config.toolSearch });
      agent.setHooks(config.hooks);
    }
    await refreshMcp();
    return appState();
  });

  ipcMain.handle('listMcp', (_e, cwd?: string) => mcpViews(cwd));
  ipcMain.handle('refreshMcp', async (_e, cwd?: string) => {
    await refreshMcp();
    return mcpViews(cwd);
  });
  ipcMain.handle('setMcpEnabled', async (_e, id: string, enabled: boolean, cwd?: string) => {
    const disabled = new Set(config.mcpDisabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    config = { ...config, mcpDisabled: [...disabled] };
    await saveConfig(config);
    await refreshMcp();
    return mcpViews(cwd);
  });
  ipcMain.handle('approveProjectMcp', async (_e, cwd: string, id: string) => {
    const project = projectFor(cwd) ?? (await projects.upsert({ path: cwd }));
    await projects.upsert({ ...project, mcpApproved: [...new Set([...(project.mcpApproved ?? []), id])] });
    await refreshMcp();
    return mcpViews(cwd);
  });

  ipcMain.handle('pickFolder', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('revealPath', (_e, p: string) => shell.showItemInFolder(p));

  ipcMain.handle('upsertProject', async (_e, p: Partial<Project> & Pick<Project, 'path'>) => {
    await projects.upsert(p);
    return projects.list();
  });
  ipcMain.handle('removeProject', async (_e, id: string) => {
    await projects.remove(id);
    return projects.list();
  });

  ipcMain.handle('readInstructions', (_e, dir: string | null) => readOrNull(instructionsFile(dir)).then((t) => t ?? ''));
  ipcMain.handle('writeInstructions', async (_e, dir: string | null, content: string) => {
    const file = instructionsFile(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  });
  ipcMain.handle('listSkills', (_e, cwd: string) => loadSkills(cwd));
  ipcMain.handle('listCommands', (_e, cwd: string) => loadCommands(cwd));
  ipcMain.handle('listFiles', async (_e, cwd: string, query: string) => fuzzyFilter(await listWorkspaceFiles(cwd), query, 12));

  ipcMain.handle('createSession', async (_e, opts: { cwd: string; model: string; mode: Config['mode']; projectId?: string }) => {
    const session = sessions.create(opts);
    return toOpen(attach(session));
  });

  ipcMain.handle('forkSession', async (_e, id: string) => {
    const source = live.get(id);
    if (source) await persist(source);
    const fork = await sessions.fork(id);
    return fork ? toOpen(attach(fork)) : null;
  });

  ipcMain.handle('exportSession', async (_e, id: string) => {
    const entry = live.get(id);
    const session = entry ? { ...entry.session, messages: entry.agent.messages } : await sessions.load(id);
    if (!session) return null;
    const safe = session.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat';
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(os.homedir(), 'Downloads', `${safe}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, sessionToMarkdown(session), 'utf8');
    return res.filePath;
  });

  ipcMain.handle('readMemory', (_e, scope: MemoryScope, cwd: string) => readMemory(scope, cwd));
  ipcMain.handle('writeMemory', (_e, scope: MemoryScope, cwd: string, content: string) => writeMemory(scope, cwd, content));

  ipcMain.handle('addBrowserServer', async () => {
    const browser = findChromiumBrowser();
    // Screenshots and snapshots go to ~/.openharness/browser, not into whatever folder the server starts in.
    const args = ['-y', '@playwright/mcp@0.0.83', '--isolated', '--output-dir', path.join(dataDir(), 'browser')];
    if (browser) args.push('--executable-path', browser);
    config = {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        browser: {
          command: 'npx',
          args,
          // Looking at pages needs no approval; clicking, typing and running scripts still do.
          trustedTools: ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_console_messages', 'browser_network_requests', 'browser_tabs'],
        },
      },
    };
    await saveConfig(config);
    await refreshMcp();
    return { state: await appState(), browser };
  });

  ipcMain.handle('renameSession', async (_e, id: string, title: string) => {
    const entry = live.get(id);
    const session = entry?.session ?? (await sessions.load(id));
    if (session && title.trim()) {
      session.title = title.trim().slice(0, 120);
      if (entry) await persist(entry);
      else await sessions.save(session);
    }
    return nonDaemonSessions();
  });

  ipcMain.handle('rewind', async (_e, id: string, messageId: string, opts: { code: boolean; conversation: boolean }) => {
    const entry = await getLive(id);
    const restored = await entry.agent.rewind(messageId, opts);
    await persist(entry);
    return { restored, session: toOpen(entry) };
  });

  ipcMain.handle('getChanges', async (_e, id: string) => changes(await getLive(id)));
  ipcMain.handle('revertFile', async (_e, id: string, file: string) => {
    const entry = await getLive(id);
    await entry.agent.checkpoints.revertFile(file);
    return changes(entry);
  });

  ipcMain.handle('openSession', async (_e, id: string) => {
    try {
      return toOpen(await getLive(id));
    } catch {
      return null;
    }
  });

  ipcMain.handle('deleteSession', async (_e, id: string) => {
    live.get(id)?.agent.abort();
    live.delete(id);
    sessionMcpIds.delete(id);
    await sessions.delete(id);
    return nonDaemonSessions();
  });

  ipcMain.handle('listSessions', () => nonDaemonSessions());

  ipcMain.handle('send', async (_e, id: string, text: string, opts?: { images?: string[]; id?: string }) => {
    const entry = await getLive(id);
    if (entry.agent.running) throw new Error('The agent is still working. Stop it or wait for it to finish.');
    if (entry.session.title === 'New session') entry.session.title = titleFrom(text);
    // Persist immediately so the session appears in the sidebar.
    await persist(entry);
    void entry.agent.send(text, opts);
  });

  ipcMain.handle('abort', async (_e, id: string) => {
    live.get(id)?.agent.abort();
    for (const [key, resolve] of approvals) {
      if (key.startsWith(`${id}:`)) {
        resolve({ kind: 'deny' });
        approvals.delete(key);
      }
    }
  });

  ipcMain.handle('updateSession', async (_e, id: string, patch: { model?: string; mode?: Config['mode'] }) => {
    const { agent, session } = await getLive(id);
    if (patch.model) {
      agent.setModel(patch.model);
      session.model = patch.model;
    }
    if (patch.mode) {
      agent.setMode(patch.mode);
      session.mode = patch.mode;
    }
    await persist({ agent, session });
  });

  ipcMain.handle('respondApproval', async (_e, id: string, requestId: string, decision: ApprovalDecision) => {
    const key = `${id}:${requestId}`;
    approvals.get(key)?.(decision);
    approvals.delete(key);
  });

  ipcMain.handle('compact', async (_e, id: string) => {
    const { agent, session } = await getLive(id);
    const removed = await agent.compactNow();
    await persist({ agent, session });
    return removed;
  });

  ipcMain.handle('upsertDaemon', (_e, def) => daemons.upsert(def));
  ipcMain.handle('removeDaemon', (_e, id: string) => daemons.remove(id));
  ipcMain.handle('runDaemon', (_e, id: string, message?: string) => {
    void daemons.run(id, message);
  });
  ipcMain.handle('stopDaemon', (_e, id: string) => daemons.stopRun(id));
  ipcMain.handle('getDaemonMemory', (_e, id: string) => daemons.readMemory(id));
  ipcMain.handle('setDaemonMemory', (_e, id: string, content: string) => daemons.writeMemory(id, content));
  ipcMain.handle('resolveInbox', (_e, itemId: string, decision: ApprovalDecision) => daemons.resolveApproval(itemId, decision));
  ipcMain.handle('markInboxRead', (_e, itemId: string) => daemons.markRead(itemId));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

function updateTray(): void {
  const unread = daemons.getInbox().filter((i) => !i.read).length;
  const running = daemons.list().filter((d) => daemons.isRunning(d.id)).length;
  tray?.setTitle(unread ? ` ${unread}` : '');
  tray?.setToolTip(`${APP_NAME} — ${running} daemon${running === 1 ? '' : 's'} running`);
  app.dock?.setBadge(unread ? String(unread) : '');
}

function createTray(): void {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'), { scaleFactor: 2 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  );
  updateTray();
}

function menuAction(action: MenuAction): void {
  if (!win) createWindow();
  win?.show();
  send(CHANNELS.menu, action);
}

function createMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: APP_NAME,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => menuAction('settings') },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => menuAction('new-chat') },
          { label: 'Add Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => menuAction('add-project') },
          { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: () => menuAction('focus-search') },
          { type: 'separator' },
          { label: 'Toggle Plan Mode', accelerator: 'CmdOrCtrl+Shift+P', click: () => menuAction('toggle-plan') },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(async () => {
  config = await loadConfig();
  await projects.load();
  client = new OllamaClient(config.ollamaHost);
  daemons = new DaemonManager(() => client, sessions, {
    extraTools: () => mcp.toolsFor(globalMcpIds),
    maxContext: () => config.maxContext,
    agentOptions: () => ({ hooks: config.hooks, toolSearch: config.toolSearch, think: config.think }),
  });
  await daemons.load();
  daemons.on((event) => {
    send(CHANNELS.daemonEvent, event, daemonState());
    if (event.type === 'inbox_changed' && event.item && !event.item.read && Notification.isSupported()) {
      const d = daemons.list().find((x) => x.id === event.item!.daemonId);
      const n = new Notification({ title: `${d?.emoji ?? ''} ${d?.name ?? 'Daemon'}`.trim(), body: event.item.title });
      n.on('click', () => (win ? win.show() : createWindow()));
      n.show();
    }
    updateTray();
  });

  registerIpc();
  createMenu();
  createWindow();
  createTray();
  void refreshMcp();
  daemons.start();

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
});

// Keep running in the menu bar when the window closes so daemons keep working.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  daemons?.stop();
  for (const { agent } of live.values()) agent.abort();
  void mcp.close();
});

// Menu-bar template glyph (a ring with a dot), 32x32 px rendered at @2x.
const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABeUlEQVR42u2Xr46DQBCH6ytPICrPn+ERaskqBAJHkA22qgJTzSPUthpHeISKM2d4ARQWdzeXfE2aBqa0NNnN5Sb5zGb3N392GGCx+LfH7E3whUCIhRRi1nz2vNzehVDYCQehEs7CF5xZO7An5MxsW5LZHget0AmfQi2UULPWsafiTIDGU7aivEdEG+Ek5EIiGGENhrWcPQ1njmisnnG+IZOeLLc485RzHnu2nOnR2DwSxJKoK0r6e6/RHcdDgUSc7dBKp15HQOl6BMyMHjJo9GgGU7p9z/2VZDHXIrRatNWnI6RcDffovSAAD60G7VAbMjsiPdFMY/YhZEIBGWtjtkazxcfgsPKvmiZXsjeU9PuGUukXD81LU/tjzVcxUBIl8yHn10GMVSJBuxprxpiRWiuZZIrzC5lSuRof8dCGlLleKvdfTAigUPqgxEfqZADWr8B6E1p/DK0PIuuj2ImXkfXXsRMfJNY/yZz4KHXis9yJHxNnfs3+rv0AFh/tpf6bQVcAAAAASUVORK5CYII=';
