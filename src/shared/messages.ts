/**
 * Typed host ↔ webview message contract.
 *
 * This file is imported by both the extension host (Node) and the webview (React)
 * — it must contain only pure TypeScript types with no runtime imports.
 *
 * Always add new message types here; never send ad-hoc, untyped payloads across
 * the postMessage boundary.
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

/** Sent by the webview when the user submits a prompt (Phase 1 dev console). */
export interface SendPromptMessage {
  type: 'sendPrompt';
  text: string;
}

/** Union of every message the webview can send to the host. */
export type WebviewMessage = ReadyMessage | SendPromptMessage;
