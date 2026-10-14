import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from './mcp.ts';
import type { Checkpoint, Message, PermissionMode } from './types.ts';

export function dataDir(): string {
  return process.env.OPENHARNESS_HOME ?? path.join(os.homedir(), '.openharness');
}

export interface Config {
  ollamaHost: string;
  defaultModel: string;
  mode: PermissionMode;
  maxContext: number;
  think: boolean;
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULT_CONFIG: Config = {
  ollamaHost: 'http://127.0.0.1:11434',
  defaultModel: 'qwen3:8b',
  mode: 'ask',
  maxContext: 16384,
  think: true,
  mcpServers: {},
};

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<Partial<Config>>(path.join(dataDir(), 'config.json'));
  return { ...DEFAULT_CONFIG, ...raw, mcpServers: { ...(raw?.mcpServers ?? {}) } };
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJson(path.join(dataDir(), 'config.json'), config);
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
export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
