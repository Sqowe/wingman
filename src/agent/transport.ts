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

  /** True while the underlying process / connection is alive. */
  readonly isRunning: boolean;
}
