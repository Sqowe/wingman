/**
 * compact — Sqowe Wingman: Compact Session command.
 * Calls pi's `compact` RPC command to summarise and truncate the conversation.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

export async function compactSession(controller: AgentController): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Compact the current session? The conversation history will be summarised and older messages removed.',
    { modal: true },
    'Compact',
  );
  if (confirm !== 'Compact') return;

  try {
    const response = await controller.sendCommand({ type: 'compact' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: compact failed — ${response.error ?? 'unknown error'}`,
      );
    }
    // The webview will display the compaction_start / compaction_end events
    // streamed by pi — no extra notification needed on success.
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: compact failed — ${String(err)}`);
  }
}
