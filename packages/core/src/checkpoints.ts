import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Checkpoint } from './types.ts';

const MAX_SNAPSHOT_BYTES = 2_000_000;

/**
 * Records file contents before the agent changes them, one checkpoint per user
 * turn, so a turn's edits can be rewound (like Claude Code's /rewind).
 * Only edits made through file tools are tracked; side effects of shell
 * commands are not.
 */
export class CheckpointLog {
  constructor(public list: Checkpoint[] = []) {}

  /** Capture `paths` for the turn started by `messageId`, unless already captured in that turn. */
  async capture(messageId: string, paths: string[]): Promise<Checkpoint | null> {
    let cp = this.list.find((c) => c.messageId === messageId);
    let changed = false;
    if (!cp) {
      cp = { messageId, files: {}, createdAt: new Date().toISOString() };
      this.list.push(cp);
      changed = true;
    }
    for (const p of paths) {
      if (p in cp.files) continue;
      const before = await snapshot(p);
      if (before === undefined) continue; // too large or unreadable: not tracked
      cp.files[p] = before;
      changed = true;
    }
    return changed ? cp : null;
  }

  /** Every file touched in the session. */
  changedFiles(): string[] {
    return [...new Set(this.list.flatMap((c) => Object.keys(c.files)))];
  }

  /** Content of a file before the session first changed it. */
  original(file: string): string | null | undefined {
    for (const c of this.list) if (file in c.files) return c.files[file];
    return undefined;
  }

  /**
   * Restore files to their state before the turn started by `messageId`, and
   * drop that checkpoint and every later one. Returns the restored paths.
   */
  async rewind(messageId: string): Promise<string[]> {
    const idx = this.list.findIndex((c) => c.messageId === messageId);
    if (idx < 0) return [];
    const later = this.list.slice(idx);
    const restore = new Map<string, string | null>();
    // The earliest snapshot at or after the target turn is the state to go back to.
    for (const c of later) for (const [p, content] of Object.entries(c.files)) if (!restore.has(p)) restore.set(p, content);
    for (const [p, content] of restore) await writeOrDelete(p, content);
    this.list = this.list.slice(0, idx);
    return [...restore.keys()];
  }

  /** Put one file back to how it was before the session touched it. */
  async revertFile(file: string): Promise<boolean> {
    const original = this.original(file);
    if (original === undefined) return false;
    await writeOrDelete(file, original);
    return true;
  }
}

/** File content, null if the file doesn't exist, undefined if it can't be tracked. */
async function snapshot(file: string): Promise<string | null | undefined> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined;
  return fs.readFile(file, 'utf8').catch(() => undefined);
}

async function writeOrDelete(file: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(file, { force: true });
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }
}
