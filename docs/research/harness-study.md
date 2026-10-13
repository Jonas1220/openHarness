# Harness study: what openHarness borrows from Codex, Claude Code and ChatGPT dots

This note records what we learned from existing agent harnesses before writing
openHarness, and which of those ideas made it into the design.

## Sources

| Harness | How it was studied | License |
| --- | --- | --- |
| [OpenAI Codex CLI](https://github.com/openai/codex) | Read the Rust source (`codex-rs/core`, `sandboxing`, `prompts`, `ollama`) | Apache-2.0 |
| Claude Code | Public documentation and observed behaviour only | Proprietary — **no code or prompts copied** |
| ChatGPT dots | Public announcement coverage (Sept 2026) | — |
| [REA](https://github.com/morluto/rea) | Evaluated as the reverse-engineering tool for this study (see below) | MIT |

### A note on REA

REA's JavaScript analyzer works on extracted bundles, and its native analysis
needs Hopper, Ghidra or IDA. Codex is open source, so reading its source was
more precise than reverse engineering its binary. Claude Code ships as a
Bun-compiled Mach-O binary. We decided not to extract or redistribute anything
from it. Instead we relied on its public docs and on how it behaves when used.
openHarness supports MCP, so REA can be added as a tool server (see the README).

## Patterns adopted

### 1. The agent loop (both harnesses)
A turn is a loop: *model streams → zero or more tool calls → tool results are
appended as `tool` messages → repeat until the model answers without calling a
tool*. Both harnesses bound the loop and let the user interrupt at any point.
→ `packages/core/src/agent.ts`

### 2. Small, sharp tool set (Claude Code style)
Claude Code exposes a small set of tools: read, write, string-replace edit,
glob, grep, bash, todo list and web fetch. Codex uses a custom `apply_patch`
grammar instead. Small open models make far fewer mistakes with
**exact-string replacement** than with a patch grammar, so openHarness uses
`edit_file(old_string, new_string)` and checks that `old_string` is unique.
→ `packages/core/src/tools/`

### 3. Approval policy × sandbox mode (Codex)
Codex separates *when to ask* (`untrusted`, `on-request`, `never`) from *what
a command may touch* (`read-only`, `workspace-write`, `danger-full-access`).
openHarness simplifies this into four modes the user can understand:

| Mode | File edits | Shell commands |
| --- | --- | --- |
| `read-only` | blocked | read-only sandbox, ask for anything else |
| `ask` (default) | ask | ask |
| `auto-edit` | auto inside workspace | ask |
| `full-auto` | auto inside workspace | auto, **sandboxed** to workspace + no network |

Writes outside the workspace always require approval. "Allow for this session"
remembers approvals per tool and command prefix.
→ `packages/core/src/permissions.ts`

### 4. macOS Seatbelt sandbox (Codex)
Codex runs commands through `/usr/bin/sandbox-exec` with an SBPL profile.
It always uses the absolute `/usr/bin` path so a binary planted on `PATH` can't
take its place. It passes writable roots as `-D` parameters instead of
interpolating paths into the profile. openHarness does the same, with a smaller
profile: allow by default, deny writes outside the workspace and temp dirs, and
deny outbound network except to localhost.
→ `packages/core/src/sandbox.ts`

### 5. Project instructions files (both)
Codex reads `AGENTS.md`, and Claude Code reads `CLAUDE.md`, from the home
directory and from every directory between the repo root and the working
directory. openHarness reads `AGENTS.md` and `OPENHARNESS.md`, so existing
repos work without changes.
→ `packages/core/src/context.ts`

### 6. Context compaction (both)
When the context nears its limit, the older history is replaced by a
model-written handoff summary and the most recent messages are kept.
openHarness reads the real prompt token count from Ollama's
`prompt_eval_count`, so it needs no tokenizer.
→ `packages/core/src/compaction.ts`

### 7. Plan / todo tool (both)
Both harnesses give the model a tool to keep a visible checklist. This matters
even more for small models, which lose track of multi-step work.
→ `todo_write`

### 8. MCP client (both)
Tool servers use the Claude Desktop `mcpServers` config format. Their tools
are exposed as `mcp__<server>__<tool>`.
→ `packages/core/src/mcp.ts`

### 9. Persistent mode / always-on agents (Codex `persistent_mode`, ChatGPT dots)
ChatGPT dots are always-on agents. You give one a goal; it works toward it
between conversations, keeps memory, reports back only when something needs
attention, and still asks before sensitive actions. Codex's persistent-mode
prompt adds useful rules: close open loops, don't invent work, define a
stopping condition, and don't send duplicate messages.
openHarness implements this as **Daemons**. Each one runs locally on a
schedule against a local model, with a memory file, an inbox, and approval
requests that wait for the user.
→ `packages/core/src/daemons.ts`

## Ollama-specific findings

* **Set `num_ctx` explicitly.** Ollama's default context window is small, and
  silently truncating the prompt breaks tool use. We use the model's
  `context_length` from `/api/show`, capped by a user setting.
* **Read `capabilities` from `/api/show`** (`tools`, `thinking`, `vision`) to
  decide between native tool calling and the text fallback.
* **Text fallback for tool calls.** Many open models print tool calls as JSON
  or inside `<tool_call>` tags instead of using the structured field.
  openHarness parses both.
