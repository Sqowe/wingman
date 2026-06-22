/**
 * Wraps VS Code's acquireVsCodeApi() — which may be called exactly once per webview load.
 *
 * Import `vscode` from this module wherever the webview needs to post messages
 * to the host or read/write persisted state.
 */
import type { WebviewMessage } from '@shared/messages';

// VS Code injects this function into the webview's global scope at runtime.
declare function acquireVsCodeApi(): {
  /** Send a typed message to the extension host. */
  postMessage(message: WebviewMessage): void;
  /** Retrieve the state previously saved with setState(). */
  getState<T = unknown>(): T | undefined;
  /** Persist state across webview hide/show cycles. */
  setState<T>(newState: T): T;
};

export const vscode = acquireVsCodeApi();
