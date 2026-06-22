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

// ─── Shared types ────────────────────────────────────────────────────────────

/** Status of the pi executable after the locator has run. */
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
 */
export interface AgentStatusMessage {
  type: 'agentStatus';
  running: boolean;
  /** Human-readable reason, present when `running` is false. */
  reason?: string;
}

/** Union of every message the host can send to the webview. */
export type HostMessage =
  | PiStatusMessage
  | AgentEventMessage
  | PromptRejectedMessage
  | AgentStatusMessage;

// ─── Webview → Host ──────────────────────────────────────────────────────────

/** Sent by the webview once React has mounted and it is ready to receive messages. */
export interface ReadyMessage {
  type: 'ready';
}

/** Sent by the webview when the user submits a prompt. */
export interface SendPromptMessage {
  type: 'sendPrompt';
  text: string;
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

/** Union of every message the webview can send to the host. */
export type WebviewMessage =
  | ReadyMessage
  | SendPromptMessage
  | CopyToClipboardMessage
  | AbortTurnMessage
  | OpenExternalMessage;
