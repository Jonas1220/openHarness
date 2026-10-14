<div align="center">

# Open Harness

**An open-source agent harness for local, open-weight models.**

A Mac app (and CLI) that turns any model in [Ollama](https://ollama.com) into a coding and computer agent, like Codex or Claude Code but fully local. Its always-on **Daemons** keep working toward a goal in the background.

</div>

---

## Features

- **Agent loop built for small models.** Streams answers, calls tools, feeds results back and repeats. When a model can't use Ollama's native tool calling, a text-based fallback lets it call tools anyway.
- **A small set of tools.** `read_file`, `write_file`, `edit_file` (exact string replace), `list_dir`, `glob`, `grep`, `bash`, `todo_write` and `web_fetch`, plus any tools from **MCP** servers.
- **Permission modes.** `plan`, `read-only`, `ask`, `auto-edit` and `full-auto`. Writes outside the workspace always need your approval. Press Shift+Tab in the composer to cycle modes.
- **Plan mode.** The agent explores read-only, then proposes a plan. You approve it (and pick how much autonomy it gets) or tell it what to change.
- **Projects.** Pin folders in the sidebar. Chats are grouped under their project, and each project has its own default model, default mode and `AGENTS.md` editor.
- **Rewind and review.** Every file edit is checkpointed. Rewind a chat to any message to restore the files and conversation from that point, or open the changes panel to review diffs and revert single files.
- **Slash commands.** Built-ins are `/init` (write an AGENTS.md), `/review`, `/explain`, `/plan`, `/compact`, `/clear` and `/rewind`. Add your own as Markdown files in `~/.openharness/commands/` or `.openharness/commands/`. Claude Code's `.claude/commands` folders are read too.
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
  "maxContext": 16384,
  "think": true,
  "mcpServers": {
    "rea": { "command": "npx", "args": ["-y", "rea-agents@6.4.0", "mcp"] }
  }
}
```

`mcpServers` uses the same format as Claude Desktop and Cursor. Add
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
