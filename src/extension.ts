/**
 * Extension entry point.
 *
 * Phase 5 additions:
 *  - WingmanStatusBar (always-visible session stats).
 *  - registerCommands() wires all Phase 5 native commands.
 *  - getCommands() fetched after transport starts.
 *  - onSessionStats callback links controller → status bar.
 */

import * as vscode from 'vscode';
import { WingmanViewProvider } from './webview/provider';
import { AgentController } from './agent/controller';
import { locatePi } from './agent/pi-locator';
import { DiffService, DIFF_SCHEME } from './diff/diff-service';
import { WingmanStatusBar } from './status-bar';
import { registerCommands } from './commands/index';

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

  // ── Status bar ────────────────────────────────────────────────────────────
  const statusBar = new WingmanStatusBar();
  context.subscriptions.push(statusBar);

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
  // Route session stats from the controller → status bar (null = session reset).
  provider.onSessionStats((stats) => {
    if (stats === null) {
      statusBar.reset();
    } else {
      statusBar.update(stats);
    }
  });
  controller.setProvider(provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WingmanViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Commands (Phase 5) ────────────────────────────────────────────────────
  registerCommands(context, controller);

  context.subscriptions.push(
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
    // Fetch slash commands once transport is live.
    void controller.getCommands();
  })();
}

export function deactivate(): void {
  _controller?.dispose();
  _controller = undefined;
}
