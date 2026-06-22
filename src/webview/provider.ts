/**
 * WingmanViewProvider — registers and manages the chat WebviewView.
 *
 * Phase 1 additions:
 *  - Accept an AgentController ref so events can be forwarded to the webview.
 *  - Handle `sendPrompt` messages from the webview.
 *  - Expose `postAgentEvent()` for the controller to call.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AgentController } from '../agent/controller';
import type { HostMessage, PiStatus, WebviewMessage } from '../shared/messages';
import { MAX_PROMPT_BYTES, MAX_CLIPBOARD_BYTES } from '../shared/limits';
import type { RpcEvent } from '../agent/transport';

/** Maximum ms between accepted prompts (simple rate-limit). */
const PROMPT_RATE_LIMIT_MS = 500;

/** Maximum clipboard writes accepted per window (simple rate-limit, defense-in-depth). */
const COPY_RATE_LIMIT_MS = 200;

/** Maximum openExternal calls per window (prevents browser-window spam). */
const OPEN_EXTERNAL_RATE_LIMIT_MS = 500;

export class WingmanViewProvider implements vscode.WebviewViewProvider {
  /** Must match the `id` in package.json contributes.views. */
  public static readonly viewType = 'sqoweWingman.chat';

  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  private _lastPiStatus?: PiStatus;
  /** Last agent liveness reported by the controller — replayed on (re)ready. */
  private _lastAgentStatus?: { running: boolean; reason?: string };
  private _viewDisposables: vscode.Disposable[] = [];
  private _controller?: AgentController;
  /** Bounded buffer of events received before the webview signals `ready`. */
  private _pendingEvents: Array<{ event: RpcEvent; bytes: number }> = [];
  /** Total byte size of buffered events. */
  private _pendingEventBytes = 0;
  private static readonly _MAX_PENDING_EVENTS = 20;
  private static readonly _MAX_PENDING_EVENT_BYTES = 512_000; // 512 KB total
  /** Timestamp of the last accepted sendPrompt — for basic rate-limiting. */
  private _lastPromptAt = 0;
  /** Timestamp of the last accepted clipboard write — for basic rate-limiting. */
  private _lastCopyAt = 0;
  /** Timestamp of the last accepted openExternal call — prevents browser-window spam. */
  private _lastOpenExternalAt = 0;
  /** True while a prompt is in-flight — prevents concurrent sends. */
  private _promptInFlight = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  // ─── WebviewViewProvider ───────────────────────────────────────────────────

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const message = this._validateMessage(raw);
        if (!message) return; // drop unknown / malformed messages

        // Gate all non-ready messages until the webview has signalled it's up.
        if (!this._webviewReady && message.type !== 'ready') return;

        switch (message.type) {
          case 'ready':
            this._webviewReady = true;
            if (this._lastPiStatus !== undefined) {
              this._postMessage({ type: 'piStatus', status: this._lastPiStatus });
            }
            if (this._lastAgentStatus !== undefined) {
              this._postMessage({
                type: 'agentStatus',
                running: this._lastAgentStatus.running,
                reason: this._lastAgentStatus.reason,
              });
            }
            // Flush buffered events that arrived before the webview was ready.
            for (const { event } of this._pendingEvents) {
              this._postMessage({
                type: 'agentEvent',
                event: event as Record<string, unknown>,
              });
            }
            this._pendingEvents = [];
            this._pendingEventBytes = 0;
            break;

          case 'sendPrompt':
            void this._handleSendPrompt(message.text);
            break;

          case 'copyToClipboard':
            void this._handleCopyToClipboard(message.text);
            break;

          case 'abortTurn':
            void this._controller?.sendAbort();
            break;

          case 'openExternal':
            void this._handleOpenExternal(message.url);
            break;
        }
      }),
    );

    webviewView.onDidDispose(() => {
      this._webviewReady = false;
      this._view = undefined;
      this._pendingEvents = [];
      this._pendingEventBytes = 0;
      for (const d of this._viewDisposables) d.dispose();
      this._viewDisposables = [];
    });
  }

  // ─── Public host → webview API ────────────────────────────────────────────

  public setController(controller: AgentController): void {
    this._controller = controller;
  }

  // ─── Runtime message validation ───────────────────────────────────────────

  /**
   * Validate that an incoming postMessage payload is a known WebviewMessage.
   * Returns the typed message or null if validation fails.
   * Unknown/malformed messages are logged at debug level to aid schema-drift diagnosis.
   */
  private _validateMessage(raw: unknown): WebviewMessage | null {
    if (typeof raw !== 'object' || raw === null) {
      this._controller?.outputChannel?.appendLine(
        `[WingmanViewProvider] dropped non-object message: ${typeof raw}`,
      );
      return null;
    }
    const msg = raw as Record<string, unknown>;
    if (typeof msg['type'] !== 'string') {
      this._controller?.outputChannel?.appendLine(
        '[WingmanViewProvider] dropped message with non-string type',
      );
      return null;
    }

    switch (msg['type']) {
      case 'ready':
        return { type: 'ready' };

      case 'sendPrompt':
        if (typeof msg['text'] !== 'string') {
          this._controller?.outputChannel?.appendLine(
            '[WingmanViewProvider] dropped sendPrompt: missing/invalid text field',
          );
          return null;
        }
        return { type: 'sendPrompt', text: msg['text'] };

      case 'copyToClipboard': {
        if (typeof msg['text'] !== 'string') {
          this._controller?.outputChannel?.appendLine(
            '[WingmanViewProvider] dropped copyToClipboard: missing/invalid text field',
          );
          return null;
        }
        // Hard byte-length cap — reject oversized payloads early.
        if (Buffer.byteLength(msg['text'], 'utf8') > MAX_CLIPBOARD_BYTES) {
          this._controller?.outputChannel?.appendLine(
            `[WingmanViewProvider] dropped copyToClipboard: payload exceeds ${MAX_CLIPBOARD_BYTES} bytes`,
          );
          return null;
        }
        return { type: 'copyToClipboard', text: msg['text'] };
      }

      case 'abortTurn':
        return { type: 'abortTurn' };

      case 'openExternal': {
        if (typeof msg['url'] !== 'string') {
          this._controller?.outputChannel?.appendLine(
            '[WingmanViewProvider] dropped openExternal: missing/invalid url field',
          );
          return null;
        }
        // Cap URL length to avoid extreme payloads.
        if (msg['url'].length > 2048) {
          this._controller?.outputChannel?.appendLine(
            '[WingmanViewProvider] dropped openExternal: url exceeds 2048 chars',
          );
          return null;
        }
        // Allow only safe schemes.
        let parsed: URL;
        try { parsed = new URL(msg['url']); } catch {
          this._controller?.outputChannel?.appendLine(
            `[WingmanViewProvider] dropped openExternal: invalid URL (type=${msg['type']})`,
          );
          return null;
        }
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
          this._controller?.outputChannel?.appendLine(
            `[WingmanViewProvider] dropped openExternal: disallowed scheme ${parsed.protocol}`,
          );
          return null;
        }
        return { type: 'openExternal', url: parsed.href };
      }

      default:
        this._controller?.outputChannel?.appendLine(
          `[WingmanViewProvider] dropped unknown message type: ${msg['type']}`,
        );
        return null;
    }
  }

  public setPiStatus(status: PiStatus): void {
    this._lastPiStatus = status;
    if (this._webviewReady) {
      this._postMessage({ type: 'piStatus', status });
    }
  }

  /**
   * Called by AgentController to report agent-transport liveness. A
   * `running: false` after a successful start means pi exited/crashed.
   */
  public postAgentStatus(status: { running: boolean; reason?: string }): void {
    this._lastAgentStatus = status;
    if (this._webviewReady) {
      this._postMessage({
        type: 'agentStatus',
        running: status.running,
        reason: status.reason,
      });
    }
  }

  /**
   * Called by AgentController for every pi event received from the transport.
   * Forwards the raw event to the webview for rendering.
   */
  public postAgentEvent(event: RpcEvent): void {
    // Serialize once for byte-accounting and forwarding.
    const serialized = JSON.stringify(event);
    const byteSize = Buffer.byteLength(serialized, 'utf8');

    if (!this._webviewReady) {
      // Drop oldest entries to stay within both count and byte limits (O(1) per entry).
      while (
        this._pendingEvents.length > 0 &&
        (
          this._pendingEvents.length >= WingmanViewProvider._MAX_PENDING_EVENTS ||
          this._pendingEventBytes + byteSize > WingmanViewProvider._MAX_PENDING_EVENT_BYTES
        )
      ) {
        const dropped = this._pendingEvents.shift();
        if (dropped) this._pendingEventBytes -= dropped.bytes;
      }
      this._pendingEvents.push({ event, bytes: byteSize });
      this._pendingEventBytes += byteSize;
      return;
    }
    this._postMessage({
      type: 'agentEvent',
      event: event as Record<string, unknown>,
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async _handleCopyToClipboard(text: string): Promise<void> {
    // Basic rate-limit: ignore bursts to reduce abuse potential.
    const now = Date.now();
    if (now - this._lastCopyAt < COPY_RATE_LIMIT_MS) {
      this._controller?.outputChannel?.appendLine(
        '[WingmanViewProvider] clipboard write rate-limited — ignoring burst',
      );
      return;
    }
    this._lastCopyAt = now;
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (err) {
      this._controller?.outputChannel?.appendLine(
        `[WingmanViewProvider] clipboard write failed: ${String(err)}`,
      );
    }
  }

  private async _handleOpenExternal(url: string): Promise<void> {
    // Basic rate-limit: prevents a compromised webview from spamming browser windows.
    const now = Date.now();
    if (now - this._lastOpenExternalAt < OPEN_EXTERNAL_RATE_LIMIT_MS) {
      this._controller?.outputChannel?.appendLine(
        '[WingmanViewProvider] openExternal rate-limited — ignoring burst',
      );
      return;
    }
    this._lastOpenExternalAt = now;
    try {
      const uri = vscode.Uri.parse(url, true);
      await vscode.env.openExternal(uri);
    } catch (err) {
      this._controller?.outputChannel?.appendLine(
        `[WingmanViewProvider] openExternal failed: ${String(err)}`,
      );
    }
  }

  private _postMessage(message: HostMessage): void {
    this._view?.webview.postMessage(message);
  }

  private async _handleSendPrompt(text: string): Promise<void> {
    if (!this._controller) return;

    // Validate: must be a non-empty string.
    if (typeof text !== 'string' || text.trim().length === 0) return;

    // Length guard — prevent oversized payloads from the webview.
    if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
      void vscode.window.showWarningMessage(
        `Sqowe Wingman: prompt exceeds the maximum allowed size (${MAX_PROMPT_BYTES} bytes).`,
      );
      this._postMessage({ type: 'promptRejected', reason: 'too-large' });
      return;
    }

    // Busy gate: pi rejects a plain prompt while a turn is streaming. Until
    // Phase 2 adds steer / follow-up queueing, reject cleanly instead of
    // letting pi return an error. (Checked first so 'busy' is the clearest
    // feedback the user sees.)
    if (this._controller.isStreaming) {
      this._postMessage({ type: 'promptRejected', reason: 'busy' });
      return;
    }

    // Rate limit: reject if the last prompt was accepted too recently.
    const now = Date.now();
    if (now - this._lastPromptAt < PROMPT_RATE_LIMIT_MS) {
      this._postMessage({ type: 'promptRejected', reason: 'rate-limited' });
      return;
    }

    // In-flight gate: only one prompt at a time.
    if (this._promptInFlight) {
      this._postMessage({ type: 'promptRejected', reason: 'in-flight' });
      return;
    }

    this._lastPromptAt = now;
    this._promptInFlight = true;
    try {
      await this._controller.sendPrompt(text);
    } catch (err) {
      void vscode.window.showErrorMessage(String(err));
      this._postMessage({ type: 'promptRejected', reason: 'error' });
    } finally {
      this._promptInFlight = false;
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets', 'main.css'),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Sqowe Wingman</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
