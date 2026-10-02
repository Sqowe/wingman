/**
 * new-session — Sqowe Wingman: New Session command.
 * Calls pi's `new_session` RPC command to start a fresh conversation, then
 * re-applies the remembered model + thinking level.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

export async function newSession(controller: AgentController): Promise<void> {
  try {
    // pi's new_session rebuilds the whole runtime and re-resolves the model and
    // thinking level from its global settings, so the live selection is lost —
    // there is no `persist` option on the set_model / set_thinking_level RPC
    // commands, so Wingman has to remember and re-apply it itself. The refresh
    // is suppressed across both sends so the status bar doesn't flash the
    // default in between; restoreModelChoice issues one refresh at the end.
    const response = await controller.runSuppressingModelRefresh(async () => {
      const res = await controller.sendCommand({ type: 'new_session' });
      if (res.success) {
        // pi has already created the session at this point, so a failed re-apply
        // is non-fatal: warn, but still let the caller reset the view below.
        // Swallowing it here also stops a restore failure from being reported
        // as a "new session failed" that never happened.
        try {
          await controller.restoreModelChoice();
        } catch (err) {
          // err.message, not String(err) — the latter prefixes "Error: " and
          // duplicates the detail already in the output channel.
          const detail = err instanceof Error ? err.message : String(err);
          void vscode.window.showWarningMessage(
            `Sqowe Wingman: new session started, but the remembered model and thinking level could not be restored — ${detail}`,
          );
        }
      }
      return res;
    });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: new session failed — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    // Notify the controller so it can refresh commands / stats and clear the
    // webview transcript (a new session starts empty).
    controller.onNewSession({ clearTranscript: true });
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: new session failed — ${String(err)}`);
  }
}
