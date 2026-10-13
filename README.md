<div align="center">

# openHarness

**An open-source agent harness for local, open-weight models.**

A Mac app (and CLI) that turns any model in [Ollama](https://ollama.com) into a coding and computer agent, like Codex or Claude Code but fully local. Its always-on **Daemons** keep working toward a goal in the background.

</div>

---

## Features

- **Agent loop built for small models.** Streams answers, calls tools, feeds results back and repeats. When a model can't use Ollama's native tool calling, a text-based fallback lets it call tools anyway.
- **A small set of tools.** `read_file`, `write_file`, `edit_file` (exact string replace), `list_dir`, `glob`, `grep`, `bash`, `todo_write` and `web_fetch`, plus any tools from **MCP** servers.
- **Permission modes.** `read-only`, `ask`, `auto-edit` and `full-auto`. Writes outside the workspace always need your approval.
- **macOS sandbox.** Commands in full-auto mode run under Seatbelt (`sandbox-exec`). They can't write outside the workspace and can't reach the network.
- **Project instructions.** Reads `AGENTS.md` and `OPENHARNESS.md`, so repos set up for other agents work as-is.
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

The last command starts the desktop app in development mode. To build a `.dmg`:

```bash
npm run dist
```

The DMG lands in `apps/desktop/release/`. Builds aren't signed yet, so the first time you open the app, right-click it and choose **Open**.

Or use the CLI:

```bash
npm run cli -- -m qwen3:8b
```

### Which models work well?

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

## Daemons

A daemon is an agent that keeps running after you close the chat. Give it:

- a **goal** (what to work toward or watch)
- a **schedule** (manual, every N minutes, or daily at a set time)
- a **workspace** folder and a **permission mode**

On each run it gets its goal, its memory file and the summary of its last run. It works with the normal tools plus `report_to_user` and `update_memory`. Reports land in the **Inbox** and show up as macOS notifications. When a daemon needs approval, the request waits in the inbox for up to 30 minutes and is then denied. Closing the window keeps openHarness in the menu bar, so daemons keep running.

## Contributing

Issues and PRs are welcome. Run `npm test` and `npm run typecheck` before you open a PR.

To work on the UI without Electron or Ollama, run `npx vite apps/desktop/src/renderer` and open the URL it prints in a browser. When the preload API is missing, the UI uses a scripted mock backend (`src/renderer/src/mock.ts`).

## License

[MIT](LICENSE)
