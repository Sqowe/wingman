/**
 * thinking-level — Sqowe Wingman: Set / Cycle Thinking Level commands.
 * setThinkingLevel shows a quick-pick and calls set_thinking_level;
 * cycleThinkingLevel calls cycle_thinking_level to advance to the next level.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

const THINKING_LEVELS: vscode.QuickPickItem[] = [
  { label: 'none',     description: 'No extended thinking' },
  { label: 'low',      description: 'Minimal thinking budget' },
  { label: 'medium',   description: 'Moderate thinking budget' },
  { label: 'high',     description: 'Large thinking budget' },
  { label: 'max',      description: 'Maximum thinking budget' },
];

export async function setThinkingLevel(controller: AgentController): Promise<void> {
  const picked = await vscode.window.showQuickPick(THINKING_LEVELS, {
    title: 'Sqowe Wingman: Set Thinking Level',
    placeHolder: 'Choose an extended-thinking level for this session',
  });
  if (!picked) return;

  try {
    const response = await controller.sendCommand({
      type: 'set_thinking_level',
      level: picked.label,
    });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not set thinking level — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Sqowe Wingman: thinking level set to "${picked.label}".`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: could not set thinking level — ${String(err)}`,
    );
  }
}

/** Read the new thinking level from a cycle_thinking_level response (tolerant of shape). */
function readCurrentLevel(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const o = data as Record<string, unknown>;
  for (const key of ['level', 'thinkingLevel', 'thinking_level', 'current', 'currentLevel']) {
    if (typeof o[key] === 'string' && o[key]) return o[key] as string;
  }
  return undefined;
}

export async function cycleThinkingLevel(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'cycle_thinking_level' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not cycle thinking level — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    const level = readCurrentLevel(response.data);
    void vscode.window.showInformationMessage(
      level
        ? `Sqowe Wingman: thinking level set to "${level}".`
        : 'Sqowe Wingman: thinking level cycled.',
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: could not cycle thinking level — ${String(err)}`,
    );
  }
}
