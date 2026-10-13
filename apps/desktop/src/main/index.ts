import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  Agent,
  DaemonManager,
  McpManager,
  OllamaClient,
  SessionStore,
  loadConfig,
  saveConfig,
  titleFrom,
  type ApprovalDecision,
  type Config,
  type Session,
} from '@openharness/core';
import { CHANNELS, type AppState, type OpenSession } from '../shared/ipc';

fixPath();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: Config;
let client: OllamaClient;
const mcp = new McpManager();
const sessions = new SessionStore();
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
    mcp: mcp.statuses,
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
    history: session.messages,
    extraTools: mcp.getTools(),
    approve: (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvals.set(`${session.id}:${req.id}`, resolve);
        if (win && !win.isFocused() && Notification.isSupported()) {
          new Notification({ title: 'openHarness needs approval', body: req.summary }).show();
        }
      }),
  });
  agent.on((event) => {
    send(CHANNELS.agentEvent, session.id, event);
    if (event.type === 'turn_end') {
      session.messages = agent.messages;
      void sessions.save(session);
    }
  });
  const entry = { agent, session };
  live.set(session.id, entry);
  return entry;
}

function toOpen({ agent, session }: { agent: Agent; session: Session }): OpenSession {
  return { ...session, messages: agent.messages, running: agent.running };
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
    const mcpChanged = JSON.stringify(next.mcpServers) !== JSON.stringify(config.mcpServers);
    config = next;
    await saveConfig(config);
    client = new OllamaClient(config.ollamaHost);
    if (mcpChanged) {
      await mcp.connect(config.mcpServers);
      for (const { agent } of live.values()) agent.setExtraTools(mcp.getTools());
    }
    return appState();
  });

  ipcMain.handle('pickFolder', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('createSession', async (_e, opts: { cwd: string; model: string; mode: Config['mode'] }) => {
    const session = sessions.create(opts);
    return toOpen(attach(session));
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
    await sessions.delete(id);
    return (await sessions.list()).filter((s) => !s.daemonId);
  });

  ipcMain.handle('listSessions', async () => (await sessions.list()).filter((s) => !s.daemonId));

  ipcMain.handle('send', async (_e, id: string, text: string, images?: string[]) => {
    const entry = await getLive(id);
    if (entry.agent.running) throw new Error('The agent is still working. Stop it or wait for it to finish.');
    if (entry.session.title === 'New session') entry.session.title = titleFrom(text);
    // Persist immediately so the session appears in the sidebar.
    await sessions.save({ ...entry.session, messages: entry.agent.messages });
    void entry.agent.send(text, images);
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
    session.messages = agent.messages;
    await sessions.save(session);
  });

  ipcMain.handle('respondApproval', async (_e, id: string, requestId: string, decision: ApprovalDecision) => {
    const key = `${id}:${requestId}`;
    approvals.get(key)?.(decision);
    approvals.delete(key);
  });

  ipcMain.handle('compact', async (_e, id: string) => {
    const { agent, session } = await getLive(id);
    const removed = await agent.compactNow();
    session.messages = agent.messages;
    await sessions.save(session);
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
  tray?.setToolTip(`openHarness — ${running} daemon${running === 1 ? '' : 's'} running`);
  app.dock?.setBadge(unread ? String(unread) : '');
}

function createTray(): void {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'), { scaleFactor: 2 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open openHarness', click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  );
  updateTray();
}

app.whenReady().then(async () => {
  app.setName('openHarness');
  config = await loadConfig();
  client = new OllamaClient(config.ollamaHost);
  daemons = new DaemonManager(() => client, sessions, {
    extraTools: () => mcp.getTools(),
    maxContext: () => config.maxContext,
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
  createWindow();
  createTray();
  void mcp.connect(config.mcpServers).then(() => {
    for (const { agent } of live.values()) agent.setExtraTools(mcp.getTools());
  });
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
