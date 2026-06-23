/**
 * new-session — Sqowe Wingman: New Session command.
 * Calls pi's `new_session` RPC command to start a fresh conversation.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

export async function newSession(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'new_session' });
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
