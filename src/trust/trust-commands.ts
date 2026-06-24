/**
 * trust-commands.ts — VS Code command handlers and the project-trust prompt.
 *
 * Registers:
 *  - sqoweWingman.selectFolder  — folder picker for multi-root workspaces.
 *  - sqoweWingman.trustProject  — manually re-run the trust prompt for the
 *                                 active folder (handy after the user dismisses
 *                                 the auto-prompt or changes their mind).
 *
 * The trust gate logic (promptForTrust) is called from extension.ts before
 * the initial controller.start() so pi always spawns with the correct flag.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';
import type { PiStatus } from '../shared/messages';
import {
  evaluateTrust,
  hasProjectResources,
  saveTrustDecision,
} from './project-trust';

// ─── Trust prompt result ──────────────────────────────────────────────────────

/**
 * The structured result of a trust prompt interaction.
 *
 * - `trusted: true`  → pass `--approve` to pi.
 * - `trusted: false` → pass `--no-approve`.
 * - `dismissed`      → user closed the dialog without choosing.
 * - `persisted`      → whether the decision was saved to trust.json.
 */
export type TrustPromptResult =
  | { outcome: 'trusted';   persisted: boolean }
  | { outcome: 'denied';    persisted: boolean }
  | { outcome: 'dismissed'; persisted: false };

// ─── Trust prompt ─────────────────────────────────────────────────────────────

/**
 * Show the native trust modal for `folderPath` and persist the user's decision.
 * Always shows the modal — it is the caller's responsibility to decide when
 * to call this (e.g. only when `evaluateTrust` returns `needs-prompt`, or
 * always for the `trustProject` command).
 *
 * Returns a `TrustPromptResult` so callers can distinguish dismissal (no
 * persistent change) from an explicit trust/deny choice.
 * Never throws — save failures are caught and returned as a non-persisted result.
 */
export async function showTrustPrompt(
  folderPath: string,
): Promise<TrustPromptResult> {
  const folderName = path.basename(folderPath);
  const answer = await vscode.window.showWarningMessage(
    `Sqowe Wingman: The folder **${folderName}** contains project-local` +
      ` .pi/ resources (settings, extensions, skills, or system prompt files).` +
      ` Do you trust this project?`,
    { modal: true },
    'Trust',
    "Don't Trust",
  );

  if (answer === 'Trust') {
    try {
      saveTrustDecision(folderPath, true);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Sqowe Wingman: could not save trust decision — ${String(err)}. ` +
          `Project resources will be loaded for this session only.`,
      );
      // Decision not persisted; return 'trusted' so the session proceeds, but
      // mark it so callers can treat it as a temporary (one-run) decision.
      return { outcome: 'trusted', persisted: false };
    }
    return { outcome: 'trusted', persisted: true };
  }

  if (answer === "Don't Trust") {
    // Explicit denial — persist it so future runs skip the prompt.
    try {
      saveTrustDecision(folderPath, false);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Sqowe Wingman: could not save trust decision — ${String(err)}.`,
      );
      return { outcome: 'denied', persisted: false };
    }
    return { outcome: 'denied', persisted: true };
  }

  // User dismissed (Esc / clicked outside / closed) — do not persist anything.
  return { outcome: 'dismissed', persisted: false };
}

/**
 * Evaluate project trust for `folderPath` and, if necessary, show the native
 * trust prompt.  Persists the user's explicit choice to trust.json.
 *
 * Returns:
 *  - `{ arg: '--approve',    persisted: true  }` — trusted, saved to trust.json
 *  - `{ arg: '--no-approve', persisted: true  }` — denied,  saved to trust.json
 *  - `{ arg: '--no-approve', persisted: false }` — dismissed or error; not saved
 *  - `{ arg: undefined,      persisted: false }` — no project resources
 *
 * Never throws — errors surface as warnings and fall back to `--no-approve`.
 */
export async function promptForTrust(
  folderPath: string,
): Promise<{ arg: string | undefined; persisted: boolean }> {
  try {
    const decision = evaluateTrust(folderPath);

    switch (decision.kind) {
      case 'no-resources':
        return { arg: undefined, persisted: false };

      case 'saved':
        return { arg: decision.trusted ? '--approve' : '--no-approve', persisted: true };

      case 'needs-prompt': {
        const result = await showTrustPrompt(folderPath);
        if (result.outcome === 'trusted')  return { arg: '--approve',    persisted: result.persisted };
        if (result.outcome === 'denied')   return { arg: '--no-approve', persisted: result.persisted };
        // dismissed — safe default for this run, but do not persist
        return { arg: '--no-approve', persisted: false };
      }

      // 'temporary' is a controller-internal kind and is never returned by
      // evaluateTrust(), so this branch is a type-safety fallback only.
      default:
        return { arg: '--no-approve', persisted: false };
    }
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Sqowe Wingman: failed to evaluate project trust — ${String(err)}. ` +
        `Project .pi/ resources will not be loaded.`,
    );
    return { arg: '--no-approve', persisted: false };
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

/**
 * Register the trust-related commands.
 *
 * @param context     Extension context (for subscriptions cleanup).
 * @param controller  The agent controller.
 * @param getPiStatus Returns the current PiStatus (needed to restart transport
 *                    after a trust change or folder switch).
 */
export function registerTrustCommands(
  context: vscode.ExtensionContext,
  controller: AgentController,
  getPiStatus: () => PiStatus | undefined,
): void {
  // ── sqoweWingman.selectFolder ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.selectFolder', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: No workspace folders are open.',
        );
        return;
      }

      if (folders.length === 1) {
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: Only one workspace folder is open.',
        );
        return;
      }

      const activePath = controller.activeFolderPath;
      const items = folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        detail: f.uri.fsPath === activePath ? '$(check) Active' : undefined,
        folderPath: f.uri.fsPath,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Sqowe Wingman: Select Workspace Folder',
        placeHolder: 'Choose the folder for the agent to work in',
        matchOnDescription: true,
      });

      if (!picked) return;

      // Run the trust gate for the newly selected folder.
      const trustResult = await promptForTrust(picked.folderPath);

      // Persist the workspace-state choice so it survives window reload.
      await context.workspaceState.update(
        'sqoweWingman.activeFolder',
        picked.folderPath,
      );

      // Apply the trust decision. Only use 'saved' when the decision was
      // actually persisted to trust.json; use 'temporary' for dismissals so
      // the controller doesn't record a permanent denial.
      if (trustResult.arg === undefined) {
        controller.setTrustDecision({ kind: 'no-resources' });
      } else {
        controller.setTrustDecision({
          kind: trustResult.persisted ? 'saved' : 'temporary',
          trusted: trustResult.arg === '--approve',
        });
      }

      const status = getPiStatus();
      await controller.setActiveFolderPath(picked.folderPath, status);
    }),
  );

  // ── sqoweWingman.trustProject ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.trustProject', async () => {
      const folderPath = controller.activeFolderPath;
      if (!folderPath) {
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: No active workspace folder.',
        );
        return;
      }

      // Inform the user if there are no trust-gated resources.
      if (!hasProjectResources(folderPath)) {
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: This folder has no project .pi/ resources that require trust.',
        );
        return;
      }

      // Always show the modal so the user can change a previously saved
      // decision (this is the purpose of the command).
      const result = await showTrustPrompt(folderPath);

      // If the user dismissed the dialog, do nothing — leave the saved
      // decision (if any) and the running transport unchanged.
      if (result.outcome === 'dismissed') return;

      // Apply the new decision to the controller. Use 'saved' only when the
      // decision was actually written to trust.json (persisted: true). A write
      // failure returns persisted: false — use 'temporary' so the controller
      // doesn't record a phantom permanent decision.
      const trusted = result.outcome === 'trusted';
      controller.setTrustDecision(
        result.persisted
          ? { kind: 'saved',     trusted }
          : { kind: 'temporary', trusted },
      );

      if (!result.persisted) {
        // The save failed and showTrustPrompt already showed a warning; add a
        // follow-up note so the user understands the session-only scope.
        void vscode.window.showWarningMessage(
          `Sqowe Wingman: Trust preference could not be saved — ` +
            `it will apply for this session only.`,
        );
      }

      // Force a transport restart so the updated trust arg takes effect
      // immediately, even though the folder path has not changed.
      const status = getPiStatus();
      if (status && status.kind !== 'not-found') {
        await controller.forceRestart(status);
      }
    }),
  );
}
