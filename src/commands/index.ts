/**
 * commands/index.ts — registers all Phase 5 native commands.
 *
 * Called once from extension.ts activate(). Each command delegates to its
 * handler module and receives the shared AgentController instance.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';
import { pickModel, cycleModel } from './model-picker';
import { compactSession } from './compact';
import { newSession } from './new-session';
import { forkSession } from './fork';
import { cloneSession } from './clone';
import { exportHtml } from './export-html';
import { showStats } from './show-stats';
import { setThinkingLevel, cycleThinkingLevel } from './thinking-level';
// showStats uses the format helpers internally — no shared imports needed here.

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: AgentController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sqoweWingman.setModel', () =>
      pickModel(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.cycleModel', () =>
      cycleModel(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.compactSession', () =>
      compactSession(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.newSession', () =>
      newSession(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.forkSession', () =>
      forkSession(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.cloneSession', () =>
      cloneSession(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.exportHtml', () =>
      exportHtml(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.setThinkingLevel', () =>
      setThinkingLevel(controller),
    ),

    vscode.commands.registerCommand('sqoweWingman.cycleThinkingLevel', () =>
      cycleThinkingLevel(controller),
    ),

    // Show a stats summary in an information message (status bar item's command).
    vscode.commands.registerCommand('sqoweWingman.showStats', () => showStats(controller)),
  );
}
