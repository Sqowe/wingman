/**
 * Extension entry point.
 *
 * Phase 1 additions:
 *  - Instantiate AgentController and wire it to the provider.
 *  - Start the transport once pi is located.
 *  - Stop the transport on deactivation.
 */

import * as vscode from 'vscode';
import { WingmanViewProvider } from './webview/provider';
import { AgentController } from './agent/controller';
import { locatePi } from './agent/pi-locator';
import { DiffService, DIFF_SCHEME } from './diff/diff-service';

// Module-level controller so deactivate() can dispose it.
let _controller: AgentController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // ── Controller ────────────────────────────────────────────────────────────
  const controller = new AgentController();
  _controller = controller;
  // Push into subscriptions so VS Code cleans it up if deactivate() is not
  // called (e.g., reload, test harness). AgentController.dispose() is
  // idempotent, so the explicit deactivate() call is safe too.
  context.subscriptions.push(controller);

  // ── Diff service ──────────────────────────────────────────────────────────
  const diffService = new DiffService();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffService),
    diffService,
  );

  // ── WebviewView provider ──────────────────────────────────────────────────
  const provider = new WingmanViewProvider(context.extensionUri);
  provider.setController(controller);
  provider.setDiffService(diffService);
  controller.setProvider(provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WingmanViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.newSession', () => {
      // Phase 2: will send new_session RPC command.
      vscode.window.showInformationMessage(
        'Sqowe Wingman: New Session will be available once the transport is wired (Phase 2).',
      );
    }),

    vscode.commands.registerCommand('sqoweWingman.focusChat', () => {
      void vscode.commands.executeCommand('sqoweWingman.chat.focus');
    }),
  );

  // ── Locate pi and start transport (non-blocking) ──────────────────────────
  // Wrapped in an async IIFE so any rejection from locatePi() is caught and
  // surfaced as a user-visible error rather than an unhandled rejection.
  void (async () => {
    let status;
    try {
      status = await locatePi((m) => controller.outputChannel.appendLine(m));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: failed to locate pi — ${String(err)}`,
      );
      return;
    }

    provider.setPiStatus(status);

    if (status.kind === 'not-found') {
      void vscode.window
        .showErrorMessage(
          'Sqowe Wingman: pi coding agent not found. ' +
            'Install it with: npm install -g @earendil-works/pi-coding-agent',
          'Open Docs',
        )
        .then((selection) => {
          if (selection === 'Open Docs') {
            void vscode.env.openExternal(
              vscode.Uri.parse('https://github.com/earendil-works/pi'),
            );
          }
        });
      return;
    }

    if (status.kind === 'version-warning') {
      void vscode.window.showWarningMessage(
        `Sqowe Wingman: pi ${status.version} is below the tested minimum ` +
          `(${status.minimum}). Update pi to avoid compatibility issues.`,
      );
    }

    await controller.start(status);
  })();
}

export function deactivate(): void {
  _controller?.dispose();
  _controller = undefined;
}
