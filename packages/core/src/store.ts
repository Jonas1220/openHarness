import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from './mcp.ts';
import type { ProviderConfig } from './providers.ts';
import type { WorktreeInfo } from './worktrees.ts';
import type { HooksConfig } from './hooks.ts';
import { DEFAULT_IMPORT_SOURCES, type ImportSources } from './mcpImport.ts';
import type { ToolSearchSetting } from './toolSearch.ts';
import type { Checkpoint, Message, PermissionMode } from './types.ts';

export function dataDir(): string {
  return process.env.OPENHARNESS_HOME ?? path.join(os.homedir(), '.openharness');
}

export interface Config {
  ollamaHost: string;
  defaultModel: string;
  mode: PermissionMode;
  /** Cap for the context window in tokens. 0 = always use the model's full context. */
  maxContext: number;
  think: boolean;
  mcpServers: Record<string, McpServerConfig>;
  /** Use MCP servers configured in Claude Code, Codex and Claude Desktop. */
  mcpImport: ImportSources;
  /** Ids of discovered MCP servers the user switched off. */
  mcpDisabled: string[];
  /** Load MCP tools on demand instead of sending all of them every time. */
  toolSearch: ToolSearchSetting;
  /** Lifecycle hooks, in Claude Code's format. */
  hooks: HooksConfig;
  /** OpenAI-compatible model servers (LM Studio, llama.cpp, vLLM, OpenRouter, …). */
  providers: ProviderConfig[];
}

export const DEFAULT_CONFIG: Config = {
  ollamaHost: 'http://127.0.0.1:11434',
  defaultModel: 'qwen3:8b',
  mode: 'ask',
  maxContext: 0,
  think: true,
  mcpServers: {},
  mcpImport: DEFAULT_IMPORT_SOURCES,
  mcpDisabled: [],
  toolSearch: 'auto',
  hooks: {},
  providers: [],
};

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<Partial<Config>>(path.join(dataDir(), 'config.json'));
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    mcpServers: { ...(raw?.mcpServers ?? {}) },
    mcpImport: { ...DEFAULT_IMPORT_SOURCES, ...(raw?.mcpImport ?? {}) },
    mcpDisabled: raw?.mcpDisabled ?? [],
    hooks: raw?.hooks ?? {},
    providers: raw?.providers ?? [],
  };
}

export async function saveConfig(config: Config): Promise<void> {
  // The config can hold provider API keys: keep it readable by the user only.
  await writeJson(path.join(dataDir(), 'config.json'), config, 0o600);
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  /** Set for sessions that belong to a daemon run. */
  daemonId?: string;
  projectId?: string;
  /** Set when the chat works in its own git worktree. */
  worktree?: WorktreeInfo;
}

export interface Session extends SessionMeta {
  messages: Message[];
  checkpoints?: Checkpoint[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /** Defaults for new chats in this project. */
  model?: string;
  mode?: PermissionMode;
  /** Project MCP servers (from the repo's .mcp.json) the user approved. */
  mcpApproved?: string[];
  /** Command that checks the agent's work, e.g. "npm test && npm run typecheck". */
  verifyCommand?: string;
}

/** Projects are pinned workspace folders that group chats, like in Codex and Claude Code. */
export class ProjectStore {
  private file = path.join(dataDir(), 'projects.json');
  private projects: Project[] = [];

  async load(): Promise<Project[]> {
    this.projects = (await readJson<Project[]>(this.file)) ?? [];
    return this.projects;
  }

  list(): Project[] {
    return this.projects;
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  findByPath(dir: string): Project | undefined {
    const target = path.resolve(dir);
    return this.projects.find((p) => path.resolve(p.path) === target);
  }

  async upsert(input: Partial<Project> & Pick<Project, 'path'>): Promise<Project> {
    const existing = (input.id && this.get(input.id)) || this.findByPath(input.path);
    const next: Project = {
      name: path.basename(input.path),
      createdAt: new Date().toISOString(),
      ...existing,
      ...input,
      id: existing?.id ?? randomUUID(),
    };
    this.projects = existing ? this.projects.map((p) => (p.id === next.id ? next : p)) : [...this.projects, next];
    await writeJson(this.file, this.projects);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.projects = this.projects.filter((p) => p.id !== id);
    await writeJson(this.file, this.projects);
  }
}

export class SessionStore {
  constructor(private dir = path.join(dataDir(), 'sessions')) {}

  create(init: Omit<SessionMeta, 'id' | 'createdAt' | 'updatedAt' | 'title'> & { title?: string }): Session {
    const now = new Date().toISOString();
    return { title: 'New session', ...init, id: randomUUID(), createdAt: now, updatedAt: now, messages: [] };
  }

  async save(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await writeJson(path.join(this.dir, `${session.id}.json`), session);
  }

  async load(id: string): Promise<Session | null> {
    if (!/^[\w-]+$/.test(id)) return null;
    return readJson<Session>(path.join(this.dir, `${id}.json`));
  }

  /**
   * Copy a chat into a new one to explore a different direction. Checkpoints are not copied:
   * both chats share the same files on disk, so the fork starts with its own undo history.
   */
  async fork(id: string): Promise<Session | null> {
    const source = await this.load(id);
    if (!source) return null;
    const { id: _id, createdAt: _c, updatedAt: _u, checkpoints: _cp, ...rest } = source;
    const fork = this.create({ ...rest, title: `${source.title} (fork)` });
    fork.messages = source.messages;
    await this.save(fork);
    return fork;
  }

  async delete(id: string): Promise<void> {
    if (!/^[\w-]+$/.test(id)) return;
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
  }

  async list(): Promise<SessionMeta[]> {
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const s = await readJson<Session>(path.join(this.dir, f));
      if (s) {
        const { messages: _messages, checkpoints: _checkpoints, ...meta } = s;
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

/** Derive a short session title from the first user message. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New session';
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic write: write to a temp file, then rename. */
export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  await fs.rename(tmp, file);
}

/** Render a chat as Markdown for sharing or archiving. Attached file contents are left out. */
export function sessionToMarkdown(session: Session): string {
  const lines = [`# ${session.title}`, '', `- Folder: \`${session.cwd}\``, `- Model: \`${session.model}\``, `- Created: ${session.createdAt}`, ''];
  for (const m of session.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const text = m.content.split('\n\n<attached_files>')[0]!;
      lines.push(m.summary ? '> _Earlier messages were summarized._' : `## You\n\n${text}`, '');
    } else if (m.role === 'assistant') {
      if (m.content.trim()) lines.push(`## Assistant\n\n${m.content.trim()}`, '');
      for (const c of m.toolCalls ?? []) lines.push(`> 🔧 \`${c.name}\` ${'`'}${JSON.stringify(c.arguments).slice(0, 300)}${'`'}`, '');
    } else if (m.role === 'tool') {
      const out = m.content.length > 1500 ? `${m.content.slice(0, 1500)}\n…` : m.content;
      lines.push('<details><summary>Result</summary>', '', '```', out, '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}
