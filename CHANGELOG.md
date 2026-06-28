# Changelog

All notable changes to **Sqowe Wingman** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/sqowe/sqowe-wingman/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/sqowe/sqowe-wingman/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sqowe/sqowe-wingman/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sqowe/sqowe-wingman/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sqowe/sqowe-wingman/releases/tag/v0.1.0
