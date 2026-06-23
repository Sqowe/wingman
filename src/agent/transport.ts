/**
 * AgentTransport — the interface that decouples all UI and command code from
 * the concrete transport implementation.
 *
 * v1 implementation: RpcTransport (spawn `pi --mode rpc`).
 * Future: in-process SDK adapter.
 *
 * All agent access goes through this interface — nothing else may depend on
 * the concrete RpcTransport class directly.
 */

import type * as vscode from 'vscode';

// ─── RPC command/response shapes ─────────────────────────────────────────────

/** A command sent to pi over stdin. */
export interface RpcCommand {
  /** Optional correlation id; if omitted the response carries no id. */
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** A response pi sends back for a command (carries `id` when the command did). */
export interface RpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any event pi streams that is NOT a response (no `id` field). */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

// ─── Transport interface ──────────────────────────────────────────────────────

export interface AgentTransport extends vscode.Disposable {
  /**
   * Spawn (or connect to) the underlying agent process / SDK.
   * Resolves once the transport is ready to accept commands.
   * Rejects if the agent cannot be started.
   */
  start(): Promise<void>;

  /**
   * Send a command and await its response.
   * Rejects if the transport is not started or the process exits before
   * the response arrives.
   */
  send(command: RpcCommand): Promise<RpcResponse>;

  /**
   * Write a raw JSON payload directly to stdin without registering a pending
   * request or adding a correlation id.  Used exclusively by UiProtocolBridge
   * to send `extension_ui_response` payloads that pi emitted first.
   * Throws if the transport is not running.
   *
   * Note: `RpcTransport` is the only v1 implementation.  Any future
   * implementation (e.g. in-process SDK adapter) must implement this method.
   */
  sendRaw(payload: Record<string, unknown>): void;

  /**
   * Register a listener that receives every inbound event (the render stream).
   * Returns a Disposable that unregisters the listener when disposed.
   */
  onEvent(handler: (event: RpcEvent) => void): vscode.Disposable;

  /**
   * Register a listener invoked once if the transport dies *unexpectedly* after
   * a successful start (process exit/crash or fatal I/O error). It is NOT called
   * for a deliberate dispose(). Returns a Disposable that unregisters it.
   */
  onClose(handler: (info: { reason: string }) => void): vscode.Disposable;

  /** True while the underlying process / connection is alive.
   * Declared here on the interface so bridge and other consumers can check
   * liveness without depending on the concrete `RpcTransport` type.
   */
  readonly isRunning: boolean;
}
