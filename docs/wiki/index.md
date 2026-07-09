<!-- sources: README.md, ARCHITECTURE.md, package.json#contributes -->

# Sqowe Wingman

Sqowe Wingman brings the pi coding agent into VS Code. Instead of driving pi from a
terminal, you chat with it in a panel inside your editor: the agent's replies stream in
live, every tool it runs shows up as a card you can expand, and any file it edits opens in
VS Code's real diff editor so you decide what to keep.

Wingman is a front-end, not a separate tool. It reuses pi's own configuration — the same
`~/.pi/agent/` global setup and per-project `.pi/` resources your terminal `pi` already
uses. You log in once with pi, and both the CLI and Wingman share it. Sessions you start in
one show up in the other.

## What you can do

- **Chat with the agent** — streaming replies, thinking, mid-turn stop, and clean markdown → [guide](features/chat.md)
- **Review every tool call** — a collapsible card per tool run, with copy buttons → [guide](features/chat.md)
- **See edits as real diffs** — open file changes in the diff editor or apply them as pending changes → [guide](features/diff.md)
- **Run commands** — type `/` for pi's slash commands, or use native VS Code commands for model, thinking level, compact, fork/clone, and export → [guide](features/commands.md)
- **Manage sessions** — a Sessions tree for the current workspace, with switch, resume, and rename → [guide](features/sessions.md)
- **Track context usage** — a status bar item showing tokens used against the model's context window → [guide](features/session-stats.md)
- **Answer prompts natively** — pi's permission and input prompts render as VS Code dialogs → [guide](features/dialogs.md)
- **Control project trust** — approve project `.pi/` resources before they load, and pick a folder in multi-root workspaces → [guide](features/trust.md)
- **See which instruction files are active** — the status banner lists the files pi loaded for the session → [guide](features/instruction-files.md)
- **Reload the agent** — restart pi in place to pick up config or a new pi binary, without losing the conversation → [guide](features/reload-agent.md)
- **Attach images** — send images alongside your prompt when the model supports them → [guide](features/images.md)

## Get started

New here? Start with [Getting started](getting-started.md) — install pi, log in once, and
send your first prompt.

## Reference

- [All commands](reference/commands.md)
- [All settings](reference/settings.md)
