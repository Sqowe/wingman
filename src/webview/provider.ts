/**
 * WingmanViewProvider — registers and manages the chat WebviewView.
 *
 * Responsibilities in Phase 0:
 *  - Serve the React app with a strict per-load nonce CSP.
 *  - Bridge the pi status from the host to the webview once the webview is ready.
 *
 * Later phases will add event forwarding, prompt sending, etc.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { HostMessage, PiStatus, WebviewMessage } from '../shared/messages';

export class WingmanViewProvider implements vscode.WebviewViewProvider {
  /** Must match the `id` in package.json contributes.views. */
  public static readonly viewType = 'sqoweWingman.chat';

  private _view?: vscode.WebviewView;

  /** True once the webview has sent `ready` and is listening for messages. */
  private _webviewReady = false;

  /**
   * The most recent pi status. Retained across view hide/dispose so it can be
   * (re)delivered to any webview that becomes ready — including after the view
   * is moved between containers and re-resolved.
   */
  private _lastPiStatus?: PiStatus;

  /** Listeners tied to the current webview; disposed when the view is disposed. */
  private _viewDisposables: vscode.Disposable[] = [];

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
        // Built React app
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
        // Static assets (icon, etc.)
        vscode.Uri.joinPath(this._extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // Gate host→webview delivery on the `ready` handshake — not merely on the
    // view existing. `_view` is set synchronously above, long before the React
    // app mounts and attaches its `message` listener, so posting on `_view`
    // alone can drop messages. We post only after `ready`, and replay the last
    // status so nothing is lost regardless of ordering.
    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (message.type === 'ready') {
          this._webviewReady = true;
          if (this._lastPiStatus !== undefined) {
            this._postMessage({ type: 'piStatus', status: this._lastPiStatus });
          }
        }
      }),
    );

    // Tie listener cleanup to the view's lifetime: when the view is closed or
    // moved between containers (triggering a re-resolve), drop the stale
    // listeners so they don't accumulate.
    webviewView.onDidDispose(() => {
      this._webviewReady = false;
      this._view = undefined;
      while (this._viewDisposables.length > 0) {
        this._viewDisposables.pop()?.dispose();
      }
    });
  }

  // ─── Public host → webview API ────────────────────────────────────────────

  /**
   * Called by the host once locatePi() resolves. The status is stored and sent
   * as soon as the webview signals `ready`; if it is already ready it is sent
   * immediately. Safe to call before or after the view is resolved.
   */
  public setPiStatus(status: PiStatus): void {
    this._lastPiStatus = status;
    if (this._webviewReady) {
      this._postMessage({ type: 'piStatus', status });
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private _postMessage(message: HostMessage): void {
    this._view?.webview.postMessage(message);
  }

  private _buildHtml(webview: vscode.Webview): string {
    // Fresh cryptographic nonce on every view resolution.
    const nonce = crypto.randomBytes(16).toString('base64');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'assets', 'main.css'),
    );

    // Strict CSP:
    //  - default-src 'none'  — deny everything not explicitly listed
    //  - img-src              — allow images from the webview's local origin + https
    //  - style-src            — only the Vite-built stylesheet, served from the
    //                           webview's local origin (no inline styles)
    //  - script-src           — only scripts carrying this nonce
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
