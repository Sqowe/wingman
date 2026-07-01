/**
 * reloadAgent — Sqowe Wingman: Reload pi Agent command.
 *
 * Tears down the current pi sidecar, re-resolves the binary (picks up system
 * updates / reinstalls), and re-spawns it — resuming the current conversation
 * via `--session <path>` so the transcript is preserved.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';
import type { PiStatus } from '../shared/messages';

export async function reloadAgent(
  controller: AgentController,
  locate: () => Promise<PiStatus>,
  applyStatus: (status: PiStatus) => void,
): Promise<void> {
  // Defense-in-depth: bail out if pi is mid-turn (the menu item is already
  // greyed out via `enablement`, but the Command Palette has no such gate).
  if (controller.isStreaming) {
    void vscode.window.showInformationMessage(
      'Sqowe Wingman: cannot reload while the agent is working.',
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    'Reload the pi agent? The sidecar will restart and pick up any updated binary or ' +
      'resource changes. Your conversation will be preserved.',
    { modal: true },
    'Reload',
  );
  if (confirmed !== 'Reload') return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Reloading pi agent…',
      cancellable: false,
    },
    async () => {
      // Second guard: the agent may have become busy between the confirmation
      // dialog and now (e.g. user sent a prompt from another window).
      if (controller.isStreaming) {
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: cannot reload while the agent is working.',
        );
        return;
      }

      let status: PiStatus;
      try {
        status = await locate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.outputChannel?.appendLine(`[reloadAgent] locate error: ${String(err)}`);
        void vscode.window.showErrorMessage(
          `Sqowe Wingman: failed to locate pi — ${msg}`,
        );
        return;
      }

      applyStatus(status);

      if (status.kind === 'not-found') {
        // applyStatus already showed the install-error message; just tear down.
        await controller.reload(status);
        return;
      }

      try {
        await controller.reload(status);
      } catch (err) {
        // Defensive: reload() is documented as non-throwing but guard anyway.
        controller.outputChannel?.appendLine(`[reloadAgent] unexpected error: ${String(err)}`);
        void vscode.window.showErrorMessage(
          `Sqowe Wingman: reload failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
