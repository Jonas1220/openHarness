import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SandboxPolicy } from './types.ts';

/**
 * macOS Seatbelt sandbox for shell commands.
 *
 * Approach adapted from OpenAI Codex (Apache-2.0, codex-rs/sandboxing/src/seatbelt.rs):
 *  - always invoke the absolute /usr/bin/sandbox-exec so a binary planted on PATH can't stand in for it
 *  - pass writable roots as -D parameters instead of interpolating paths into the profile
 *
 * The profile here is intentionally simpler than Codex's closed-by-default profile:
 * everything is allowed except writes outside the writable roots and (optionally)
 * outbound network other than localhost.
 */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function isSandboxSupported(): boolean {
  return process.platform === 'darwin';
}

export function buildSeatbeltProfile(policy: SandboxPolicy): { profile: string; params: Record<string, string> } {
  const roots = unique([...policy.writableRoots, tmpdir(), '/private/tmp', '/private/var/folders'].map(canonical));
  const params: Record<string, string> = {};
  const rootRules = roots.map((root, i) => {
    params[`WRITABLE_ROOT_${i}`] = root;
    return `(subpath (param "WRITABLE_ROOT_${i}"))`;
  });

  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write*\n  ${rootRules.join('\n  ')}\n  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")\n  (regex #"^/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/fd/"))`,
  ];
  if (!policy.allowNetwork) {
    lines.push(
      '(deny network-outbound)',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-outbound (remote unix-socket))',
    );
  }
  return { profile: lines.join('\n'), params };
}

/** Wrap argv so it runs inside the sandbox. Returns argv unchanged when sandboxing is off or unsupported. */
export function wrapCommand(argv: string[], policy: SandboxPolicy): string[] {
  if (!policy.enabled || !isSandboxSupported()) return argv;
  const { profile, params } = buildSeatbeltProfile(policy);
  const defs = Object.entries(params).map(([k, v]) => `-D${k}=${v}`);
  return [SANDBOX_EXEC, '-p', profile, ...defs, '--', ...argv];
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
