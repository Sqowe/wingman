/**
 * Extension entry point.
 *
 * Phase 0 responsibilities:
 *  - Register the chat WebviewView provider.
 *  - Locate pi asynchronously and surface its status (never block activation).
 *  - Register Phase 0 command stubs (wired to real RPC in later phases).
 */

import * as vscode from 'vscode';
import { WingmanViewProvider } from './webview/provider';
import { locatePi } from './agent/pi-locator';

export function activate(context: vscode.ExtensionContext): void {
  // ── WebviewView provider ──────────────────────────────────────────────────
  const provider = new WingmanViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WingmanViewProvider.viewType,
      provider,
      // Keep the React app alive when the view is hidden so streaming state
      // is not lost on every panel switch.
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Command stubs (Phase 0) ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.newSession', () => {
      // Phase 2: will send new_session RPC command.
      vscode.window.showInformationMessage(
        'Sqowe Wingman: New Session will be available once the transport is wired (Phase 2).',
      );
    }),

    vscode.commands.registerCommand('sqoweWingman.focusChat', () => {
      // Focus the activity-bar view programmatically.
      vscode.commands.executeCommand('sqoweWingman.chat.focus');
    }),
  );

  // ── Locate pi (non-blocking) ──────────────────────────────────────────────
  // Run after activation returns so we never delay VS Code startup.
  void locatePi().then((status) => {
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
    } else if (status.kind === 'version-warning') {
      void vscode.window.showWarningMessage(
        `Sqowe Wingman: pi ${status.version} is below the tested minimum ` +
          `(${status.minimum}). Update pi to avoid compatibility issues.`,
      );
    }
  });
}

export function deactivate(): void {
  // All disposables are registered in context.subscriptions and cleaned up
  // automatically by VS Code on deactivation.
}
