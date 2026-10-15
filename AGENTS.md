# AGENTS.md — Open Harness

Open Harness is an agent harness for local models (Ollama and OpenAI-compatible servers): a TypeScript core, a terminal CLI and an Electron + React Mac app. Agents, including Open Harness itself, work on this repo. These are the rules.

## Commands

```bash
npm install          # once; also downloads the Electron binary
npm test             # vitest, all tests in packages/*/test
npm run typecheck    # tsc for core, cli and desktop
npm run dev          # the desktop app with hot reload
npm run cli -- -m qwen3:8b   # the terminal agent
npm run bench -- -m qwen3:8b # the task benchmark (bench/)
```

Before you say a change works, run `npm test && npm run typecheck`. Both must pass.

## Layout

```
packages/core/src     The harness: agent loop (agent.ts), tools/, permissions, sandbox,
                      providers (Ollama + OpenAI-compatible), MCP, hooks, memory, skills,
                      daemons, worktrees, sessions (store.ts). No Electron imports here.
packages/core/test    Vitest tests. FakeOllama in helpers.ts scripts model replies.
packages/cli/src      main.ts: terminal REPL and -p mode on top of core
apps/desktop/src      main/ (Electron main process, IPC), preload/, renderer/ (React UI),
                      shared/ipc.ts (the typed API between them)
bench/                Benchmark tasks and runner
docs/research         Design notes
```

## Conventions

- TypeScript, ES modules. Core imports use `.ts` extensions (`import { x } from './x.ts'`).
- Keep `packages/core` free of Electron and DOM code. The renderer may only import *types* from core.
- New core features get tests in `packages/core/test`. Prefer a FakeOllama script over a real model.
- New IPC calls: add them to `OhApi` in `apps/desktop/src/shared/ipc.ts`, `preload/index.ts`, a handler in `main/index.ts`, and `renderer/src/mock.ts` (the browser preview).
- UI text is plain and short. User-visible name: "Open Harness". Package and directory names stay `openharness`.
- Match the surrounding style: small functions, comments only where the reason isn't obvious.

## Safety rules for agents working on this repo

- **Work in a git worktree, never in the checkout that runs the app.** `npm run dev` hot-reloads from this folder, so editing it restarts the app mid-task. The desktop app enforces this for chats in this repo.
- Don't change `scripts/ensure-electron.mjs`, `.github/workflows` or release configuration unless the task is about them.
- Never commit secrets or files from `~/.openharness`.
- Don't push to `main`. Commit on your branch; a human reviews and merges.
