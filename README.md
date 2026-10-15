<div align="center">

# Open Harness

**An open-source agent harness for local, open-weight models.**

A Mac app (and CLI) that turns any model in [Ollama](https://ollama.com) into a coding and computer agent, like Codex or Claude Code but fully local. Its always-on **Daemons** keep working toward a goal in the background.

</div>

---

## Features

- **Agent loop built for small models.** Streams answers, calls tools, feeds results back and repeats. When a model can't use Ollama's native tool calling, a text-based fallback lets it call tools anyway.
- **A small set of tools.** `read_file`, `write_file`, `edit_file` (exact string replace), `list_dir`, `glob`, `grep`, `bash`, `todo_write`, `web_search` (DuckDuckGo, or Brave with `BRAVE_API_KEY`) and `web_fetch`, plus any tools from **MCP** servers.
- **Tool search.** With more than 10 MCP tools connected, the model gets a `search_tools` tool instead of every definition and loads the tools it needs on demand. Small models stay focused, and the prompt stays short.
- **Browser control.** One click in Settings adds the Playwright MCP server, which drives Chrome, Brave, Edge or Arc with a fresh profile.
- **Memory.** The agent saves lasting facts with `remember` and removes them with `forget`. There's one memory for you and one per project, both kept in `~/.openharness/memory` and editable in the app.
- **Hooks.** Shell commands on `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`, in Claude Code's hook format: JSON on stdin, exit code 2 to block. Hooks copied from `~/.claude/settings.json` work as-is.
- **Your MCP servers from Claude Code and Codex.** Open Harness reads the servers you've already set up in Claude Code (`~/.claude.json`, project `.mcp.json`, installed plugins), Codex (`~/.codex/config.toml`) and Claude Desktop. It reads them live and copies nothing. Local (stdio) and remote (HTTP/SSE) servers are supported. Servers that need an OAuth sign-in aren't supported yet.
- **Full context window.** Every model runs with its maximum context by default. You can set a lower cap in Settings to save memory.
- **Permission modes.** `plan`, `read-only`, `ask`, `auto-edit` and `full-auto`. Writes outside the workspace always need your approval. Press Shift+Tab in the composer to cycle modes.
- **Plan mode.** The agent explores read-only, then proposes a plan. You approve it (and pick how much autonomy it gets) or tell it what to change.
- **Projects.** Pin folders in the sidebar. Chats are grouped under their project, and each project has its own default model, default mode and `AGENTS.md` editor.
- **Rewind and review.** Every file edit is checkpointed. Rewind a chat to any message to restore the files and conversation from that point, or open the changes panel to review diffs and revert single files.
- **Slash commands.** Built-ins are `/init` (write an AGENTS.md), `/review`, `/commit`, `/pr`, `/explain`, `/plan`, `/compact`, `/clear`, `/rewind`, `/fork` and `/export`. Add your own as Markdown files in `~/.openharness/commands/` or `.openharness/commands/`. Claude Code's `.claude/commands` folders are read too.
- **@-mentions and images.** Type `@` to attach files with fuzzy completion. Paste or drop images for vision models.
- **Skills.** `SKILL.md` folders in `~/.openharness/skills`, `~/.agents/skills`, `~/.claude/skills` or a project's `.agents/skills`. The model sees each skill's name and description, and loads the full instructions when it needs them.
- **Subagents.** A `task` tool sends broad codebase searches to a read-only subagent, so the main conversation's context stays small.
- **macOS sandbox.** Commands in full-auto mode run under Seatbelt (`sandbox-exec`). They can't write outside the workspace and can't reach the network.
- **Project instructions.** Reads `AGENTS.md` and `OPENHARNESS.md` from the repo, plus global instructions from `~/.openharness/AGENTS.md`. Repos set up for other agents work as-is.
- **Context compaction.** Summarizes older history when the context window fills up, using Ollama's real token counts.
- **Daemons.** Always-on agents with a goal, a schedule, their own memory and an inbox. They report back when something needs your attention and wait for your approval before sensitive actions.
- **Sessions.** Saved to `~/.openharness`, so you can resume them later.

## Quick start

Requirements: macOS, Node.js ≥ 22.12 and [Ollama](https://ollama.com).

```bash
ollama pull qwen3:8b
```

```bash
git clone https://github.com/Jonas1220/openHarness.git
```

```bash
cd openHarness && npm install
```

```bash
npm run dev
```

That opens the app. See [Usage](#usage) for production builds, DMGs and the CLI.

## Usage

Run every command from the repository root.

### Development mode

```bash
npm run dev
```

This opens the app with hot reload: changes to the UI appear right away, and the app restarts when the main process or `packages/core` changes. Stop it with Ctrl+C.

To work on the UI in a normal browser, without Electron or Ollama, run the command below and open the URL it prints. When there's no Electron backend, the UI runs on a scripted mock (`apps/desktop/src/renderer/src/mock.ts`).

```bash
npx vite apps/desktop/src/renderer
```

### Production mode

Build the optimized app:

```bash
npm run build
```

Then run the built version, which is the same code that ships in the DMG:

```bash
npm run preview -w @openharness/desktop
```

### Build a DMG

```bash
npm run dist
```

This builds the app and packages it for Apple Silicon (arm64) and Intel (x64). The DMGs are written to `apps/desktop/release/`, for example `OpenHarness-0.1.0-arm64.dmg`. The version number comes from `version` in `apps/desktop/package.json`.

For a faster build that only targets Apple Silicon:

```bash
cd apps/desktop && npx electron-vite build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64
```

Builds aren't code-signed yet. To install one, open the DMG and drag Open Harness into Applications. The first time you open the app, right-click it and choose **Open**.

### CLI

The same agent also runs in the terminal:

```bash
npm run cli -- -m qwen3:8b
```

Run it with `--help` to see the options. `-p "prompt"` runs a single prompt and exits.

### Tests

```bash
npm test
```

```bash
npm run typecheck
```

## Models

The model needs to be good at tool calling. These work well locally:

| Model | Size | Notes |
| --- | --- | --- |
| `qwen3:8b` / `qwen3:14b` | 5–9 GB | Strong tool use, thinking mode |
| `qwen3-coder:30b` | 19 GB | Best coding quality if you have the RAM |
| `gpt-oss:20b` | 14 GB | Good reasoning, native tool calls |
| `qwen2.5:7b` | 4.7 GB | Older but dependable |
| `llama3.1:8b` | 4.9 GB | Works; weaker at multi-step edits |

## Configuration

`~/.openharness/config.json`:

```json
{
  "ollamaHost": "http://127.0.0.1:11434",
  "defaultModel": "qwen3:8b",
  "mode": "ask",
  "maxContext": 0,
  "think": true,
  "mcpServers": {
    "rea": { "command": "npx", "args": ["-y", "rea-agents@6.4.0", "mcp"] }
  },
  "mcpImport": { "claudeCode": true, "codex": true, "claudeDesktop": true },
  "mcpDisabled": [],
  "toolSearch": "auto",
  "hooks": {
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npm run lint --silent" }] }]
  }
}
```

- `maxContext`: `0` means each model uses its full context window. Any other number caps it, in tokens.
- `mcpImport`: which other agents to read MCP servers from. You can switch single servers off in Settings; they're then listed in `mcpDisabled`.
- `toolSearch`: `auto` loads MCP tools on demand once there are more than 10; `on` always does; `off` sends every tool every time.
- `hooks`: Claude Code's format. Each hook gets the event as JSON on stdin (`tool_name`, `tool_input`, `tool_response`, `prompt`). Exit code 2 blocks and sends stderr to the agent. JSON output with `hookSpecificOutput.permissionDecision` (`allow`, `deny` or `ask`) controls approvals. A `Stop` hook that blocks sends the agent back to work, at most 3 times.
- If a project's `.mcp.json` defines servers, they need your approval on the project page first, unless you already approved them in Claude Code.

`mcpServers` uses the same format as Claude Code and Claude Desktop, for local (`command`) and remote (`"type": "http", "url"`) servers. Add
`"trustedTools": ["tool_name"]` to a server to skip approval for read-only tools you trust.

## Architecture

```
packages/core     Agent loop, Ollama client, tools, permissions, sandbox, MCP, sessions, daemons
packages/cli      Terminal REPL on top of core
apps/desktop      Electron + React Mac app on top of core
docs/research     What we learned from Codex, Claude Code and ChatGPT dots
```

See [docs/research/harness-study.md](docs/research/harness-study.md) for the
design rationale.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘N | New chat (in the current project) |
| ⇧⌘O | Add project |
| ⌘K | Search chats |
| ⇧⌘P / Shift+Tab | Toggle plan mode / cycle permission modes |
| ⌘, | Settings |
| Esc | Stop the agent |

## Daemons

A daemon is an agent that keeps running after you close the chat. Give it:

- a **goal** (what to work toward or watch)
- a **schedule** (manual, every N minutes, or daily at a set time)
- a **workspace** folder and a **permission mode**

On each run it gets its goal, its memory file and the summary of its last run. It works with the normal tools plus `report_to_user` and `update_memory`. Reports land in the **Inbox** and show up as macOS notifications. When a daemon needs approval, the request waits in the inbox for up to 30 minutes and is then denied. Closing the window keeps Open Harness in the menu bar, so daemons keep running.

## Contributing

Issues and PRs are welcome. Run `npm test` and `npm run typecheck` before you open a PR. For UI work, the browser mode under [Development mode](#development-mode) is the quickest loop.

## License

[MIT](LICENSE)
