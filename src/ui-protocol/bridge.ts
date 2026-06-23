/**
 * UiProtocolBridge — maps pi's extension UI sub-protocol to native VS Code UI.
 *
 * Pi extensions call ctx.ui.select() / confirm() / input() / editor() — which
 * arrive as `extension_ui_request` events on stdout.  Blocking methods (select /
 * confirm / input / editor) must always be answered with a matching
 * `extension_ui_response` on stdin; leaving one unanswered deadlocks the pi
 * process.  Fire-and-forget methods (notify / setStatus / setWidget / setTitle /
 * set_editor_text) emit no response.
 *
 * See pi's docs/rpc.md §"Extension UI Protocol" for the full schema.
 */

import * as vscode from 'vscode';
import type { AgentTransport, RpcEvent } from '../agent/transport';
import type { WingmanViewProvider } from '../webview/provider';

// ─── Extension UI request shape ───────────────────────────────────────────────

interface BaseUiRequest {
  type: 'extension_ui_request';
  /** Unique id; must be echoed in the extension_ui_response for dialog methods. */
  id: string;
  method: string;
}

interface SelectRequest extends BaseUiRequest {
  method: 'select';
  title?: string;
  options: string[];
  timeout?: number;
}

interface ConfirmRequest extends BaseUiRequest {
  method: 'confirm';
  title?: string;
  message?: string;
  timeout?: number;
}

interface InputRequest extends BaseUiRequest {
  method: 'input';
  title?: string;
  placeholder?: string;
  timeout?: number;
}

interface EditorRequest extends BaseUiRequest {
  method: 'editor';
  title?: string;
  prefill?: string;
  timeout?: number;
}

interface NotifyRequest extends BaseUiRequest {
  method: 'notify';
  message: string;
  notifyType?: 'info' | 'warning' | 'error';
}

interface SetStatusRequest extends BaseUiRequest {
  method: 'setStatus';
  statusKey: string;
  statusText?: string;
}

interface SetWidgetRequest extends BaseUiRequest {
  method: 'setWidget';
  widgetKey: string;
  widgetLines?: string[];
  widgetPlacement?: 'aboveEditor' | 'belowEditor';
}

interface SetTitleRequest extends BaseUiRequest {
  method: 'setTitle';
  title: string;
}

interface SetEditorTextRequest extends BaseUiRequest {
  method: 'set_editor_text';
  text: string;
}

type UiRequest =
  | SelectRequest
  | ConfirmRequest
  | InputRequest
  | EditorRequest
  | NotifyRequest
  | SetStatusRequest
  | SetWidgetRequest
  | SetTitleRequest
  | SetEditorTextRequest;

// ─── Response shapes ──────────────────────────────────────────────────────────

type UiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

/** Narrow an RpcEvent to a UiRequest, or return null if it is not one. */
function asUiRequest(event: RpcEvent): UiRequest | null {
  if (event.type !== 'extension_ui_request') return null;
  // Must have id + method strings to be actionable — caller handles the null case.
  if (typeof event['id'] !== 'string' || typeof event['method'] !== 'string') return null;
  return event as unknown as UiRequest;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class UiProtocolBridge implements vscode.Disposable {
  private _transport: AgentTransport | undefined;
  private _provider: WingmanViewProvider | undefined;
  private _outputChannel: vscode.OutputChannel;
  private _disposed = false;
  /**
   * Maps pending blocking-request ids to their client-side timeout handle.
   * When the timer fires, the id value is replaced with `null` (expired) so
   * _sendResponse can detect a late response and suppress it.  The entry is
   * removed on normal response or on dispose() to prevent unbounded growth.
   *
   * Value meanings:
   *  - `ReturnType<typeof setTimeout>` — timer is still pending
   *  - `null`                          — timer already fired (request expired)
   */
  private _requestTimers = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  public setTransport(transport: AgentTransport | undefined): void {
    this._transport = transport;
  }

  public setProvider(provider: WingmanViewProvider): void {
    this._provider = provider;
  }

  /**
   * Attempt to handle an event as an extension_ui_request.
   * Returns true if the event was consumed (should NOT be forwarded to the webview).
   * Returns false if the event is not a UI request (caller should forward normally).
   */
  public handleEvent(event: RpcEvent): boolean {
    // Consume ALL extension_ui_request events — even malformed ones — so they
    // never leak to the webview. Malformed events without id/method cannot be
    // answered, so we log and return immediately without sending a response.
    if (event.type !== 'extension_ui_request') return false;

    const req = asUiRequest(event);
    if (!req) {
      this._outputChannel.appendLine(
        `[UiProtocolBridge] malformed extension_ui_request (missing id or method) — consumed but not answered`,
      );
      return true;
    }

    // Log blocking dialog requests (useful for diagnostics); skip fire-and-forget
    // methods (setStatus/setWidget/setTitle/set_editor_text) to avoid log spam
    // during frequent status updates.
    const BLOCKING_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
    if (BLOCKING_METHODS.has(req.method)) {
      this._outputChannel.appendLine(
        `[UiProtocolBridge] ${req.method} (id=${req.id})`,
      );
    }

    switch (req.method) {
      case 'select':
        this._scheduleRequestTimeout(req);
        void this._handleSelect(req).catch((err) => {
          this._outputChannel.appendLine(`[UiProtocolBridge] select error: ${String(err)}`);
          this._sendCancelled(req.id);
        });
        return true;
      case 'confirm':
        this._scheduleRequestTimeout(req);
        void this._handleConfirm(req).catch((err) => {
          this._outputChannel.appendLine(`[UiProtocolBridge] confirm error: ${String(err)}`);
          this._sendCancelled(req.id);
        });
        return true;
      case 'input':
        this._scheduleRequestTimeout(req);
        void this._handleInput(req).catch((err) => {
          this._outputChannel.appendLine(`[UiProtocolBridge] input error: ${String(err)}`);
          this._sendCancelled(req.id);
        });
        return true;
      case 'editor':
        this._scheduleRequestTimeout(req);
        void this._handleEditor(req).catch((err) => {
          this._outputChannel.appendLine(`[UiProtocolBridge] editor error: ${String(err)}`);
          this._sendCancelled(req.id);
        });
        return true;
      case 'notify':
        this._handleNotify(req);
        return true;
      case 'setStatus':
        this._handleSetStatus(req);
        return true;
      case 'setWidget':
        this._handleSetWidget(req);
        return true;
      case 'setTitle':
        this._handleSetTitle(req);
        return true;
      // pi's pasteToEditor() delegates to setEditorText() on the agent side
      // and emits set_editor_text over the wire — no separate method name.
      case 'set_editor_text':
        this._handleSetEditorText(req);
        return true;
      default:
        // Unknown method — consume so it doesn't reach the webview.
        // If the request has an id it may be a blocking dialog method from a
        // newer pi protocol version; send cancelled to prevent a pi deadlock.
        this._outputChannel.appendLine(
          `[UiProtocolBridge] unknown UI method "${(req as BaseUiRequest).method}" — sending cancelled response to prevent deadlock`,
        );
        this._sendCancelled((req as BaseUiRequest).id);
        return true;
    }
  }

  public dispose(): void {
    this._disposed = true;
    // Clear all pending request timers to prevent post-dispose callbacks.
    for (const [, handle] of this._requestTimers) {
      if (handle !== null) clearTimeout(handle);
    }
    this._requestTimers.clear();
    this._transport = undefined;
    this._provider = undefined;
  }

  // ─── Blocking dialog methods ───────────────────────────────────────────────

  private async _handleSelect(req: SelectRequest): Promise<void> {
    let picked: string | undefined;
    try {
      picked = await vscode.window.showQuickPick(req.options, {
        title: req.title ?? 'Select an option',
        ignoreFocusOut: true,
      });
    } catch {
      // showQuickPick should not throw, but guard defensively.
    }

    if (this._disposed) return; // transport gone while dialog was open

    if (picked !== undefined) {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, value: picked });
    } else {
      // User dismissed / Escape — pi must still get a response.
      this._sendResponse({ type: 'extension_ui_response', id: req.id, cancelled: true });
    }
  }

  private async _handleConfirm(req: ConfirmRequest): Promise<void> {
    const message = req.message ?? req.title ?? 'Confirm?';
    let result: string | undefined;
    try {
      result = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail: req.message && req.title ? req.title : undefined },
        'Yes',
        'No',
      );
    } catch {
      // Defensive — showWarningMessage should not throw.
    }

    if (this._disposed) return;

    if (result === 'Yes') {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, confirmed: true });
    } else if (result === 'No') {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, confirmed: false });
    } else {
      // Dismissed without selecting — treat as cancelled (pi maps cancel → false for confirm).
      this._sendResponse({ type: 'extension_ui_response', id: req.id, cancelled: true });
    }
  }

  private async _handleInput(req: InputRequest): Promise<void> {
    let value: string | undefined;
    try {
      value = await vscode.window.showInputBox({
        title: req.title,
        placeHolder: req.placeholder,
        ignoreFocusOut: true,
      });
    } catch {
      // Defensive.
    }

    if (this._disposed) return;

    if (value !== undefined) {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, value });
    } else {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, cancelled: true });
    }
  }

  /**
   * `editor` requests a multi-line editor.  VS Code has no built-in multi-line
   * input box, so we open a temporary untitled document, let the user edit, and
   * read the text when they confirm via a quick-pick prompt.  This keeps the
   * UI native and avoids any webview round-trip.
   *
   * Timeouts are handled by `_scheduleRequestTimeout` / `_sendResponse`: pi
   * auto-resolves on its end after the deadline, and `_sendResponse` suppresses
   * any late response from the bridge to prevent a protocol double-response.
   */
  private async _handleEditor(req: EditorRequest): Promise<void> {
    // Create a temporary untitled document pre-filled with the requested text.
    const doc = await vscode.workspace.openTextDocument({
      content: req.prefill ?? '',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    // Prompt the user to confirm or cancel via a quick-pick overlay.
    const action = await vscode.window.showQuickPick(['Submit', 'Cancel'], {
      title: req.title ?? 'Edit text — choose Submit when done',
      ignoreFocusOut: true,
    });

    if (this._disposed) return;

    if (action === 'Submit') {
      const text = doc.getText();
      this._sendResponse({ type: 'extension_ui_response', id: req.id, value: text });
    } else {
      this._sendResponse({ type: 'extension_ui_response', id: req.id, cancelled: true });
    }

    // Close the temporary document: re-reveal the known editor tab first so
    // we close the right one even if the user switched editors during the dialog.
    // Falls back gracefully if it's already been closed.
    try {
      if (!editor.document.isClosed) {
        await vscode.window.showTextDocument(editor.document, { preview: false, preserveFocus: false });
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      } else {
        this._outputChannel.appendLine('[UiProtocolBridge] editor doc already closed — skipping close');
      }
    } catch (err) {
      this._outputChannel.appendLine(`[UiProtocolBridge] could not close temp editor doc: ${String(err)}`);
    }
  }

  // ─── Fire-and-forget display methods ──────────────────────────────────────

  private _handleNotify(req: NotifyRequest): void {
    const msg = req.message;
    switch (req.notifyType) {
      case 'warning':
        void vscode.window.showWarningMessage(msg);
        break;
      case 'error':
        void vscode.window.showErrorMessage(msg);
        break;
      default:
        void vscode.window.showInformationMessage(msg);
    }
  }

  private _handleSetStatus(req: SetStatusRequest): void {
    this._provider?.postUiStatus(req.statusKey, req.statusText ?? null);
  }

  private _handleSetWidget(req: SetWidgetRequest): void {
    this._provider?.postUiWidget(
      req.widgetKey,
      req.widgetLines ?? null,
      req.widgetPlacement ?? 'aboveEditor',
    );
  }

  private _handleSetTitle(req: SetTitleRequest): void {
    this._provider?.postUiTitle(req.title);
  }

  private _handleSetEditorText(req: SetEditorTextRequest): void {
    this._provider?.postUiSetEditorText(req.text);
  }

  // ─── Response writer ───────────────────────────────────────────────────────

  /**
   * If the request carries a `timeout` (ms), register a client-side deadline.
   * When it fires, the entry is marked `null` (expired) so that a late user
   * interaction does not send a double-response.  The handle is cleared on
   * normal response completion via `_clearRequestTimer`.
   */
  private _scheduleRequestTimeout(req: SelectRequest | ConfirmRequest | InputRequest | EditorRequest): void {
    if (!req.timeout || req.timeout <= 0) return;
    const handle = setTimeout(() => {
      if (this._disposed) return; // bridge gone — nothing to do
      this._requestTimers.set(req.id, null); // mark as expired
      this._outputChannel.appendLine(
        `[UiProtocolBridge] request ${req.id} (${req.method}) timed out after ${req.timeout}ms — late response will be suppressed`,
      );
      // Schedule a secondary cleanup so the null entry doesn't accumulate
      // indefinitely when the user never interacts after the deadline.
      // 10 seconds is generous: if the user responds within that window we
      // suppress; after that we just clean up regardless.
      setTimeout(() => {
        if (this._requestTimers.get(req.id) === null) {
          this._requestTimers.delete(req.id);
        }
      }, 10_000);
    }, req.timeout);
    this._requestTimers.set(req.id, handle);
  }

  /** Cancel and remove the pending timer for a request id (call before sending a response). */
  private _clearRequestTimer(id: string): void {
    const handle = this._requestTimers.get(id);
    if (handle !== undefined) {
      if (handle !== null) clearTimeout(handle);
      this._requestTimers.delete(id);
    }
  }

  /**
   * Write an `extension_ui_response` directly to the transport's stdin.
   * Uses `sendRaw` so no response tracking or timeout is added — the response
   * framing is already complete as-is.
   */
  private _sendResponse(response: UiResponse): void {
    // Check if this request's deadline has already fired (timer entry = null means expired).
    if (this._requestTimers.has(response.id) && this._requestTimers.get(response.id) === null) {
      this._outputChannel.appendLine(
        `[UiProtocolBridge] late response for id=${response.id} suppressed (request already timed out)`,
      );
      this._requestTimers.delete(response.id); // clean up
      return;
    }
    // Cancel and clean up any pending timer for this request before sending.
    this._clearRequestTimer(response.id);
    if (!this._transport?.isRunning) {
      this._outputChannel.appendLine(
        `[UiProtocolBridge] cannot send response for id=${response.id}: transport not running`,
      );
      return;
    }
    try {
      this._transport.sendRaw(response);
    } catch (err) {
      this._outputChannel.appendLine(
        `[UiProtocolBridge] sendResponse failed: ${String(err)}`,
      );
    }
  }

  /** Convenience: send a cancelled response by id (used in .catch() paths). */
  private _sendCancelled(id: string): void {
    this._sendResponse({ type: 'extension_ui_response', id, cancelled: true });
  }
}
