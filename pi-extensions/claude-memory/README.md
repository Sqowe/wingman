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
3. Reports the full fact list back to Wingman via the reserved status key
   `ctx.ui.setStatus('wingman:claudeMemory', JSON.stringify({ dir, count, files }))`
   (see [Status key](#status-key)).

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

`wingman:claudeMemory` — a **reserved** status key (like `instruction-report`'s
`wingman:instructionFiles`). Wingman's `UiProtocolBridge` intercepts it before it
can reach the generic status strip, parses the JSON payload
(`{ dir, count, files: [{ path, title }] }`), and renders a read-only
**Project memory** group inside the `PiStatusBanner` popover — the banner shows a
`· N memories` count and each row opens that memory file in the editor.

The payload lists **every** fact file (so any row is clickable), independent of
which subset the char budget (see [Configuration](#configuration)) inlined into
the prompt — up to a transmit cap of 200 entries to keep the RPC payload bounded
(`count` still carries the true total, and the banner shows a "+N more" row that
reveals the memory folder). Titles are parsed from the `MEMORY.md` index links
(`- [Title](slug.md)`), falling back to the filename slug.

If the payload is malformed or unreadable, the host treats it as "no memory" and
shows no group.

## Loading

Like `instruction-report`, this extension is loaded by pi via
`-e <absolute-path>` when Wingman spawns the agent. Wingman declares both bundled
extensions in `src/extension.ts` and passes one `-e` per existing file through
`src/agent/controller.ts`.

> **Double-load caveat:** if this extension is *also* globally `pi install`ed
> (listed under `packages` in `~/.pi/agent/settings.json`), pi loads it twice and
> the memory block is injected twice. The ship path is the bundled `-e`; remove
> any global install to avoid duplication.

## Why plain JavaScript

No build step is needed for a single-file pi extension. Keeping it plain JS lets
pi load the file directly via `-e <path>` with no compilation pipeline in the
VSIX build. This is the standing convention for all bundled pi extensions in this
repo — each gets its own folder under `pi-extensions/<name>/` with a `README.md`.

## Fallback behaviour

- **No memory folder for the project**: inert — nothing injected, no report sent.
- **Folder exists but has no fact files**: inert.
- **Read error**: caught and swallowed — sharing is best-effort and never breaks
  the session.
- **Never writes**: the extension has no write path; the injected text tells the
  agent not to edit the files, but the guarantee is structural (read-only by
  construction).

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Extension entry point — loaded by pi via `-e <absolute-path>` |
| `README.md` | This file |
