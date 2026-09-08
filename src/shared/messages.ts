/**
 * Typed host ↔ webview message contract.
 *
 * This file is imported by both the extension host (Node) and the webview (React)
 * — it must contain only pure TypeScript types with no runtime imports.
 *
 * Always add new message types here; never send ad-hoc, untyped payloads across
 * the postMessage boundary.
 *
 * Shared numeric limits (MAX_PROMPT_BYTES, MAX_CLIPBOARD_BYTES, …) live in
 * `src/shared/limits.ts` — import from there, not here.
 */

import type { ParsedOption } from './dialog-options';
import type { AllowedImageMimeType } from './limits';

// ─── Shared types ────────────────────────────────────────────────────────────

/** Status of the pi executable after the locator has run. */

/** A single slash command returned by pi's get_commands RPC call. */
export interface PiCommand {
  name: string;
  description: string;
  /**
   * Optional hint for expected arguments, sourced from `argument-hint` frontmatter in prompt
   * templates. Rendered in the slash menu to tell the user what to type after the command name.
   * Uses `<angle brackets>` for required args and `[square brackets]` for optional ones,
   * e.g. `"<PR-URL>"` or `"[instructions]"`. Not present for skills or extension commands.
   */
  argumentHint?: string;
  /** True for built-in TUI commands that are inert over RPC (not shown in the slash menu). */
  builtIn?: boolean;
}

/** Session statistics returned by pi's get_session_stats RPC call.
 *
 * `contextUsage` is the per-turn, current-context-window estimate that pi itself uses for
 * compaction and footer display (see rpc.md §"get_session_stats"). It is **undefined** when
 * pi reports no model / no context window, and the inner `tokens`/`percent` are **null**
 * during the documented post-compaction transient until the next post-compaction assistant
 * response lands. `contextWindow` (the denominator) is unaffected by the transient and can
 * be used to render a partial "— / 200k" placeholder. */
export interface SessionStats {
  totalTokens: number | null;
  totalCost: number | null;
  totalMessages: number | null;
  contextUsage?: {
    /** Current tokens used in the active model's context window. `null` during the
     *  post-compaction transient; `undefined`-parent when pi reports no context. */
    tokens: number | null;
    /** The active model's context-window size (denominator). */
    contextWindow: number | null;
    /** Percentage 0-100. `null` during the post-compaction transient. */
    percent: number | null;
  };
}

/** The session's active model + thinking level, from pi's get_state. */
export interface ModelState {
  modelId: string | null;
  modelName: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  /** True when the active model accepts image input (model.input includes 'image'). */
  supportsImages: boolean;
}

/**
 * An image attached to a prompt, carried webview → host → pi RPC.
 * `data` is a raw base64 string (no `data:<mime>;base64,` prefix).
 * `mimeType` must be one of ALLOWED_IMAGE_MIME_TYPES.
 * `fileName` is for display only and is never forwarded to pi.
 * `size` is the decoded byte length used for UI feedback and host-side validation.
 */
export interface AttachedImage {
  data: string;
  /** Must be one of ALLOWED_IMAGE_MIME_TYPES from limits.ts. */
  mimeType: AllowedImageMimeType;
  fileName?: string;
  size: number;
}

export type PiStatus =
  | { kind: 'found'; version: string; path: string }
  | { kind: 'version-warning'; version: string; path: string; minimum: string }
  | { kind: 'not-found' };

// ─── Host → Webview ──────────────────────────────────────────────────────────

/** Sent once after activation; updated if the setting changes. */
export interface PiStatusMessage {
  type: 'piStatus';
  status: PiStatus;
}

/**
 * Wraps a raw pi RPC event forwarded from the transport.
 * The webview renders it (Phase 1: dev console; Phase 2+: real chat UI).
 */
export interface AgentEventMessage {
  type: 'agentEvent';
  event: Record<string, unknown>;
}

/**
 * Sent by the host when a sendPrompt was rejected before reaching the agent.
 * The webview can show inline feedback rather than silently dropping the message.
 *
 * - `rate-limited` — prompts arrived faster than the rate limit allows.
 * - `in-flight`    — a previous prompt is still being accepted by pi.
 * - `too-large`    — the prompt exceeds MAX_PROMPT_BYTES.
 * - `busy`         — the agent is mid-turn (streaming); pi would reject it.
 * - `error`        — the send failed (transport down, or pi rejected it).
 */
export interface PromptRejectedMessage {
  type: 'promptRejected';
  reason: 'rate-limited' | 'in-flight' | 'too-large' | 'busy' | 'error';
}

/**
 * Reports the liveness of the underlying agent transport (the pi process).
 * `running: false` after a successful start means pi exited or crashed; the
 * webview surfaces this rather than appearing to silently hang.
 * `cwd` is included when `running` is true so the webview can display context;
 * it is NOT used for filesystem operations (the host always derives cwd from
 * `vscode.workspace.workspaceFolders` for any I/O).
 */
export interface AgentStatusMessage {
  type: 'agentStatus';
  running: boolean;
  /** Present when `running` is true — the active workspace folder path. */
  cwd?: string;
  /** Human-readable reason, present when `running` is false. */
  reason?: string;
}

/**
 * Sent by the host when opening the diff preview (openDiff) fails.
 * The webview can surface this as inline feedback on the tool card.
 *
 * - `open-failed` — the diff editor could not be opened (e.g. the file changed
 *   after pi's edit so the patch no longer reconstructs, or a parse error).
 */
export interface DiffErrorMessage {
  type: 'diffError';
  toolCallId: string;
  reason: 'open-failed';
  message: string;
}

/**
 * Sent by the host (once on session start, and again on webview `ready` replay)
 * with the list of user slash commands available in the current project.
 * The webview uses this to populate the `/` autocomplete menu.
 */
export interface CommandsListMessage {
  type: 'commandsList';
  commands: PiCommand[];
}

/**
 * Sent by the host when the active session is replaced by a fresh, empty one
 * (the `new_session` command). The webview clears its rendered transcript and
 * per-turn state so the old conversation does not linger. Not sent for
 * fork / clone, which branch the existing history (the transcript stays valid).
 */
export interface SessionResetMessage {
  type: 'sessionReset';
}

/**
 * Sent by UiProtocolBridge when pi calls ctx.ui.setStatus().
 * The webview renders the (key → text) map as a compact status strip.
 * `text: null` clears the entry for that key.
 */
export interface UiStatusMessage {
  type: 'uiStatus';
  key: string;
  text: string | null;
}

/**
 * Sent by UiProtocolBridge when pi calls ctx.ui.setWidget().
 * The webview renders lines as a collapsible block above or below the composer.
 * `lines: null` clears the widget for that key.
 */
export interface UiWidgetMessage {
  type: 'uiWidget';
  key: string;
  lines: string[] | null;
  placement: 'aboveEditor' | 'belowEditor';
}

/**
 * Sent by UiProtocolBridge when pi calls ctx.ui.setTitle().
 * The webview can display this as a subtitle in the header area.
 */
export interface UiTitleMessage {
  type: 'uiTitle';
  title: string;
}

/**
 * Sent by UiProtocolBridge when pi calls ctx.ui.set_editor_text() /
 * ctx.ui.pasteToEditor().  The webview pre-fills the composer textarea.
 */
export interface UiSetEditorTextMessage {
  type: 'uiSetEditorText';
  text: string;
}

// ─── In-chat question cards ──────────────────────────────────────────
//
// A blocking `select` / `input` request whose options would be truncated by a
// quick pick is rendered as a card in the chat transcript instead, where the
// question, every option and its explanation can wrap freely.  See
// docs/design/in-chat-question-cards.md; the routing rule lives in
// src/shared/dialog-options.ts (`shouldRouteToCard`).
//
// The host stays the authority on the pi protocol: it decides the surface, owns
// the request `id`, and is the only side that writes an `extension_ui_response`.
// The webview never learns the id's meaning — it echoes it back.

/**
 * One selectable row on a question card.
 *
 * Derived from `ParsedOption` so the wire shape cannot drift from the parser
 * that produces it.  `label` is deliberately dropped: it retains the `"N. "`
 * prefix for a quick pick row, whereas a card numbers its own rows and wants
 * `headline`.  `preview` is added because it does not come from the option
 * string at all — pi's `select` has no field for it, so the sender folds it
 * into the title and the host parses it back out.
 */
export interface UiDialogOption extends Omit<ParsedOption, 'label'> {
  /**
   * Per-option preview (code or markdown), rendered as a collapsed block.
   * Recovered from the title — pi's `select` has no field for it.
   */
  preview?: string;
}

/**
 * Sent by UiProtocolBridge when a blocking dialog is routed to the chat instead
 * of a native quick pick / input box.
 *
 * Exactly one `UiDialogAnswerMessage` must come back per `id`.  If the webview
 * cannot answer (reload, reset, dispose), the host answers pi itself — a
 * blocking request is never left hanging.
 */
export interface UiDialogMessage {
  type: 'uiDialog';
  /** pi's request id.  Opaque to the webview; echo it back unchanged. */
  id: string;
  /**
   * Which card to draw:
   *  - `select` — single choice; answering sends one option's `raw`.
   *  - `multiSelect` — checkboxes; answering sends comma-separated indices
   *    (`"1,3"`), because that is what the sender parses.  Arrives as an
   *    `input` request whose title carries the option list, not as a `select`.
   */
  kind: 'select' | 'multiSelect';
  /** The question, chip prefix and folded-in previews already removed. */
  question: string;
  /** Short chip label (rpiv's `[REST API file]` prefix), when present. */
  header?: string;
  /** The options to render, in the order the sender listed them. */
  options: UiDialogOption[];
  /**
   * The sender's how-to-answer instructions, when it supplied any.  Display
   * only: the card provides checkboxes, so "type the numbers" no longer
   * applies, but the text can carry other detail worth showing.
   */
  instructions?: string;
}

/**
 * Sent by the host to withdraw a pending question card — pi's own timeout fired,
 * the session was reset, or the agent went away.  The card stops accepting input
 * and collapses to a note that the question expired.  The host has already
 * answered (or deliberately suppressed) the underlying request by this point, so
 * the webview must NOT send an answer for this id afterwards.
 */
export interface UiDialogCancelMessage {
  type: 'uiDialogCancel';
  id: string;
  /** Why the card was withdrawn, for the note left in the transcript. */
  reason: 'timeout' | 'sessionReset' | 'agentStopped';
}

/**
 * Sent by the host when switching to a different session.
 * The webview should replace its transcript with these messages.
 */
export interface SessionMessagesMessage {
  type: 'sessionMessages';
  messages: unknown[];
}

/**
 * Sent by the host when the active model's capabilities change (on connect,
 * model switch, or pi restart). The webview uses this to enable/disable
 * image-attachment affordances in the composer.
 * `state: null` means pi is down / model unknown.
 */
export interface ModelStateMessage {
  type: 'modelState';
  state: ModelState | null;
}

// ─── Instruction files ───────────────────────────────────────────────────────

export type InstructionFileRole =
  | 'context'            // AGENTS.md / CLAUDE.md — additive context injection
  | 'systemPrompt'       // SYSTEM.md — replaces the default system prompt
  | 'appendSystemPrompt' // APPEND_SYSTEM.md — appended to the system prompt
  | 'customPrompt';      // --system-prompt flag or template — no file path

export interface InstructionFileEntry {
  /**
   * Absolute path to the file.
   * null only for the customPrompt/no-file case (e.g. --system-prompt flag).
   */
  path: string | null;
  scope: 'global' | 'project' | null;
  role: InstructionFileRole;
}

export interface InstructionFilesInfo {
  files: InstructionFileEntry[];
}

/**
 * Sent after session (re)start once pi's resolved instruction files are known
 * (or known to be unknowable). `info: null` covers every fallback case —
 * old pi, extension load failure, command absent, malformed report, or timeout
 * — and must render distinctly from `files: []` (a real project with no
 * instruction files configured).
 */
export interface InstructionFilesMessage {
  type: 'instructionFiles';
  info: InstructionFilesInfo | null;
}

// ─── Claude Code project memory (shared, read-only) ───────────────────────

/** One remembered fact from Claude Code's project memory folder. */
export interface ClaudeMemoryEntry {
  /** Absolute path to the memory file (inside `ClaudeMemoryInfo.dir`). */
  path: string;
  /** Display title (parsed from the MEMORY.md index link, filename fallback). */
  title: string;
}

export interface ClaudeMemoryInfo {
  /** Absolute path to the resolved `.../memory/` directory. */
  dir: string;
  /** True total number of fact files. May exceed `files.length` (see below). */
  count: number;
  /**
   * The reported fact files for display/clicking. A bounded subset: the
   * extension caps the transmitted list (200 entries) and the host drops any
   * malformed or out-of-dir entries, so this can be shorter than `count`. Every
   * listed entry has an absolute path contained within `dir`.
   */
  files: ClaudeMemoryEntry[];
}

/**
 * Sent after session (re)start when the bundled claude-memory extension reports
 * the project's shared Claude Code memory. `info: null` = no memory folder for
 * this project, or an unreadable/malformed report. Arrives unsolicited (the
 * extension reports from `session_start`), queued until the webview is ready.
 */
export interface ClaudeMemoryMessage {
  type: 'claudeMemory';
  info: ClaudeMemoryInfo | null;
}

/**
 * Sent by the host with the chat UI configuration (whether to show the "View
 * Diff" button on completed `edit` tool cards), per the
 * `sqoweWingman.showViewDiffButton` setting. Pushed once on startup, replayed on
 * webview `ready`, and re-pushed whenever the setting changes while the
 * extension is running.
 */
export interface ChatConfigMessage {
  type: 'chatConfig';
  showViewDiffButton: boolean;
}

/** Union of every message the host can send to the webview. */
export type HostMessage =
  | PiStatusMessage
  | AgentEventMessage
  | PromptRejectedMessage
  | AgentStatusMessage
  | DiffErrorMessage
  | CommandsListMessage
  | SessionResetMessage
  | UiStatusMessage
  | UiWidgetMessage
  | UiTitleMessage
  | UiSetEditorTextMessage
  | UiDialogMessage
  | UiDialogCancelMessage
  | SessionMessagesMessage
  | ModelStateMessage
  | ChatConfigMessage
  | InstructionFilesMessage
  | ClaudeMemoryMessage;

// ─── Webview → Host ──────────────────────────────────────────────────────────

/** Sent by the webview once React has mounted and it is ready to receive messages. */
export interface ReadyMessage {
  type: 'ready';
}

/** Sent by the webview when the user submits a prompt. */
export interface SendPromptMessage {
  type: 'sendPrompt';
  text: string;
  /** Optional images attached to this prompt. Absent === text-only (legacy behaviour). */
  images?: AttachedImage[];
}

/**
 * Sent by the webview when the user clicks a copy button.
 * The host writes `text` to the system clipboard via `vscode.env.clipboard`.
 * Hard-limited to MAX_CLIPBOARD_BYTES (from limits.ts) on both sides.
 */
export interface CopyToClipboardMessage {
  type: 'copyToClipboard';
  text: string;
}

/**
 * Sent by the webview when the user clicks the abort (stop) button.
 * The host forwards an `abort` command to the active transport.
 *
 * Named `abortTurn` (not `abort`) to avoid semantic confusion with the
 * lower-level transport `{ type: 'abort' }` RPC command in logs and traces.
 */
export interface AbortTurnMessage {
  type: 'abortTurn';
}

/**
 * Sent by the webview when the user clicks a link in assistant output.
 * The host opens the URL via `vscode.env.openExternal` after validating
 * the scheme (only http / https / mailto are forwarded).
 */
export interface OpenExternalMessage {
  type: 'openExternal';
  url: string;
}

/**
 * Sent by the webview when the user clicks "View Diff" on a completed edit card.
 * The host opens VS Code's diff editor (before ↔ after, read-only preview).
 * `patch` is the unified diff string from `result.details.patch`.
 * `toolCallId` identifies the card so the host can route error feedback back.
 *
 * Note: no `cwd` field — the host derives the workspace root from
 * `vscode.workspace.workspaceFolders` and never trusts filesystem paths from
 * the webview (path-traversal defence).
 */
export interface OpenDiffMessage {
  type: 'openDiff';
  patch: string;
  toolCallId: string;
}

/**
 * Sent by the webview to request a fresh commands list from the host
 * (e.g. after a new session or project switch).
 */
export interface RequestCommandsMessage {
  type: 'requestCommands';
}

/**
 * Sent by the webview when the user triggers the new-session keyboard shortcut
 * from inside the chat. VS Code keybindings do not reach the extension while a
 * webview iframe has focus, so the webview forwards the intent and the host
 * runs the `sqoweWingman.newSession` command.
 */
export interface RequestNewSessionMessage {
  type: 'newSession';
}

/**
 * Sent by the webview to open a Claude Code memory file in the editor.
 * The host guards that `path` resolves inside the most recently reported
 * `ClaudeMemoryInfo.dir` before opening — the webview must never be able to
 * name an arbitrary filesystem path (path-traversal defence).
 */
export interface OpenFileMessage {
  type: 'openFile';
  path: string;
}

/**
 * Sent by the webview to reveal the Claude Code memory folder in the OS file
 * manager. The host guards that `path` resolves (symlink-safe) to exactly the
 * most recently reported `ClaudeMemoryInfo.dir` before revealing.
 */
export interface OpenFolderMessage {
  type: 'openFolder';
  path: string;
}

/**
 * Sent by the webview when the user answers or dismisses a question card.
 *
 * The host correlates by `id` and translates this into pi's
 * `extension_ui_response`.  Exactly one of these is expected per `uiDialog`;
 * later duplicates for the same id are dropped by the host, as are answers for
 * an id it has already withdrawn (see `UiDialogCancelMessage`).
 *
 * `value` semantics depend on the card's `kind`:
 *  - `select` — one option's `raw`, byte-for-byte as pi sent it.  The card must
 *    not trim, renumber or re-label it; the sender parses its own encoding back
 *    out and reads an unrecognised value as a dismissal.
 *  - `multiSelect` — the chosen options' 1-based indices, comma-separated
 *    (`"1,3"`).  Bare indices, never labels: the sender requires every token to
 *    parse as an in-range index, and keeps the whole reply as free text if any
 *    token does not.  An empty string is a deliberate "none selected".
 *
 * `cancelled: true` is the Dismiss control, equivalent to Escape on a quick
 * pick.  Senders treat it as cancelling the entire questionnaire.
 *
 * The two branches share the same `type`, so narrowing is on the presence of
 * `cancelled` rather than on a discriminant.  The `?: never` members make that
 * exclusivity a compile-time guarantee: an object carrying both `value` and
 * `cancelled` is rejected, so the host's `'cancelled' in answer` branch cannot
 * silently discard a value.
 */
export type UiDialogAnswerMessage =
  | { type: 'uiDialogAnswer'; id: string; value: string; cancelled?: never }
  | { type: 'uiDialogAnswer'; id: string; cancelled: true; value?: never };

/** Union of every message the webview can send to the host. */
export type WebviewMessage =
  | ReadyMessage
  | SendPromptMessage
  | CopyToClipboardMessage
  | AbortTurnMessage
  | OpenExternalMessage
  | OpenDiffMessage
  | RequestCommandsMessage
  | RequestNewSessionMessage
  | OpenFileMessage
  | OpenFolderMessage
  | UiDialogAnswerMessage;

