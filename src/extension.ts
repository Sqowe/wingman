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
import { WingmanStatusBar, ModelStatusBar } from './status-bar';
import { registerCommands } from './commands/index';
import { reloadAgent } from './commands/reload';
import { registerSessions } from './sessions';
import { promptForTrust, registerTrustCommands } from './trust/trust-commands';
import type { PiStatus, EditToolActions } from './shared/messages';

// Module-level controller and piStatus so deactivate() and trust commands can reach them.
let _controller: AgentController | undefined;
let _piStatus: PiStatus | undefined;

/**
 * Apply a freshly located pi status: cache it, push it to the webview provider,
 * and show the appropriate not-found / version-warning message.
 * Extracted so both activation and the reload handler share the same logic.
 */
function applyPiStatus(status: PiStatus, prov: WingmanViewProvider): void {
  _piStatus = status;
  prov.setPiStatus(status);

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
}

/**
 * Read the `sqoweWingman.editToolActions` setting, coercing any unknown value
 * to the default. Drives which action buttons appear on completed `edit` cards.
 */
function readEditToolActions(): EditToolActions {
  const raw = vscode.workspace
    .getConfiguration('sqoweWingman')
    .get<string>('editToolActions', 'both');
  return raw === 'diffOnly' || raw === 'applyOnly' || raw === 'none' ? raw : 'both';
}

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
  const modelStatusBar = new ModelStatusBar();
  context.subscriptions.push(statusBar, modelStatusBar);
  // Route model + thinking level from the controller → model status bar
  // (null = unknown / pi down). Also forwarded to the webview so the composer
  // can gate image-attachment affordances on the active model's modality.
  context.subscriptions.push(
    controller.onModelState((state) => {
      modelStatusBar.update(state);
      provider.postModelState(state);
    }),
  );

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

  // Seed the webview with whatever model state the controller already has
  // (e.g. restored from a previous session). If it's null the webview
  // defaults supportsImages=false which is the safe/correct initial state.
  provider.postModelState(controller.lastModelState);

  // Seed the webview with the chat UI config (which action buttons to show on
  // completed `edit` tool cards) and keep it in sync if the user changes the
  // setting while the extension is running.
  provider.postChatConfig(readEditToolActions());
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sqoweWingman.editToolActions')) {
        provider.postChatConfig(readEditToolActions());
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WingmanViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Commands (Phase 5) ────────────────────────────────────────────────────
  registerCommands(context, controller);

  // ── Sessions view (Phase 7) ───────────────────────────────────────────────
  registerSessions(context, controller);

  // ── Trust + folder commands (Phase 8) ────────────────────────────────────
  registerTrustCommands(context, controller, () => _piStatus);

  // ── Reload pi agent ───────────────────────────────────────────────────────
  // Initialise the agentBusy context key immediately so the menu enablement
  // expression has a defined value before any event fires.
  controller.initBusyContextKey();
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.reloadAgent', () =>
      reloadAgent(
        controller,
        () => locatePi((m) => controller.outputChannel.appendLine(m)),
        (s) => applyPiStatus(s, provider),
      ),
    ),
  );

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

    applyPiStatus(status, provider);

    // Stop here if pi is not runnable — trust gate, folder restore, and
    // transport start must not proceed for non-runnable statuses.
    // Mirrors the runnable-kind check in AgentController.reload().
    if (status.kind !== 'found' && status.kind !== 'version-warning') return;

    // Phase 8: restore active folder + run trust gate.
    // 1. Restore the user's last-chosen folder from workspace state (multi-root).
    //    Validates it is still among the open folders before applying.
    // 2. Evaluate project trust for the active folder and, if needed, show the
    //    native trust prompt.  The trust arg is passed to the controller so it
    //    reaches the transport constructor before start() is called.

    const savedFolder = context.workspaceState.get<string>('sqoweWingman.activeFolder');
    const folders = vscode.workspace.workspaceFolders;
    const activeFolderPath =
      savedFolder && folders?.some((f) => f.uri.fsPath === savedFolder)
        ? savedFolder
        : folders?.[0]?.uri.fsPath;

    if (activeFolderPath) {
      // Persist the (potentially corrected) active folder.
      if (activeFolderPath !== savedFolder) {
        await context.workspaceState.update('sqoweWingman.activeFolder', activeFolderPath);
      }

      // Set folder on controller before trust via the supported API so
      // _resolveCwd() is accurate when start() is called below, without
      // triggering a premature transport restart.
      controller.initActiveFolderPath(activeFolderPath);

      // Run the trust gate for the active folder.
      // promptForTrust handles all three cases: no-resources, saved decision,
      // and needs-prompt (shows modal). It returns a structured result so we
      // can distinguish a persisted decision from a one-run-only dismissal.
      try {
        const trustResult = await promptForTrust(activeFolderPath);
        if (trustResult.arg === undefined) {
          controller.setTrustDecision({ kind: 'no-resources' });
        } else {
          // Use 'saved' only when the decision was actually persisted;
          // use 'temporary' for dismissals so no phantom denial is recorded.
          controller.setTrustDecision({
            kind: trustResult.persisted ? 'saved' : 'temporary',
            trusted: trustResult.arg === '--approve',
          });
        }
      } catch (err) {
        controller.outputChannel.appendLine(
          `[extension] trust gate error: ${String(err)} — defaulting to --no-approve`,
        );
        controller.setTrustDecision({ kind: 'temporary', trusted: false });
      }
    }

    await controller.start(status);
    // Fetch slash commands once transport is live.
    void controller.getCommands();

    // Restore last session if available (Phase 7 session persistence).
    const savedSessionPath = context.workspaceState.get<string>('sqoweWingman.lastSessionPath');
    if (savedSessionPath) {
      try {
        const success = await controller.switchSession(savedSessionPath);
        if (!success) {
          // Session switch was cancelled (not an error) - don't clear the saved path
          console.log('Sqowe Wingman: session restore was cancelled');
        }
      } catch {
        // Session might have been deleted; clear the saved path.
        context.workspaceState.update('sqoweWingman.lastSessionPath', undefined);
      }
    }
  })().catch((err: unknown) => {
    // Catch any unexpected rejection from the activation IIFE so it is always
    // surfaced to the output channel rather than silently swallowed.
    controller.outputChannel.appendLine(
      `[extension] activation error: ${String(err)}`,
    );
  });
}

export function deactivate(): void {
  _controller?.dispose();
  _controller = undefined;
}
