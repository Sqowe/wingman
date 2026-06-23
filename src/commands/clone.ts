/**
 * clone — Sqowe Wingman: Clone Session command.
 * Calls pi's `clone` RPC command to duplicate the current session.
 *
 * Like fork, clone branches the existing conversation, so the transcript
 * already on screen stays valid — onNewSession() is called WITHOUT
 * clearTranscript (it only refreshes stats / commands for the new session id).
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

export async function cloneSession(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'clone' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: clone failed — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    const data = (typeof response.data === 'object' && response.data !== null)
      ? response.data as Record<string, unknown>
      : {};
    // Tolerate both camelCase and snake_case session id keys.
    const sessionId = typeof data['sessionId'] === 'string'
      ? data['sessionId']
      : typeof data['session_id'] === 'string'
        ? data['session_id']
        : undefined;
    void vscode.window.showInformationMessage(
      sessionId
        ? `Sqowe Wingman: cloned into session ${sessionId}.`
        : 'Sqowe Wingman: session cloned.',
    );
    controller.onNewSession();
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: clone failed — ${String(err)}`);
  }
}
