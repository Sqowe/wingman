# pi-extensions/codex-memory

Bundled pi extension that shares **OpenAI Codex's local memories** with pi,
read-only, so an agent running under pi benefits from the facts Codex has
already learned on this machine.

This mirrors `pi-extensions/claude-memory` ("share, don't update"): pi reads
Codex's memory store but never writes to it. Codex remains the sole owner of
that folder.

## What it does

On `session_start` it:

1. Resolves Codex's memory dir for this machine (see [Memory source](#memory-source)).
2. Builds a markdown block: `memory_summary.md` always whole, plus — depending
   on the scope setting — task-group blocks from `MEMORY.md`.
3. Reports the artifact list back to Wingman via the reserved status key
   `ctx.ui.setStatus('wingman:codexMemory', JSON.stringify({ dir, count, files }))`
   (see [Status key](#status-key)).

Then on every `before_agent_start` it appends that block to pi's system prompt,
under a `## Codex memory (shared, read-only)` heading, with a note telling the
agent to treat the facts as point-in-time and not to edit them.

The block is resolved once per session and injected byte-identically on every
turn, so the system-prompt prefix stays stable for KV caching.

## Memory source

Codex (CLI, the VS Code extension, and the ChatGPT desktop app share one store
per machine) keeps local memories under `$CODEX_HOME` (default `~/.codex`), in
`memories/` (layout v1) or `memories_v2/` (layout v2):

```
~/.codex/memories_v2/           (or memories/ — v1)
  memory_summary.md             # dense summary, prompt-loaded by Codex itself
  MEMORY.md                     # task-group handbook ("# Task Group:" blocks)
  skills/<skill-name>/SKILL.md  # extracted reusable procedures
  rollout_summaries/<slug>.md   # per-session recaps + evidence
  raw_memories.md               # consolidation temp file (never injected)
```

The store is **global per machine** — unlike Claude Code's per-project folder,
project scope lives *inside* the content: each `MEMORY.md` task-group block
carries a mandatory `applies_to: cwd=<dir>; reuse_rule=…` tag, and
`memory_summary.md`'s "What's in Memory" index is organized by cwd/project
scope. The extension prefers `memories_v2` when it holds memory artifacts
(Codex's config selects the layout; we do not parse `config.toml`), and falls
back to `memories/`. `raw_memories.md` is never injected.

If no such folder exists (Codex memories are off by default), the extension is
inert (nothing injected, no status).

## Configuration

| Env var | Values | Default | Description |
| --- | --- | --- | --- |
| `WINGMAN_CODEX_MEMORY` | `off` | unset | Set to `off` to disable the extension entirely. |
| `WINGMAN_CODEX_MEMORY_SCOPE` | `summary` \| `project` \| `all` | `summary` | What to inject beyond `memory_summary.md`: nothing (the summary already routes into `MEMORY.md`); only `MEMORY.md` task-group blocks whose `applies_to: cwd=` matches the current workspace; or every block. `project` matches when the tag equals the workspace, is an ancestor of it, or is a descendant of it — the git root counts only as an identity or an ancestor, so a workspace in a monorepo subfolder never pulls in sibling packages. Untagged blocks are excluded from `project`. Unrecognized values fall back to `summary`. |
| `WINGMAN_CODEX_MEMORY_MAX_CHARS` | integer | `12000` | Budget for inlined `MEMORY.md` task-group blocks. `memory_summary.md` itself is always inlined whole and does not consume the budget. Whole blocks are included until the budget is hit; the remainder is listed by name for the agent to read on demand (never mid-cut). When the store has no summary, the registry stands in for it — still scope- and budget-filtered, never dumped whole. |
Wingman wires these from the `sqoweWingman.shareCodexMemory`,
`sqoweWingman.codexMemoryScope` and `sqoweWingman.codexMemoryMaxChars`
settings (see the host README).

### Size bounds

Two bounds keep the injected text predictable:

- **`WINGMAN_CODEX_MEMORY_MAX_CHARS`** — the char budget for the `MEMORY.md`
  task-group blocks. The summary is not charged against it.
- **A hard cap on `memory_summary.md` (100 000 chars)** — the summary is
  injected whole, so an oversized or corrupted file would otherwise inflate
  every turn's system prompt without limit. Past the cap the summary is
  truncated with a marker telling the agent to read the full file on demand.

## Status key

`wingman:codexMemory` — a **reserved** status key (like `wingman:claudeMemory`).
Wingman's `UiProtocolBridge` intercepts it before it can reach the generic
status strip, parses the JSON payload (`{ dir, count, files: [{ path, title }] }`),
and renders a read-only **Codex memory** group inside the `PiStatusBanner`
popover — each row opens that memory file in the editor.

The payload lists **every** memory artifact (summary, registry, rollout
summaries, skill entrypoints), independent of which subset the scope/char
budget inlined into the prompt — up to a transmit cap of 200 entries to keep
the RPC payload bounded (`count` still carries the true total, and the banner
shows a "+N more" row that reveals the memory folder). If the payload is
malformed or unreadable, the host treats it as "no memory" and shows no group.

## Loading

Like `claude-memory`, this extension is loaded by pi via `-e <absolute-path>`
when Wingman spawns the agent, gated by the `sqoweWingman.shareCodexMemory`
setting (see `src/extension.ts` and `src/agent/controller.ts`).

> **Double-load caveat:** if this extension is *also* globally `pi install`ed
> (listed under `packages` in `~/.pi/agent/settings.json`), pi loads it twice and
> the memory block is injected twice. The ship path is the bundled `-e`; remove
> any global install to avoid duplication.

## Why plain JavaScript

No build step is needed for a single-file pi extension. Keeping it plain JS lets
pi load the file directly via `-e <path>` with no compilation pipeline in the
VSIX build. This is the standing convention for all bundled pi extensions in
this repo — each gets its own folder under `pi-extensions/<name>/` with a
`README.md`.

## Fallback behaviour

- **No memory store on the machine**: inert — nothing injected, no report sent.
- **Store exists but holds no artifacts**: inert.
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
