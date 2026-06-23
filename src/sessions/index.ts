/**
 * sessions/index.ts — registers the Sessions tree view and commands.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { AgentController } from '../agent/controller';
import { SessionTreeProvider } from './session-tree-provider';
import { switchSession } from './switch-session';

// Module-level provider for use by other session modules
let _treeProvider: SessionTreeProvider | undefined;

export function registerSessions(
  context: vscode.ExtensionContext,
  controller: AgentController,
): void {
  const treeProvider = new SessionTreeProvider();
  _treeProvider = treeProvider;

  // Register the tree view
  const treeView = vscode.window.createTreeView('sqoweWingman.sessions', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,

    // Register switch session command (called from tree view)
    vscode.commands.registerCommand(
      'sqoweWingman.switchSession',
      async (arg: unknown) => {
        // The argument can be:
        // - string (sessionPath directly from tree item)
        // - SessionItem (has sessionPath property)
        // - undefined (trigger QuickPick)
        let sessionPath: string | undefined;

        if (typeof arg === 'string') {
          sessionPath = arg;
        } else if (arg && typeof arg === 'object' && 'sessionPath' in arg) {
          sessionPath = (arg as { sessionPath: string }).sessionPath;
        }

        if (sessionPath) {
          await switchSession(controller, sessionPath, context);
        } else {
          await switchSession(controller, undefined, context);
        }
      },
    ),

    // Register refresh sessions command
    vscode.commands.registerCommand('sqoweWingman.refreshSessions', () => {
      treeProvider.refresh();
    }),

    // Refresh the tree when the controller creates/branches a session
    // (new / fork / clone) so new sessions appear without a manual refresh.
    controller.onSessionsChanged(() => treeProvider.refresh()),
  );

  // Watch the shared sessions directory so sessions created outside the
  // extension (e.g. by the pi CLI) appear without a manual refresh. Change
  // events are ignored to avoid a refresh on every message pi writes to the
  // active session; create/delete are debounced to avoid bursts.
  try {
    const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(sessionsDir), '**/*.jsonl'),
      false, // create
      true, // ignore change
      false, // delete
    );
    let pending: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefresh = (): void => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => treeProvider.refresh(), 400);
    };
    watcher.onDidCreate(debouncedRefresh);
    watcher.onDidDelete(debouncedRefresh);
    context.subscriptions.push(watcher);
  } catch {
    // createFileSystemWatcher can throw in exotic hosts — non-fatal; the
    // controller event and manual Refresh still keep the tree current.
  }

  // Initial load
  treeProvider.refresh();
}

/**
 * Get the tree provider instance (for use by other session modules).
 */
export function getTreeProvider(): SessionTreeProvider | undefined {
  return _treeProvider;
}
