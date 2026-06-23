/**
 * WingmanStatusBar — always-visible status bar item showing session stats.
 *
 * Displays: tokens used · estimated cost · total messages
 * Updated after every agent turn via AgentController.
 */

import * as vscode from 'vscode';
import type { SessionStats } from './shared/messages';
import { formatTokens, formatCost, formatMessages } from './shared/stats-format';

export class WingmanStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      'sqoweWingman.sessionStats',
      vscode.StatusBarAlignment.Right,
      // Priority: sit to the right of most items but to the left of language/encoding.
      90,
    );
    this._item.name = 'Sqowe Wingman Stats';
    this._item.tooltip = 'Sqowe Wingman — session statistics';
    this._item.command = 'sqoweWingman.showStats';
    this._item.text = '$(hubot) Wingman';
    this._item.show();
  }

  /**
   * Update the status bar with fresh session statistics.
   * All fields are optional — show a dash when pi does not report them.
   */
  public update(stats: SessionStats): void {
    const tokens = formatTokens(stats.totalTokens);
    const cost = formatCost(stats.totalCost);
    const messages = formatMessages(stats.totalMessages);

    this._item.text = `$(hubot) ${tokens} · ${cost} · ${messages} msg`;
    this._item.tooltip = new vscode.MarkdownString(
      `**Sqowe Wingman**\n\n` +
      `| | |\n|---|---|\n` +
      `| Tokens | ${tokens} |\n` +
      `| Cost | ${cost} |\n` +
      `| Messages | ${messages} |`,
    );
  }

  /** Reset to the idle label (e.g. after new_session). */
  public reset(): void {
    this._item.text = '$(hubot) Wingman';
    this._item.tooltip = 'Sqowe Wingman — session statistics';
  }

  public dispose(): void {
    this._item.dispose();
  }
}

