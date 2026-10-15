import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentOptions } from './agent.ts';
import type { ModelClient } from './providers.ts';
import { SessionStore, dataDir, readJson, writeJson } from './store.ts';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, PermissionMode, Tool } from './types.ts';

/**
 * Daemons are always-on agents: each has a standing goal, a schedule, a memory
 * file it maintains itself, and an inbox it reports to. They are Open Harness's
 * local take on ChatGPT "dots" — they run between conversations, surface only
 * what needs attention, and wait for the user before sensitive actions.
 */

export type DaemonSchedule =
  | { kind: 'manual' }
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string /* HH:MM local */ };

export interface DaemonDef {
  id: string;
  name: string;
  emoji: string;
  goal: string;
  model: string;
  cwd: string;
  mode: PermissionMode;
  schedule: DaemonSchedule;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastSummary?: string;
  lastStatus?: 'ok' | 'error' | 'running';
}

export interface InboxItem {
  id: string;
  daemonId: string;
  kind: 'report' | 'approval' | 'error';
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  sessionId?: string;
  approval?: { request: ApprovalRequest; status: 'pending' | 'approved' | 'denied' | 'expired' };
}

export type DaemonEvent =
  | { type: 'daemons_changed' }
  | { type: 'inbox_changed'; item?: InboxItem }
  | { type: 'run_started'; daemonId: string; sessionId: string }
  | { type: 'run_event'; daemonId: string; sessionId: string; event: AgentEvent }
  | { type: 'run_finished'; daemonId: string; sessionId: string; status: 'ok' | 'error' };

const PERSISTENT_RULES = `# You are a daemon
You are an always-on agent that works toward a standing goal across many scheduled runs. The user is usually not watching.

- Each run, make concrete progress on the goal, or check on what you were monitoring. Close open loops before starting new work.
- Do not invent work that the goal doesn't call for. If nothing needs doing, say so briefly and stop.
- Use report_to_user only for things that need the user's attention: results, a decision, a problem. Never send duplicate or "nothing new" reports.
- Before the run ends, call update_memory with what you learned, the current state, and what to do next run. Your memory is your only continuity between runs.
- Sensitive actions (edits outside the workspace, commands when not in full-auto) wait for the user's approval in their inbox. If one is denied, adapt — don't retry it.
- End the run with a 1–3 sentence summary of what you did.`;

export class DaemonManager {
  private daemons: DaemonDef[] = [];
  private inbox: InboxItem[] = [];
  private listeners = new Set<(e: DaemonEvent) => void>();
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private running = new Map<string, Agent>();
  private timer: NodeJS.Timeout | null = null;
  private dir: string;

  constructor(
    private client: () => ModelClient,
    private sessions: SessionStore,
    private opts: {
      extraTools?: () => Tool[];
      maxContext?: () => number;
      /** Extra agent options read at the start of every run (hooks, tool search, …). */
      agentOptions?: () => Partial<AgentOptions>;
      approvalTimeoutMs?: number;
      dir?: string;
    } = {},
  ) {
    this.dir = opts.dir ?? path.join(dataDir(), 'daemons');
  }

  on(l: (e: DaemonEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: DaemonEvent): void {
    for (const l of this.listeners) l(e);
  }

  async load(): Promise<void> {
    this.daemons = (await readJson<DaemonDef[]>(path.join(this.dir, 'daemons.json'))) ?? [];
    this.inbox = (await readJson<InboxItem[]>(path.join(this.dir, 'inbox.json'))) ?? [];
    // Approvals can't survive a restart: the run that was waiting is gone.
    for (const item of this.inbox) if (item.approval?.status === 'pending') item.approval.status = 'expired';
    for (const d of this.daemons) if (d.lastStatus === 'running') d.lastStatus = 'error';
  }

  /** Check every 30s for daemons that are due. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const agent of this.running.values()) agent.abort();
  }

  list(): DaemonDef[] {
    return this.daemons;
  }

  getInbox(): InboxItem[] {
    return [...this.inbox].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async upsert(def: Partial<DaemonDef> & Pick<DaemonDef, 'name' | 'goal' | 'model' | 'cwd'>): Promise<DaemonDef> {
    const existing = def.id ? this.daemons.find((d) => d.id === def.id) : undefined;
    const next: DaemonDef = {
      emoji: '✦',
      mode: 'auto-edit',
      schedule: { kind: 'interval', minutes: 60 },
      enabled: true,
      createdAt: new Date().toISOString(),
      ...existing,
      ...def,
      id: existing?.id ?? randomUUID(),
    };
    this.daemons = existing ? this.daemons.map((d) => (d.id === next.id ? next : d)) : [...this.daemons, next];
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.running.get(id)?.abort();
    this.daemons = this.daemons.filter((d) => d.id !== id);
    this.inbox = this.inbox.filter((i) => i.daemonId !== id);
    await fs.rm(path.join(this.dir, id), { recursive: true, force: true });
    await this.persist();
    await this.persistInbox();
  }

  async readMemory(id: string): Promise<string> {
    return fs.readFile(this.memoryPath(id), 'utf8').catch(() => '');
  }

  async writeMemory(id: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryPath(id)), { recursive: true });
    await fs.writeFile(this.memoryPath(id), content, 'utf8');
  }

  async markRead(itemId: string): Promise<void> {
    const item = this.inbox.find((i) => i.id === itemId);
    if (item && !item.read) {
      item.read = true;
      await this.persistInbox();
    }
  }

  async resolveApproval(itemId: string, decision: ApprovalDecision): Promise<void> {
    const item = this.inbox.find((i) => i.id === itemId);
    if (!item?.approval || item.approval.status !== 'pending') return;
    item.approval.status = decision.kind === 'deny' ? 'denied' : 'approved';
    item.read = true;
    this.pendingApprovals.get(itemId)?.(decision);
    this.pendingApprovals.delete(itemId);
    await this.persistInbox();
    this.emit({ type: 'inbox_changed', item });
  }

  /** Next time a daemon is due, or null for manual / disabled daemons. */
  static nextRun(d: DaemonDef, now = new Date()): Date | null {
    if (!d.enabled) return null;
    const last = d.lastRunAt ? new Date(d.lastRunAt) : null;
    switch (d.schedule.kind) {
      case 'manual':
        return null;
      case 'interval': {
        const ms = Math.max(1, d.schedule.minutes) * 60_000;
        return last ? new Date(last.getTime() + ms) : now;
      }
      case 'daily': {
        const [h, m] = d.schedule.time.split(':').map(Number);
        const slot = new Date(now);
        slot.setHours(h ?? 9, m ?? 0, 0, 0);
        // Today's slot is due unless we already ran (or were created) after it.
        const reference = last ?? new Date(d.createdAt);
        return reference >= slot ? new Date(slot.getTime() + 86_400_000) : slot;
      }
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const d of this.daemons) {
      if (this.running.has(d.id)) continue;
      const due = DaemonManager.nextRun(d, now);
      if (due && due <= now) void this.run(d.id);
    }
  }

  /** Run a daemon now. An optional message from the user is passed into the run. */
  async run(id: string, userMessage?: string): Promise<string | null> {
    const def = this.daemons.find((d) => d.id === id);
    if (!def || this.running.has(id)) return null;

    const memory = await this.readMemory(id);
    const session = this.sessions.create({
      title: `${def.name} · ${new Date().toLocaleString()}`,
      cwd: def.cwd,
      model: def.model,
      mode: def.mode,
      daemonId: def.id,
    });

    const agent = new Agent({
      ...this.opts.agentOptions?.(),
      client: this.client(),
      model: def.model,
      cwd: def.cwd,
      mode: def.mode,
      maxContext: this.opts.maxContext?.(),
      maxSteps: 40,
      memory: false, // daemons keep their own memory file
      extraTools: [...this.daemonTools(def, session.id), ...(this.opts.extraTools?.() ?? [])],
      instructions: [
        PERSISTENT_RULES,
        `# Your goal\n${def.goal}`,
        `# Your memory (from previous runs)\n${memory.trim() || '(empty — this is your first run)'}`,
        def.lastSummary ? `# Last run summary (${def.lastRunAt})\n${def.lastSummary}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      approve: (req) => this.requestApproval(def, session.id, req),
    });

    this.running.set(id, agent);
    def.lastRunAt = new Date().toISOString();
    def.lastStatus = 'running';
    await this.persist();
    this.emit({ type: 'run_started', daemonId: id, sessionId: session.id });

    let status: 'ok' | 'error' = 'ok';
    let lastText = '';
    const off = agent.on((event) => {
      if (event.type === 'assistant_message' && event.message.content.trim()) lastText = event.message.content.trim();
      if (event.type === 'error') {
        status = 'error';
        void this.addInbox({ daemonId: id, kind: 'error', title: `${def.name} hit an error`, body: event.message, sessionId: session.id });
      }
      this.emit({ type: 'run_event', daemonId: id, sessionId: session.id, event });
    });

    const prompt = userMessage
      ? `The user sent you a message:\n\n${userMessage}\n\nRespond to it and continue working toward your goal.`
      : `Scheduled run at ${new Date().toLocaleString()}. Work toward your goal.`;
    try {
      await agent.send(prompt);
    } finally {
      off();
      this.running.delete(id);
      session.messages = agent.messages;
      await this.sessions.save(session);
      def.lastStatus = status;
      def.lastSummary = lastText.slice(0, 2000);
      await this.persist();
      if (userMessage && lastText) {
        await this.addInbox({ daemonId: id, kind: 'report', title: `${def.name} replied`, body: lastText, sessionId: session.id });
      }
      this.emit({ type: 'run_finished', daemonId: id, sessionId: session.id, status });
    }
    return session.id;
  }

  stopRun(id: string): void {
    this.running.get(id)?.abort();
  }

  private daemonTools(def: DaemonDef, sessionId: string): Tool[] {
    return [
      {
        name: 'report_to_user',
        kind: 'meta',
        description:
          "Send a message to the user's inbox. Use only for results, decisions or problems that need the user's attention.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short headline.' },
            message: { type: 'string', description: 'The report, in Markdown.' },
          },
          required: ['title', 'message'],
        },
        describe: (a) => `Report: ${a.title}`,
        run: async (args) => {
          await this.addInbox({
            daemonId: def.id,
            kind: 'report',
            title: String(args.title ?? 'Update'),
            body: String(args.message ?? ''),
            sessionId,
          });
          return { output: 'Delivered to the user.' };
        },
      },
      {
        name: 'update_memory',
        kind: 'meta',
        description:
          'Replace your memory file with new content (Markdown). Keep it short and current: state, learnings, next steps. Send the full memory, not a diff.',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Full new memory content.' } },
          required: ['content'],
        },
        describe: () => 'Update memory',
        run: async (args) => {
          const content = String(args.content ?? '').slice(0, 20_000);
          await this.writeMemory(def.id, content);
          return { output: 'Memory saved.' };
        },
      },
    ];
  }

  private requestApproval(def: DaemonDef, sessionId: string, request: ApprovalRequest): Promise<ApprovalDecision> {
    const id = randomUUID();
    const timeout = this.opts.approvalTimeoutMs ?? 30 * 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const item = this.inbox.find((i) => i.id === id);
        if (item?.approval?.status === 'pending') {
          item.approval.status = 'expired';
          void this.persistInbox();
          this.emit({ type: 'inbox_changed', item });
        }
        this.pendingApprovals.delete(id);
        resolve({ kind: 'deny', feedback: 'The user did not respond in time. Skip this action and note it in your report.' });
      }, timeout);
      this.pendingApprovals.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      void this.addInbox({
        id,
        daemonId: def.id,
        kind: 'approval',
        title: `${def.name} wants to: ${request.summary}`,
        body: request.reason,
        sessionId,
        approval: { request, status: 'pending' },
      });
    });
  }

  private async addInbox(item: Omit<InboxItem, 'id' | 'createdAt' | 'read'> & { id?: string }): Promise<void> {
    const full: InboxItem = { ...item, id: item.id ?? randomUUID(), createdAt: new Date().toISOString(), read: false };
    this.inbox.push(full);
    if (this.inbox.length > 500) this.inbox = this.inbox.slice(-500);
    await this.persistInbox();
    this.emit({ type: 'inbox_changed', item: full });
  }

  private memoryPath(id: string): string {
    return path.join(this.dir, id, 'memory.md');
  }

  private async persist(): Promise<void> {
    await writeJson(path.join(this.dir, 'daemons.json'), this.daemons);
    this.emit({ type: 'daemons_changed' });
  }

  private async persistInbox(): Promise<void> {
    await writeJson(path.join(this.dir, 'inbox.json'), this.inbox);
  }
}
