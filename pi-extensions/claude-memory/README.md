# pi-extensions/claude-memory

Bundled pi extension that shares **Claude Code's project memory** with pi,
read-only, so an agent running under pi benefits from the facts Claude Code has
already learned about the project.

This is the "share, don't update" first step: pi reads Claude Code's memory but
never writes to it. Claude Code remains the sole owner of that folder.

## What it does

On `session_start` it:

1. Resolves Claude Code's memory folder for the current project (see
   [Memory source](#memory-source)).
2. Builds a single markdown block from `MEMORY.md` (the index) plus the
   individual fact files, stripping YAML frontmatter.
3. Reports a count back to Wingman via `ctx.ui.setStatus('Memory', '<n> memories …')`.

Then on every `before_agent_start` it appends that block to pi's system prompt,
under a `## Project memory (shared from Claude Code — read-only)` heading, with a
note telling the agent to treat the facts as point-in-time and not to edit them.

The block is resolved once per session and injected byte-identically on every
turn, so the system-prompt prefix stays stable for KV caching.

## Memory source

Claude Code stores per-project memory at:

```
~/.claude/projects/<encoded-cwd>/memory/
  MEMORY.md            # one-line index of every fact
  <slug>.md            # one file per fact (YAML frontmatter + body)
```

The project path is encoded by replacing both `/` and `.` with `-`
(e.g. `/Users/me/src/app` → `-Users-me-src-app`). The extension reproduces that
encoding, trying the cwd first and then the git root — so launching pi from a
subdirectory still resolves the project's memory.

If no such folder exists, the extension is inert (nothing injected, no status).

## Configuration

| Env var | Values | Default | Description |
| --- | --- | --- | --- |
| `WINGMAN_CLAUDE_MEMORY` | `off` | unset | Set to `off` to disable the extension entirely. |
| `WINGMAN_CLAUDE_MEMORY_MAX_CHARS` | integer | `12000` | Budget for eagerly inlined memory. Whole fact files are included until the budget is hit; the remainder is listed by name for the agent to read on demand (never mid-cut). |

## Status key

`Memory` — a **generic** status key (unlike `instruction-report`'s reserved
`wingman:instructionFiles`), so it flows through `UiProtocolBridge` to the
webview's generic status strip and renders as `Memory: 4 memories from Claude Code`.

> A later "Level 2" change may instead surface project memory inside the
> `PiStatusBanner` popover, alongside the instruction files, as its own
> read-only group. That requires a Wingman-side change and is out of scope here.

## Loading

Like `instruction-report`, this extension is meant to be loaded by pi via
`-e <absolute-path>` when Wingman spawns the agent. Wingman currently passes a
single bundled `-e` (the instruction reporter); loading this one as well is a
small spawn change in `src/extension.ts` / `src/agent/controller.ts` and is the
immediate next step.

## Why plain JavaScript

No build step is needed for a single-file pi extension. Keeping it plain JS lets
pi load the file directly via `-e <path>` with no compilation pipeline in the
VSIX build. This is the standing convention for all bundled pi extensions in this
repo — each gets its own folder under `pi-extensions/<name>/` with a `README.md`.

## Fallback behaviour

- **No memory folder for the project**: inert — nothing injected, no status set.
- **Folder exists but has no fact files**: inert.
- **Read error**: caught and swallowed — sharing is best-effort and never breaks
  the session.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Extension entry point — loaded by pi via `-e <absolute-path>` |
| `README.md` | This file |
