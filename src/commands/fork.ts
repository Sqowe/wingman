/**
 * fork — Sqowe Wingman: Fork Session command.
 * Calls pi's `fork` RPC command to create a branch of the current session.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

export async function forkSession(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'fork' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: fork failed — ${response.error ?? 'unknown error'}`,
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
        ? `Sqowe Wingman: forked into session ${sessionId}.`
        : 'Sqowe Wingman: session forked.',
    );
    controller.onNewSession();
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: fork failed — ${String(err)}`);
  }
}
