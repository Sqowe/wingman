# Changelog

All notable changes to **Sqowe Wingman** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Setting to toggle Claude Code memory sharing** — `sqoweWingman.shareClaudeMemory`
  (default `true`) turns the read-only Claude Code memory bridge on or off. Toggling
  reloads the agent to apply, and disabling clears the "Project memory" banner group.
  Complements the lower-level `WINGMAN_CLAUDE_MEMORY=off` environment override.

## [0.1.10] - 2026-07-12

### Added

- **Claude Code memory sharing (read-only)** — when a project also has a Claude
  Code memory folder (`~/.claude/projects/<slug>/memory/`), Wingman now loads a
  bundled pi extension that reads that folder and appends its facts to pi's
  system prompt, so the pi agent shares what Claude Code has already learned
  about the project. Sharing is strictly one-way and read-only — the extension
  never writes, updates, or deletes the memory. Injection is resolved once per
  session and appended byte-identically each turn for KV-cache stability, bounded
  by a char budget (`WINGMAN_CLAUDE_MEMORY_MAX_CHARS`, default 12 000) with
  overflow files listed by name. Disable with `WINGMAN_CLAUDE_MEMORY=off`.
  Shared memories are surfaced in the pi status banner as a read-only "Project
  memory" group: the banner shows a `· N memories` count and the popover lists
  each fact (capped at 8, with a "+N more" row that opens the memory folder).
  Clicking a row opens that memory file in the editor — the host guards every
  open to the reported memory folder so an arbitrary path can never be opened.

## [0.1.9] - 2026-07-10

### Added

- **Collapsible long user messages** — a long prompt in the chat window now
  collapses to a bounded height with a soft gradient fade and a
  "Show more / Show less" toggle, so a wall-of-text prompt no longer pushes the
  assistant's reply out of view. Short messages are unaffected; the collapse
  decision is measured from the rendered height, not a fixed character count.

### Changed

- **Minimum tested pi version raised to `0.80.0`** — `PI_MINIMUM_VERSION` in the
  pi locator now expects pi `0.80.0` or newer. Older versions still run but
  trigger the non-blocking below-minimum warning. Wingman's newer features are
  developed against and verified on the pi 0.80.x line.

## [0.1.8] - 2026-07-07

### Added

- **Context-window indicator in the session-stats status bar** — the status bar
  item now shows your current context-window usage as
  `tokens used / window · percent · message count` (e.g.
  `12.4k tok / 200k tok · 6 · 85 msg`). The denominator updates immediately
  on model switch, and pi's documented post-compaction transient renders as
  a `— / window · — · messages` placeholder so you still see the model
  window size while waiting for the next assistant response. Hover for a
  two-line tooltip (`Context: ... · Messages: N`); click to open the Show
  Stats popup. Powered by `pi.get_session_stats().contextUsage` — see the
  design note in [`docs/design/context-window-indicator.md`](docs/design/context-window-indicator.md).

### Changed

- **Session-stats status bar dropped the `cost` slot** — cost is rarely useful
  in practice and competed for space with the new context-window reading.
  Cost is also dropped from the Show Stats popup for the same reason.

### Fixed

- **Status-bar tokens / cost always rendered as `0 tok` / `$0.0000`** — the
  controller's `_fetchSessionStats` parser read `data.totalTokens` and
  `data.totalCost`, but pi's `get_session_stats` response nests totals under
  `data.tokens.total` and exposes cost at top-level `data.cost`. The status
  bar now reports the actual values. (Existing unit tests passed only
  because their mock fixtures mirrored the wrong field names; both are now
  corrected to use pi's real payload shape.)
- **`formatTokens(null)` / `formatCost(null)` rendered as `0 tok` / `$0.0000`**
  — `Number(null) === 0` coerced the missing values into `0`. They now
  render as the em-dash placeholder `—`.
- **`formatTokens(200000)` rendered as `200.0k tok`** — round thousands now
  drop the trailing `.0` (`200k tok`), matching conventional k / M notation.

## [0.1.7] - 2026-07-03

### Changed

- **Slash command / skill selection no longer fires immediately** — picking an
  entry from the `/` autocomplete menu now inserts `/name ` into the composer
  and parks the cursor after it, so you can type arguments or free-text
  instructions for the LLM before pressing Enter/Send. The menu stays closed
  once a space or argument text follows the command name, preventing it from
  reopening while you type.

### Added

- **Argument hints in the slash menu** — prompt templates that declare an
  `argument-hint` in their frontmatter (e.g. `<PR-URL>` or `[instructions]`)
  now show that hint between the command name and description in the autocomplete
  dropdown. The hint is surfaced from pi's `get_commands` RPC response and passed
  through the host→webview message contract (`PiCommand.argumentHint`). Skills
  and extension commands (which do not use frontmatter argument-hints) are
  unaffected.

## [0.1.6] - 2026-07-02

### Fixed

- **Busy flag stuck after session switch** — a turn abandoned without a clean
  `agent_end` (e.g. superseded by a new or switched-to session) left the
  streaming flag stuck `true`, permanently rejecting prompts in the new
  session with a stale "busy" error.
- **Instruction files popover hidden behind messages** — the popover relied
  on an incidental hover-triggered `filter` to get its own stacking context,
  so it rendered behind the message list until the mouse moved over it. The
  status banner now establishes a stacking context unconditionally.

## [0.1.5] - 2026-07-02

### Added

- **Instruction file visibility** — the status banner now shows how many
  instruction files pi loaded for the current session (`pi 0.80.3 ready · 2 instructions`)
  and opens a popover on click listing each file annotated with its scope and role:
  e.g. `AGENTS.md (global)`, `CLAUDE.md (project)`,
  `SYSTEM.md (project, replaces default)`, `APPEND_SYSTEM.md (project, appended)`.
  Data comes from pi itself via a bundled pi extension
  (`pi-extensions/instruction-report/`) that calls `ctx.getSystemPromptOptions()`
  — not a host-side filesystem guess — so the list reflects exactly what pi
  actually loaded. The banner collapses from two lines to one; the path and file
  list move into the absolutely-positioned popover (no document-flow impact,
  no `ResizeObserver` noise). Graceful degradation: if the command is absent
  (old pi, extension load failure) or times out, the popover shows an explanatory
  note; confirmed zero files renders differently from "unknown". Re-fires on every
  session (re)start, trust change, and Reload pi Agent.

- **Reload pi Agent** — restarts the pi sidecar in place via a new
  `sqoweWingman.reloadAgent` command, available from the chat view-title `⋯`
  overflow menu and the Command Palette. Re-resolves the pi binary on every
  reload (picks up `npm i -g` updates, nvm version switches, or a changed
  `sqoweWingman.piExecutablePath`) and preserves the current conversation by
  capturing the session file via `get_state` and resuming with
  `pi --session <path>`. If the session file is gone, falls back to a fresh
  session and notifies the user. A modal confirmation is required before
  restart; the command is greyed out while pi is mid-turn via a new
  `sqoweWingman.agentBusy` VS Code context key (set by `agent_start` /
  `agent_end` events). No webview changes.

## [0.1.4] - 2026-06-29

### Added

- **Rename Session…** — right-click any session row in the SESSIONS tree to override its
  title with your own text. The override is stored as a `source:"manual"` entry in the
  existing title index (`~/.pi/agent/sessions/.wingman-titles.json`) and takes top
  precedence over the derived first-message title. Submitting an empty value resets to the
  default; accepting the prefilled value unchanged is a no-op; Esc cancels. Fully offline —
  no LLM, no network. Context-menu only (hidden from the Command Palette). Backed by a pure
  `planRename` helper and serialized, atomic index writes; refresh failures are reported
  distinctly from rename failures.

- **Meaningful session titles** — rows in the SESSIONS tree (and the switch-session
  picker) now show a human-readable title derived from each session's first user message
  (whitespace-collapsed, capped at ~60 characters on a word boundary) instead of the raw
  `<timestamp>_<uuid>` filename. The date moves into the row description
  (`27 Jun · 240 msgs`); the full path, working directory, message count, created date,
  and session id stay in the tooltip. Titles resolve through override → pi header `name`
  → first user message → filename, so nothing is ever nameless. Fully offline — no
  session content leaves the machine. A title-index sidecar
  (`~/.pi/agent/sessions/.wingman-titles.json`) is defined and read now, ready for a
  future manual-rename command and LLM-generated titles (Phase 2).

- **Configurable edit-card action buttons** — the View Diff and Apply buttons on
  completed `edit` tool cards are now controllable via a new
  `sqoweWingman.editToolActions` setting: `both` (default), `diffOnly`, `applyOnly`,
  or `none`. Changes apply live to the running chat: the host pushes the value to the
  webview as a new `chatConfig` capability message (cached, replayed on webview `ready`,
  and re-pushed on configuration change), and each button is gated independently on the
  incoming flags after a normalizer guards the host→webview boundary.

## [0.1.3] - 2026-06-26

### Added

- **Copy code blocks** — fenced code blocks in assistant messages now reveal a
  copy button in the top-right corner on hover (and on keyboard focus). It
  copies the block's clean source text rather than the rendered markup, reusing
  the same size-guarded clipboard path as the other copy buttons.

## [0.1.2] - 2026-06-25

### Changed

- **Composer layout** — the prompt input and its actions now share a single
  bordered shell with an inset bottom toolbar (attach on the left, Send on the
  right). The image-attachment control is a borderless paperclip icon on the
  input's bottom edge, replacing the boxed ＋, and its tooltip now shows
  reliably even when the active model is text-only.

## [0.1.1] - 2026-06-24

### Added

- **Image attachments** — send images to the agent alongside a prompt via a ＋
  button (file picker), clipboard paste, or drag-and-drop. Attachments show as
  thumbnail chips with per-image removal; image-only prompts are allowed. Gated
  on the active model's modality: when the model is text-only the control is
  disabled and pasted/dropped images are ignored with a brief note. Enforced
  size and count caps (5 MB per image, 20 MB total, 10 images) plus a MIME
  allowlist, validated on both the webview and the extension host.

### Fixed

- **Chat auto-scroll** — streaming output no longer leaves the last line clipped
  below the fold. The transcript re-pins to the true bottom once the final row's
  height settles, instead of lagging one delta behind.

## [0.1.0] - 2026-06-24

First preview release. A VS Code client for the
[pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):
the extension host spawns `pi --mode rpc` as a child process, renders pi's agent
event stream natively in a webview, and wires pi's `edit` tool into VS Code's
diff editor.

### Added

- **Chat** — composer with live-streaming assistant text and thinking, mid-turn
  abort, markdown rendering with link-safety, and busy / rate-limit gating.
- **Tool cards** — collapsible `tool_execution_*` cards with live output
  streaming and copy buttons that yield clean source text.
- **Native diff** — completed `edit` tools offer *View Diff* / *Apply*: a
  read-only diff editor (before↔after served by a `wingman-diff:` content
  provider) and apply-as-`WorkspaceEdit` that surfaces in Source Control.
  Workspace-boundary and TOCTOU hardening on every file operation.
- **Commands** — `/` slash autocomplete in the composer, plus native built-ins
  (set / cycle model, set / cycle thinking level, compact, new / fork / clone
  session, export HTML, session stats) wired to RPC and exposed in the command
  palette, view title bar, and a status bar item.
- **Extension UI protocol** — pi's `select` / `confirm` / `input` / `editor`
  dialogs map to native quick-picks, modals, and input boxes;
  `notify` / `setStatus` / `setWidget` / `setTitle` map to native surfaces.
- **Sessions** — an activity-bar tree scoped to the open workspace folder(s);
  list / switch / resume with full-fidelity transcript restore, and auto-refresh.
- **Config / trust** — project-trust gate (native Trust / Don't Trust modal
  backed by pi's `~/.pi/agent/trust.json`, passed to pi as `--approve` /
  `--no-approve`) and a multi-root folder picker with per-folder trust and
  automatic restart when the active folder changes.

### Requirements

- The [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) CLI
  must be installed (tested against pi 0.79.x). It is not bundled; resolve it via
  the `sqoweWingman.piExecutablePath` setting or automatic detection from `PATH`
  and common install locations.

[Unreleased]: https://github.com/sqowe/wingman/compare/v0.1.10...HEAD
[0.1.10]: https://github.com/sqowe/wingman/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/sqowe/wingman/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/sqowe/wingman/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/sqowe/wingman/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/sqowe/wingman/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sqowe/wingman/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sqowe/wingman/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sqowe/wingman/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sqowe/wingman/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sqowe/wingman/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sqowe/wingman/releases/tag/v0.1.0
