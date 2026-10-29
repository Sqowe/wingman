# Changelog

All notable changes to **Sqowe Wingman** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.4] - 2026-10-29

### Fixed

- **"Type something." now gives you a field to type in, instead of asking you
  to pick an option again.** The row is a sentinel the asking extension adds to
  every single-choice question; choosing it made it ask for your own answer —
  and since version 2.13 it repeats the option list in that request, which
  Wingman took for a multiple-choice question and drew as checkboxes. There was
  no way to write anything. The request is now recognised for what it is and
  drawn as a card with a text field: your answer is sent back verbatim, and the
  repeated option list stays collapsed next to the field as reference.

  The two requests are told apart by the answer format the extension declares
  with the request: multiple choice declares one ("1,3"), a free-text answer
  does not. An extension that offers a numbered list without declaring a format
  now gets a text field instead of checkboxes — typing `1,3` still works.

- **Typing in a question card's answer field no longer yanks the transcript
  away.** The card keeps the half-typed answer in the store, so every
  keystroke re-rendered the list — and the list scrolled to the bottom on
  *every* render, to a position computed from cached row heights. When one of
  those heights was stale (a row measured while the panel was hidden, or the
  heights left over from a previous session), the target sat a screen above the
  content, and the view jumped up to the beginning of the last model output on
  every character. The list now follows the bottom only when the bottom
  actually moves — a new message, a taller row, a resized panel — and a row
  that reports a zero height (a hidden panel measures nothing) no longer
  replaces the height it had.

- **A long or restored conversation now opens at the bottom.** The list
  decides whether to follow the bottom from the scroll events it sees, and the
  heights of the rows that were never on screen are still estimates — so a
  transcript that did not fit was measured as "the reader had scrolled away"
  and stayed at the top. Switching sessions had the same effect: the new
  transcript inherited the scroll position of the old one. Both are fixed: the
  first view of a transcript opens at its bottom, and a switch starts a fresh
  one there.

## [0.4.3] - 2026-10-24

### Fixed

- **The New Session shortcut no longer starts two sessions.** Cmd/Ctrl+Alt+N
  reached the command twice: once through the chat view, which forwards it to
  the host, and once through VS Code's own keybinding — the workbench forwards
  key events out of a webview, so the binding fired while the chat had focus.
  The chat now keeps the shortcut to itself, and the command ignores a request
  that arrives while a new session is still being created.

- **Cmd+C now copies the text you selected in the chat.** VS Code cancels the
  browser's own copy inside a webview and replaces it with a round trip that
  re-focuses the last focused element — in Wingman that is the composer's
  input box — so the chat selection never reached the clipboard and the chord
  copied nothing at all. The webview now takes the copy over and writes the
  selection through the host, the same path the copy buttons use. The chord
  still copies from the composer as before, and Edit → Copy works too.

## [0.4.2] - 2026-10-24

### Fixed

- **A pasted image of an unsupported type is no longer dropped in silence.** The
  composer accepted only PNG / JPEG / GIF / WebP and silently skipped anything
  else — no chip, no warning, and a prompt that reached the model without the
  image. An unsupported file is now named in an inline note together with the
  list of supported types.
- **Pressing Enter while an attached image is still being read no longer ships
  the prompt without it.** The image was not in the attachment state yet, so it
  was left out of the prompt and then discarded together with the rest of the
  attachments. The composer now holds the send, says why, and keeps both the
  text and the attachment for the next attempt.
- **The prompt now carries every attachment, not the ones from the last
  render.** The send path read the attachment state from the snapshot the
  event handler was created with, so an image added between the last render
  and the key press was left out of the prompt — and then cleared with the
  rest of the attachments. The send now reads the live state.
- **An image the clipboard cannot hand over as a file is reported.** When the
  clipboard holds something that looks like an image but the browser refuses
  to expose it as a file, the composer says so and points at the attach button
  instead of dropping the paste without a word.
- **A file that cannot be read is reported.** A failed, cancelled or empty
  `FileReader` read left the user with no chip and no explanation; the composer
  now names the file and suggests the attach button.
- **An attachment is no longer sent twice.** The send path read the attachment
  mirror, which the reducer only clears on the next render — a second Enter in
  the same turn could therefore send the very same image again. The mirror is
  now cleared synchronously when the prompt is sent.
- **An image-only prompt whose image was dropped is no longer lost in silence.**
  The host acknowledged a prompt only after it had forwarded something, so an
  image-only prompt whose attachment was rejected produced no acknowledgement
  at all: the webview showed a user turn with an image badge and waited for a
  warning that never came. The loss is now always acknowledged.
- **A pending image read can no longer block the composer.** Reads in flight
  are aborted when the attachments are cleared (send, model switch, unmount) and
  the counter is reset, so an orphaned read could not keep every later prompt
  — plain text included — waiting for an image that was already gone. A read
  that never finishes no longer blocks the prompt either: after ten seconds
  the text is sent without the image and the user is told. The timeout is
  measured per read, so a read that hangs no longer holds back a younger one
  that is still making progress, and the note says what was actually sent.
  The internal abort itself stays silent — only the reason the read was
  dropped is explained.
- **An attachment rejected by the attachment caps is reported.** Hitting the
  per-prompt image cap dropped the file without a word.

### Added

- **The host acknowledges every prompt with the number of images it forwarded
  and the reason for any drop** (new `promptAccepted` message). The webview
  compares that with the number of attachments it sent and warns. The host
  names the actual cause — the model does not take images, the model's
  capabilities are not known yet, or the file itself was rejected — so the
  warning never sends the user after the wrong fix.
- **Diagnostics for the image-attachment path.** Every hop now reports into the
  "Sqowe Wingman" output channel: the webview logs what the clipboard or the
  file picker actually delivered (item kinds and MIME types, per-file accept or
  reject reasons, read start/finish/failure, the number of attachments at send
  time), the host logs the raw image count, the model-modality gate decision
  and the validation result — including the case where images are dropped
  because the active model does not accept image input, which used to leave no
  trace at all — and the controller logs the size of the RPC payload it sends
  to pi. The webview reaches the host through a new `diag` message type that
  carries no user data beyond file names, MIME types and byte counts. Ordinary
  text pastes leave no trace — only the image pipeline is logged. The trace
  channel is restricted to the `composer.*` scope, and its detail is length-
  capped and stripped of control characters, so it can neither flood nor forge
  entries in the log file.
- **Inline notes stay visible for 5 s instead of 3 s**, so a note about a
  rejected image or an unusable model is not missed.

## [0.4.0] - 2026-10-24

### Added

- **Codex memory sharing (read-only)** — a new bundled `codex-memory` pi extension
  mirrors `claude-memory` for OpenAI Codex: it reads this machine's Codex memory
  store (`~/.codex/memories[_v2]/` — the one store Codex CLI, its VS Code
  extension and the ChatGPT desktop app share) and injects it read-only into pi's
  system prompt under a `## Codex memory (shared, read-only)` heading. The status
  banner gains a parallel **Codex memory** group (the `· N memories` count now
  aggregates both sources) whose rows open the artifacts; `raw_memories.md` is
  never injected. Because Codex's store is global per machine rather than
  per-project, what gets injected beyond `memory_summary.md` (always included
  whole — Codex prompt-loads that file itself) is configurable:
  `sqoweWingman.codexMemoryScope` (`summary` | `project` | `all`, default
  `summary`; `project` filters `MEMORY.md` task-group blocks by their mandatory
  `applies_to: cwd=` tag against the workspace, either direction of path
  prefix) and `sqoweWingman.codexMemoryMaxChars` (budget for inlined blocks,
  default 12000; the rest is listed by name). The feature is gated by
  `sqoweWingman.shareCodexMemory` (default `true`, inert when no store exists)
  with a `WINGMAN_CODEX_MEMORY=off` kill switch. Under the hood the claude and
  codex reports now share one payload path: `ClaudeMemoryEntry`/`ClaudeMemoryInfo`
  became the generic `AgentMemoryEntry`/`AgentMemoryInfo`, the bridge parses both
  reserved keys (`wingman:claudeMemory`, `wingman:codexMemory`) with one
  validator, the webview banner renders both groups through one `AgentMemoryGroup`
  component, and the `openFile`/`openFolder` guard accepts either reported memory
  dir as its containment anchor.

## [0.3.5] - 2026-10-16

### Fixed

- **The VSIX no longer bundles the `.firecrawl/` research-scratch directory.** The
  `.vscodeignore` pattern was `.firecrawl-*`, which matches `.firecrawl-something` but not
  the plain directory name created later, so ten research-scrape files shipped in the 0.3.4
  package. No code changes.

## [0.3.4] - 2026-10-16

### Changed

- **The Current Date Template setting now edits as a multi-line field.** In the Settings UI
  it rendered as a single-line input, which made the three-line default (and any longer
  template) unreadable; it now opens as a resizable multi-line text area.

## [0.3.3] - 2026-10-16

### Fixed

- **The end-of-turn summary line can no longer disappear for the rest of a session.** A
  settled-footer RPC that never resolved (a request lost to a pi respawn mid-session)
  used to hang the footer's internal work queue, and every later turn's footer silently
  queued behind it and never rendered. Footer work now starts on a fresh queue whenever
  the transport or session generation changes, and both RPCs the footer waits on are
  bounded by a 10 s timeout — a lost request counts as a missing measurement instead of
  wedging the feature.

### Changed

- **The summary line now shows the cache hit rate.** The cache-read segment carries the
  share of prompt tokens served from the provider's cache — `↻315.3k 97%` — computed as
  cacheRead / (cacheRead + input) for the turn. Omitted when nothing was read from cache.

## [0.3.2] - 2026-10-16

### Added

- **End-of-turn summary line in the chat.** After the agent finishes a run — the moment pi
  commits to having nothing more to do, not between tool-loop iterations — a compact one-line
  footer appears at the bottom of the transcript: elapsed time, token flow (↑ input, ↓ output,
  ↻ cache read, ↪ cache write) and estimated cost, e.g. `⏱ 11m 30s · ↑100k ↓25k ↻80k ↪5k ·
  ≈ $0.45`. The numbers are per-turn: Wingman diffs pi's cumulative session counters against
  the previous settled snapshot (and seeds that baseline on session resume, so a reconnected
  transport doesn't render the whole session as one turn). The line replaces itself after
  each run rather than accumulating; segments with nothing to show (zeroed buckets, sub-cent
  cost) are omitted, and the first turn before any model response prints no card at all. It
  survives webview reloads (replayed from the host) and is cleared on session switch/reset.

## [0.3.1] - 2026-10-15

### Added

- **The date text models see is now yours to edit.** The `<current_date>` section Wingman
  injects into pi's system prompt was a fixed three-line text; if your models needed a different
  instruction, or none of the wording at all, there was nothing to turn. The new
  `sqoweWingman.currentDateTemplate` setting holds the whole section as a template, with
  `{{date}}` (`YYYY-MM-DD`), `{{weekday}}` (full English weekday) and `{{timeZone}}` (this
  machine's IANA zone) filled in fresh on every prompt. Unknown placeholders are left verbatim,
  so a typo stays visible in the prompt instead of silently deleting text, and a blank template
  falls back to the built-in default rather than emitting an empty section. The template travels
  to the pi child through its environment, which is fixed at spawn, so changing the setting
  reloads the agent to apply it.

### Fixed

- **`WINGMAN_CURRENT_DATE=off` now actually reaches pi.** The documented kill switch for the
  current-date section never worked: Wingman spawns pi with an allowlisted environment and
  `WINGMAN_*` variables were not on the list, so the switch was dropped on the way to the child
  and the section kept being injected. The host now forwards it explicitly from the environment
  VS Code was started from.

## [0.3.0] - 2026-10-14

### Added

- **Models now see the actual current date.** pi's system prompt carries no date at all, so
  models filled the gap from training data or from the serving infrastructure's clock — providers
  running ahead of your local time would confidently state future dates. A new bundled
  `current-date` pi extension (always loaded via `-e`, alongside `instruction-report`) injects a
  `<current_date>` section with the date, weekday and system time zone into the system prompt.
  It refreshes on every message but pi re-sends it only when the date actually changes, so
  sessions spanning midnight stay correct without polluting the context. Kill switch:
  `WINGMAN_CURRENT_DATE=off`.

## [0.2.6] - 2026-10-02

### Fixed

- **A new session no longer forgets your model and thinking level.** Pressing **New Session** used
  to drop the model and thinking level you had picked and quietly put you back on pi's default —
  the status bar jumped to some other model than the one you were just using. pi rebuilds its
  whole agent runtime on a new session and works the model and thinking level out again from its
  own global settings, and it offers no way over its command channel to make your current choice
  the new default. Wingman now remembers the model and thinking level you pick — per workspace, so
  each one keeps its own — and puts them back for you straight after the new session is created.
  Setting a model also remembers the thinking level you were on at the time, so the pair always
  comes back together. Sessions you switch **to** are untouched: those already restore the model
  recorded in that conversation.
- **The thinking levels offered are the ones your model actually has.** **Set Thinking Level**
  showed a fixed list of five levels written into the extension, which matched neither pi nor
  any particular model. pi's levels are *off, minimal, low, medium, high, xhigh, max*, and which
  of those a model supports depends on the model — so the list was wrong in both directions. It
  offered **none**, which is not a pi level at all (pi spells it *off*); because the command
  channel does not check the level, that choice was accepted, reported to you as applied, and
  quietly did nothing. It left out **minimal** and **xhigh**, which most current models do
  support, so those were unreachable. And it offered **max**, which applies only to a model that
  goes that far. Wingman now asks pi which levels the model you are on supports, at the moment
  you open the picker, so the list follows your current model and updates when you change it.
  A model with no extended thinking simply offers *off* and nothing else. The picker also names
  the model the levels belong to, and if pi cannot be asked which levels it supports it says so
  in the menu rather than passing its own full list off as the model's. The menu also marks the
  level actually in force with a tick: VS Code cannot be told which row to start a single-choice
  list on, so it always began on the first one, which made a menu opened while you were on a high
  budget look like it was offering you a low one instead.
- **Cycling the model no longer discards a thinking level you had chosen.** When you switched
  models, pi works the thinking level out again for itself, and the extension was writing that
  recomputed value down as though you had chosen it — so the level you had deliberately set was
  replaced in the per-workspace memory and stayed replaced, including into your next new session.
  The model you cycled to is still remembered; your thinking level is now left as you set it.

## [0.2.4] - 2026-09-13

### Fixed

- **A question no longer lands far up the conversation.** If the Wingman view was out of sight
  while the agent worked — behind another editor tab, for example — the question it then asked
  could appear in the middle of the transcript, among earlier tool calls, with everything that
  had happened since added below it. You came back to the bottom of the chat and saw no question
  at all, while the agent sat waiting for an answer. The chat applies the agent's updates once per
  screen refresh, and a hidden view gets no screen refreshes, so those updates were still waiting
  when the question arrived, and the question was placed ahead of them. The waiting updates are
  now applied first, so a question always appears after everything that came before it. This also
  fixes a smaller slip with the same cause, where a card could sit just above the
  `ask_user_question` tool call that asked it.
- **The chat scrolls all the way to the next question.** After you answered one question, the
  chat scrolled to the next card but stopped at its title, leaving the options below the edge of
  the view. The scroll position was worked out before the card had been measured, from a
  placeholder height far smaller than the real one. The chat now scrolls again once the card's
  real height is known.

## [0.2.3] - 2026-09-08

### Added

- **Questions with real options are now asked in the chat, not in a quick pick.** When an
  extension asks you to choose — several options, each with a sentence or two explaining it,
  sometimes a code preview — the question now appears as a card in the conversation. Everything
  wraps: the question, every option, and every explanation, in full. Previews render as
  expandable code blocks. Multiple choice gets real checkboxes and a **Submit** button instead
  of asking you to type `1,3` into a text box whose title had already run the options together
  into one unreadable paragraph. The card stays in the transcript afterwards as a record of what
  you chose, collapsed to the question and your answer, with the other options one click away.

  This removes a ceiling rather than working around it. A VS Code quick pick row cannot be
  multi-line ([microsoft/vscode#153095](https://github.com/microsoft/vscode/issues/153095), open
  since 2022) and the widget is a fixed 600 px, so the explanation you needed in order to choose
  was always the part clipped by the ellipsis. Two earlier attempts to squeeze more text out of
  that widget shipped in 0.2.2 and were taken back out, because each made the dialog worse in
  practice. The chat has none of those constraints.

  Short prompts are deliberately left alone: `bash-restrictions`' *Allow once / Deny / Deny &
  suggest alternative* is three short labels answered in a keystroke, and it stays on the quick
  pick, which is faster. The choice is made from the shape of the question itself — a request
  carries no tool or extension name — so a renamed tool cannot break it, and any extension that
  formats its options the same way benefits with no changes. Your answer goes back to the
  extension byte-for-byte, so senders that encode meaning into the option text keep working.

- **`sqoweWingman.dialogStyle`** — choose where questions appear: `auto` (the default: chat when
  a quick pick would clip the options, native otherwise), `quickPick` (always native), or `chat`
  (always in the conversation).

## [0.2.2] - 2026-08-07

### Fixed

- **Long answer options are readable again.** pi's `select` dialog carries plain strings and
  nothing else, so an extension that gives each option both a short label and a paragraph
  explaining it has no choice but to flatten the two into one line. VS Code then truncated that
  line with an ellipsis at the quick pick's fixed 600 px width — cutting off precisely the
  explanation you needed to choose. The explanation now moves to a line of its own beneath the
  option, and the highlighted option's **full** explanation is shown in the title, which wraps
  onto as many lines as it needs; typing in the filter box matches the explanation too. Quick
  pick rows themselves cannot be multi-line
  ([microsoft/vscode#153095](https://github.com/microsoft/vscode/issues/153095), open since 2022),
  so the title is the only surface that can show text that long in full. Which extension sent the
  dialog makes no difference: a request carries no tool or extension name, so this keys on the
  shape of the option text — meaning a renamed tool cannot break it, short prompts such as
  `bash-restrictions`' *Allow once / Deny / Deny & suggest alternative* are left exactly as they
  were, and the answer handed back to pi is byte-for-byte the string it offered.
- **A two-part dialog title no longer runs together.** Both quick input surfaces render their
  title as one line and collapse the newlines inside it, so `bash-restrictions` — which sends
  "Bash restriction", a blank line, then the command it wants permission for — read as
  `Bash restriction   rm -rf build` in one breath, with the command indistinguishable from the
  heading. The second part now moves to a surface of its own: the placeholder for a quick pick
  (only when it fits one line, so folded-in option previews stay in the wrapping title), and the
  prompt beneath the box for an input, which wraps freely. This also separates the question from
  the instructions when an extension asks you to type an answer.

  Multiple-choice questions still list their options as one paragraph: no quick input surface
  in VS Code honours a line break. Reading those properly needs checkboxes in the chat itself —
  designed in `docs/design/in-chat-question-cards.md`, not yet built.

### Changed

- **Verified against pi 0.84.0.** pi's v0.84.0 breaking change — `message_update` RPC events
  no longer carry the cumulative `message` field or `assistantMessageEvent.partial` — does not
  affect Wingman: the webview store reads only `assistantMessageEvent.{type,delta,content,thinking}`
  from `message_update`, and `message_end`'s `message` (still authoritative and unchanged) is
  the sole source for the final rendered content. Confirmed live against the pi 0.84.0 binary.
  `PI_MINIMUM_VERSION` stays at `0.80.0`.

## [0.2.1] - 2026-07-30

### Fixed

- **Claude Code memory count no longer goes stale** — the "Project memory" banner kept
  showing a count and file list from an earlier session, and reloading the agent did not
  refresh it. pi runs its `session_start` handlers — where the bundled claude-memory
  extension reports what it found — before it answers the readiness check, so the report
  arrived while the transport still had no subscriber and was discarded on every spawn.
  The transport now holds events that arrive before the first subscriber and replays them
  in order, so no startup event is lost. The cached report is also cleared on each
  respawn, so a stale group cannot outlive the process that reported it — including when
  the spawn fails. Adding or deleting memory files still requires an agent reload to show
  up; the folder is read once per session so the injected prompt stays byte-identical.

## [0.2.0] - 2026-07-14

### Added

- **Setting to toggle Claude Code memory sharing** — `sqoweWingman.shareClaudeMemory`
  (default `true`) turns the read-only Claude Code memory bridge on or off. Toggling
  reloads the agent to apply, and disabling clears the "Project memory" banner group.
  Complements the lower-level `WINGMAN_CLAUDE_MEMORY=off` environment override.
- **Setting for the RPC output buffer cap** — `sqoweWingman.maxStdoutBufferMb`
  (default `64`) controls how large a single line of pi's RPC output may be before the
  sidecar is terminated to bound memory. A whole turn arrives as one `agent_end` line
  whose size grows with the context window (several MB at a 1M-token context, more with
  pasted images), so raise this for very large sessions. Takes effect when the agent
  next starts.

### Changed

- **Larger RPC size limits** — the per-event forwarding cap is raised from 512 KB to
  16 MB, and the stdout line-buffer cap moves from a fixed 2 MB to a configurable 64 MB
  default (see `sqoweWingman.maxStdoutBufferMb`), so large-context turns are received
  and rendered intact instead of being truncated.
- **Live context-usage during long turns** — the session-stats status bar now refreshes
  on each turn (iteration) boundary, not only when a whole turn ends, so the
  `tokens / window` indicator climbs live through a multi-iteration turn (e.g. a long
  code review) instead of sitting stale until the turn finishes.

### Fixed

- **Agent frozen on "Agent is working…" after a large turn** — once a conversation grew
  large enough, pi's terminating `agent_end` event (which carries every message from the
  turn) crossed the transport's 512 KB per-event size cap and was silently dropped.
  Wingman therefore never saw the turn end: the composer stayed disabled behind the
  streaming indicator, Stop had no effect, and further prompts were rejected as "busy" —
  the session was wedged until a full window reload, even though pi had already finished
  and gone idle. Lifecycle and session-state events (`agent_*`, `turn_*`, `compaction_*`,
  `auto_retry_*`, `queue_update`) are now never size-dropped, and `agent_end`'s unused
  message payload is stripped before forwarding, so a large turn can no longer strand the
  UI.
- **Context-window indicator repeated its unit and dropped `%`** — the status bar text
  and the tooltip/popup fraction both showed the unit on either side (`12.4k tok / 200k
  tok`), and the bar's percent slot had no `%` sign. The unit is now shown once, on the
  denominator, and the percent slot reads `6%` — e.g. `9k / 1M tok · 1% · 42 msg`.

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

[Unreleased]: https://github.com/sqowe/wingman/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/sqowe/wingman/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/sqowe/wingman/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/sqowe/wingman/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/sqowe/wingman/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/sqowe/wingman/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/sqowe/wingman/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/sqowe/wingman/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/sqowe/wingman/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/sqowe/wingman/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sqowe/wingman/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/sqowe/wingman/compare/v0.2.4...v0.2.6
[0.2.4]: https://github.com/sqowe/wingman/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/sqowe/wingman/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sqowe/wingman/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sqowe/wingman/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sqowe/wingman/compare/v0.1.10...v0.2.0
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
