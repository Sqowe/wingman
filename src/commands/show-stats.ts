/**
 * showStats command handler — shows a notification popup summarising session statistics.
 *
 * Triggered by clicking the session-stats status bar item (sqoweWingman.showStats).
 * Cost is intentionally dropped from this surface per the context-window-indicator
 * design (see docs/design/context-window-indicator.md §5.5).
 *
 * Composed as:
 *   - `Context: <fraction> (<pct>%)`  when contextUsage is known and complete
 *   - `Tokens: <total>`               session totals (always shown as a fallback)
 *   - `Messages: <count>`             always
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';
import {
  formatTokens,
  formatContextFraction,
  formatPercent,
  formatMessages,
} from '../shared/stats-format';

export async function showStats(controller: AgentController): Promise<void> {
  const stats = controller.lastSessionStats;
  if (!stats) {
    await vscode.window.showInformationMessage('Sqowe Wingman: no session stats yet.');
    return;
  }
  const tokens = formatTokens(stats.totalTokens);
  const fraction = stats.contextUsage
    ? formatContextFraction(stats.contextUsage)
    : null;
  const pct = stats.contextUsage ? formatPercent(stats.contextUsage.percent) : '—';
  const messages = formatMessages(stats.totalMessages);

  // Compose the parts: context is the headline (when known), tokens fall back when
  // no contextUsage is available (old pi, no model yet, etc.).
  const parts: string[] = [];
  if (fraction) parts.push(`Context: ${fraction} (${pct}%)`);
  parts.push(`Tokens: ${tokens}`);
  parts.push(`Messages: ${messages}`);
  await vscode.window.showInformationMessage(`Sqowe Wingman — ${parts.join('  ')}`);
}