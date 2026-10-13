import path from 'node:path';
import os from 'node:os';

export function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new ToolInputError(`Missing required parameter "${key}".`);
  }
  return String(v);
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === 'true';
}

export function resolvePath(p: string, cwd: string): string {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

/** Keep the head and tail of long output, which is where the useful parts of logs usually are. */
export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters truncated] …\n\n${text.slice(-half)}`;
}

export class ToolInputError extends Error {}

export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache']);
