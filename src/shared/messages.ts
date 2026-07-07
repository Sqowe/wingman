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
 * Sent by the host when a diff operation (openDiff / applyEdit) fails.
 * The webview can surface this as inline feedback on the tool card.
 *
 * - `open-failed`  — the diff editor could not be opened (e.g. patch parse error).
 * - `apply-failed` — workspace.applyEdit was rejected or threw.
 */
export interface DiffErrorMessage {
  type: 'diffError';
  toolCallId: string;
  reason: 'open-failed' | 'apply-failed';
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

/** Which action buttons to show on completed `edit` tool cards. */
export type EditToolActions = 'both' | 'diffOnly' | 'applyOnly' | 'none';

/**
 * Sent by the host with the chat UI configuration (which action buttons to
 * show on completed `edit` tool cards), per the `sqoweWingman.editToolActions`
 * setting. Pushed once on startup, replayed on webview `ready`, and re-pushed
 * whenever the setting changes while the extension is running.
 */
export interface ChatConfigMessage {
  type: 'chatConfig';
  editToolActions: EditToolActions;
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
  | SessionMessagesMessage
  | ModelStateMessage
  | ChatConfigMessage
  | InstructionFilesMessage;

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
 * Sent by the webview when the user clicks "Apply" on a completed edit card.
 * The host applies the patch as a real WorkspaceEdit so the change appears in
 * Source Control with Accept / Discard affordances.
 *
 * Note: no `cwd` field — see OpenDiffMessage.
 */
export interface ApplyEditMessage {
  type: 'applyEdit';
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

/** Union of every message the webview can send to the host. */
export type WebviewMessage =
  | ReadyMessage
  | SendPromptMessage
  | CopyToClipboardMessage
  | AbortTurnMessage
  | OpenExternalMessage
  | OpenDiffMessage
  | ApplyEditMessage
  | RequestCommandsMessage
  | RequestNewSessionMessage;

