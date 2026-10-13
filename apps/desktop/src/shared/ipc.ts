import type {
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
  PullProgress,
  Session,
  SessionMeta,
} from '@openharness/core';

export type {
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
  PullProgress,
  Session,
  SessionMeta,
};

export interface AppState {
  config: Config;
  ollamaVersion: string | null;
  models: ModelInfo[];
  sessions: SessionMeta[];
  daemons: DaemonDef[];
  runningDaemons: string[];
  inbox: InboxItem[];
  mcp: McpServerStatus[];
  home: string;
}

export interface OpenSession extends Session {
  running: boolean;
}

/** The API the preload script exposes on `window.oh`. */
export interface OhApi {
  init(): Promise<AppState>;
  refreshModels(): Promise<{ version: string | null; models: ModelInfo[] }>;
  pullModel(name: string): Promise<void>;
  saveConfig(config: Config): Promise<AppState>;
  pickFolder(): Promise<string | null>;

  createSession(opts: { cwd: string; model: string; mode: PermissionMode }): Promise<OpenSession>;
  openSession(id: string): Promise<OpenSession | null>;
  deleteSession(id: string): Promise<SessionMeta[]>;
  listSessions(): Promise<SessionMeta[]>;
  send(sessionId: string, text: string, images?: string[]): Promise<void>;
  abort(sessionId: string): Promise<void>;
  updateSession(sessionId: string, patch: { model?: string; mode?: PermissionMode }): Promise<void>;
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  compact(sessionId: string): Promise<number>;

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
}

export const CHANNELS = {
  agentEvent: 'oh:agent-event',
  daemonEvent: 'oh:daemon-event',
  pullProgress: 'oh:pull-progress',
} as const;
