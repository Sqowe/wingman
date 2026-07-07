/**
 * WingmanStatusBar — always-visible status bar item showing session stats.
 *
 * Displays: context-window fraction + percent · total messages
 * Updated after every agent turn via AgentController.
 *
 * Model / thinking level intentionally NOT shown here — they live on the
 * adjacent ModelStatusBar (priority 91, see below) so duplication is avoided.
 */

import * as vscode from 'vscode';
import type { SessionStats, ModelState } from './shared/messages';
import {
  formatContextText,
  formatContextTooltipBody,
  formatModelStatus,
} from './shared/stats-format';

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
   * The 1-line text always has three slots (context / cost-fallback / messages)
   * per formatContextText; the tooltip shows the same context info without
   * duplicating the model (which lives on the adjacent Model status bar item).
   */
  public update(stats: SessionStats): void {
    this._item.text = `$(hubot) ${formatContextText(stats)}`;
    this._item.tooltip = new vscode.MarkdownString(
      `**Sqowe Wingman**\n\n` +
      formatContextTooltipBody(stats),
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

/**
 * ModelStatusBar — always-visible status bar item showing the active model and
 * thinking level. Clicking it opens the Set Model picker.
 *
 * Fed by AgentController.onModelState (a get_state refresh on start and after
 * any model/thinking/session-affecting command).
 */
export class ModelStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private static readonly IDLE_TOOLTIP =
    'Sqowe Wingman — model & thinking level (click to change model)';

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      'sqoweWingman.model',
      vscode.StatusBarAlignment.Right,
      // Sit just to the left of the session-stats item (priority 90).
      91,
    );
    this._item.name = 'Sqowe Wingman Model';
    this._item.command = 'sqoweWingman.setModel';
    this.reset();
    this._item.show();
  }

  /** Update with the active model + thinking level (null = unknown / pi down). */
  public update(state: ModelState | null): void {
    if (!state || (!state.modelId && !state.modelName)) {
      this.reset();
      return;
    }
    this._item.text = `$(sparkle) ${formatModelStatus(state)}`;
    this._item.tooltip = new vscode.MarkdownString(
      `**Sqowe Wingman**\n\n` +
      `| | |\n|---|---|\n` +
      `| Model | ${state.modelName ?? state.modelId} |\n` +
      `| Id | ${state.modelId ?? '—'} |\n` +
      `| Provider | ${state.provider ?? '—'} |\n` +
      `| Thinking | ${state.thinkingLevel ?? '—'} |\n\n` +
      `_Click to change model._`,
    );
  }

  /** Reset to the idle label (before the first fetch, or when pi is down). */
  public reset(): void {
    this._item.text = '$(sparkle) Model';
    this._item.tooltip = ModelStatusBar.IDLE_TOOLTIP;
  }

  public dispose(): void {
    this._item.dispose();
  }
}

