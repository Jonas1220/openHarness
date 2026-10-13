import path from 'node:path';
import type { PermissionMode, SandboxPolicy, Tool } from './types.ts';

export type PermissionVerdict =
  | { kind: 'allow'; sandboxed: boolean }
  | { kind: 'ask'; reason: string; sandboxed: boolean }
  | { kind: 'deny'; reason: string };

export const PERMISSION_MODES: { id: PermissionMode; label: string; description: string }[] = [
  { id: 'read-only', label: 'Read only', description: 'Can read and search. Never edits files; asks before running commands.' },
  { id: 'ask', label: 'Ask', description: 'Asks before every edit and command.' },
  { id: 'auto-edit', label: 'Auto edit', description: 'Edits files in the workspace freely; asks before running commands.' },
  { id: 'full-auto', label: 'Full auto', description: 'Edits and runs commands without asking, sandboxed to the workspace with no network.' },
];

/**
 * Decides whether a tool call may run, needs approval, or is refused.
 * "Allow for this session" approvals are remembered as rules keyed by tool and,
 * for shell commands, by the leading command word (e.g. `bash:npm`).
 */
export class PermissionEngine {
  private sessionRules = new Set<string>();

  constructor(
    public mode: PermissionMode,
    public workspace: string,
  ) {}

  sandboxPolicy(): SandboxPolicy {
    return {
      enabled: this.mode === 'full-auto' || this.mode === 'read-only',
      writableRoots: this.mode === 'read-only' ? [] : [this.workspace],
      allowNetwork: false,
    };
  }

  check(tool: Tool, args: Record<string, unknown>): PermissionVerdict {
    if (tool.kind === 'read' || tool.kind === 'meta') {
      return { kind: 'allow', sandboxed: false };
    }
    if (this.isRemembered(tool, args)) return { kind: 'allow', sandboxed: this.mode === 'read-only' };

    if (tool.kind === 'write') {
      if (this.mode === 'read-only') return { kind: 'deny', reason: 'File edits are disabled in read-only mode.' };
      const outside = (tool.targetPaths?.(args, this.workspace) ?? []).filter((p) => !isInside(p, this.workspace));
      if (outside.length) return { kind: 'ask', reason: `Writes outside the workspace: ${outside.join(', ')}`, sandboxed: false };
      if (this.mode === 'ask') return { kind: 'ask', reason: 'Edit file', sandboxed: false };
      return { kind: 'allow', sandboxed: false };
    }

    if (tool.kind === 'exec') {
      if (this.mode === 'full-auto') return { kind: 'allow', sandboxed: true };
      return { kind: 'ask', reason: 'Run command', sandboxed: this.mode === 'read-only' };
    }

    if (tool.kind === 'external') {
      if (this.mode === 'full-auto') return { kind: 'allow', sandboxed: false };
      return { kind: 'ask', reason: 'Use external tool', sandboxed: false };
    }

    // network
    if (this.mode === 'full-auto' || this.mode === 'auto-edit') return { kind: 'allow', sandboxed: false };
    return { kind: 'ask', reason: 'Access the network', sandboxed: false };
  }

  rememberForSession(tool: Tool, args: Record<string, unknown>): void {
    for (const key of ruleKeys(tool, args) ?? []) this.sessionRules.add(key);
  }

  private isRemembered(tool: Tool, args: Record<string, unknown>): boolean {
    const keys = ruleKeys(tool, args);
    return keys !== null && keys.every((k) => this.sessionRules.has(k));
  }
}

/**
 * Rule keys a call must match. Shell commands are split at control operators
 * (`&&`, `||`, `;`, `|`) and every segment's program must be approved, so approving
 * `npm` doesn't also approve `npm test && rm -rf ~`. Commands with substitutions,
 * redirections or env assignments never match a rule (same restriction Codex applies).
 */
export function ruleKeys(tool: Tool, args: Record<string, unknown>): string[] | null {
  if (tool.kind !== 'exec') return [tool.name];
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim() || /[`$<>]|\(|\)/.test(command)) return null;
  const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim());
  const programs: string[] = [];
  for (const seg of segments) {
    const first = seg.split(/\s+/)[0];
    if (!first || first.includes('=')) return null;
    programs.push(`${tool.name}:${first}`);
  }
  return programs;
}

export function isInside(p: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
