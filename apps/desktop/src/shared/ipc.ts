import type {
  AgentEvent,
  ApprovalDecision,
  Config,
  DaemonDef,
  DaemonEvent,
  InboxItem,
  McpServerStatus,
  McpSource,
  Message,
  ModelInfo,
  PermissionMode,
  Project,
  PullProgress,
  Session,
  SessionMeta,
  Skill,
  SlashCommand,
} from '@openharness/core';

export type {
  McpSource,
  AgentEvent,
  ApprovalDecision,
  Config,
  DaemonDef,
  DaemonEvent,
  InboxItem,
  McpServerStatus,
  Message,
  ModelInfo,
  PermissionMode,
  Project,
  PullProgress,
  Session,
  SessionMeta,
  Skill,
  SlashCommand,
};

export const APP_NAME = 'Open Harness';

export interface AppState {
  config: Config;
  ollamaVersion: string | null;
  models: ModelInfo[];
  sessions: SessionMeta[];
  projects: Project[];
  daemons: DaemonDef[];
  runningDaemons: string[];
  inbox: InboxItem[];
  mcp: McpServerView[];
  home: string;
}

/** A discovered MCP server as shown in the UI (no headers, env or other secrets). */
export interface McpServerView {
  id: string;
  name: string;
  source: McpSource;
  scope: 'user' | 'project';
  origin: string;
  /** Command line or URL, with secret-looking arguments masked. */
  summary: string;
  status: McpServerStatus['status'] | 'shadowed' | 'needs-approval';
  error?: string;
  shadowedBy?: string;
  tools: string[];
  /** Switched off in the tool it was imported from (e.g. `enabled = false` in Codex). */
  disabledInSource: boolean;
}

export interface OpenSession extends Omit<Session, 'checkpoints'> {
  running: boolean;
  /** Files the agent changed in this session (from checkpoints). */
  changedFiles: string[];
}

export interface FileChange {
  path: string;
  /** Path relative to the session folder, for display. */
  rel: string;
  /** Content before the session changed it (null: file didn't exist). */
  before: string | null;
  /** Current content (null: file was deleted). */
  after: string | null;
}

/** The API the preload script exposes on `window.oh`. */
export interface OhApi {
  init(): Promise<AppState>;
  refreshModels(): Promise<{ version: string | null; models: ModelInfo[] }>;
  pullModel(name: string): Promise<void>;
  saveConfig(config: Config): Promise<AppState>;
  pickFolder(): Promise<string | null>;
  revealPath(path: string): Promise<void>;

  upsertProject(project: Partial<Project> & Pick<Project, 'path'>): Promise<Project[]>;
  removeProject(id: string): Promise<Project[]>;
  /** AGENTS.md in `dir`, or the global one in ~/.openharness when dir is null. */
  readInstructions(dir: string | null): Promise<string>;
  writeInstructions(dir: string | null, content: string): Promise<void>;
  listSkills(cwd: string): Promise<Skill[]>;
  listCommands(cwd: string): Promise<SlashCommand[]>;
  listFiles(cwd: string, query: string): Promise<string[]>;
  /** User-scope servers, or the project servers for `cwd`. */
  listMcp(cwd?: string): Promise<McpServerView[]>;
  refreshMcp(cwd?: string): Promise<McpServerView[]>;
  setMcpEnabled(id: string, enabled: boolean, cwd?: string): Promise<McpServerView[]>;
  approveProjectMcp(cwd: string, id: string): Promise<McpServerView[]>;

  createSession(opts: { cwd: string; model: string; mode: PermissionMode; projectId?: string }): Promise<OpenSession>;
  openSession(id: string): Promise<OpenSession | null>;
  deleteSession(id: string): Promise<SessionMeta[]>;
  renameSession(id: string, title: string): Promise<SessionMeta[]>;
  forkSession(id: string): Promise<OpenSession | null>;
  /** Asks where to save; returns the file path, or null if cancelled. */
  exportSession(id: string): Promise<string | null>;
  readMemory(scope: 'user' | 'project', cwd: string): Promise<string>;
  writeMemory(scope: 'user' | 'project', cwd: string, content: string): Promise<void>;
  /** Adds the Playwright MCP server as "browser"; returns the browser it will drive (null = Chrome). */
  addBrowserServer(): Promise<{ state: AppState; browser: string | null }>;
  listSessions(): Promise<SessionMeta[]>;
  send(sessionId: string, text: string, opts?: { images?: string[]; id?: string }): Promise<void>;
  abort(sessionId: string): Promise<void>;
  updateSession(sessionId: string, patch: { model?: string; mode?: PermissionMode }): Promise<void>;
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  compact(sessionId: string): Promise<number>;
  rewind(sessionId: string, messageId: string, opts: { code: boolean; conversation: boolean }): Promise<{ restored: string[]; session: OpenSession }>;
  getChanges(sessionId: string): Promise<FileChange[]>;
  revertFile(sessionId: string, path: string): Promise<FileChange[]>;

  upsertDaemon(def: Partial<DaemonDef> & Pick<DaemonDef, 'name' | 'goal' | 'model' | 'cwd'>): Promise<DaemonDef>;
  removeDaemon(id: string): Promise<void>;
  runDaemon(id: string, message?: string): Promise<void>;
  stopDaemon(id: string): Promise<void>;
  getDaemonMemory(id: string): Promise<string>;
  setDaemonMemory(id: string, content: string): Promise<void>;
  resolveInbox(itemId: string, decision: ApprovalDecision): Promise<void>;
  markInboxRead(itemId: string): Promise<void>;

  onAgentEvent(cb: (sessionId: string, event: AgentEvent) => void): () => void;
  onDaemonEvent(cb: (event: DaemonEvent, state: Pick<AppState, 'daemons' | 'inbox' | 'runningDaemons'>) => void): () => void;
  onPullProgress(cb: (name: string, progress: PullProgress) => void): () => void;
  /** Menu shortcuts (new chat, settings, …) forwarded from the main process. */
  onMenu(cb: (action: MenuAction) => void): () => void;
}

export type MenuAction = 'new-chat' | 'settings' | 'toggle-plan' | 'focus-search' | 'add-project';

export const CHANNELS = {
  agentEvent: 'oh:agent-event',
  daemonEvent: 'oh:daemon-event',
  pullProgress: 'oh:pull-progress',
  menu: 'oh:menu',
} as const;
