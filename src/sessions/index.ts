/**
 * sessions/index.ts — registers the Sessions tree view and commands.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import type { AgentController } from '../agent/controller';
import { SessionTreeProvider } from './session-tree-provider';
import { switchSession } from './switch-session';
import type { SessionItem } from './session-item';
import { planRename, applyRenamePlan, setTitle, removeTitle } from './session-titles';

/**
 * Structural guard for a tree-item command argument. Tree-view command args
 * are live object instances, but a shape check (consistent with
 * `switchSession`) avoids `instanceof` fragility under bundling or object
 * revival in test setups. Narrows to `SessionItem` so `title` / `sessionId`
 * are typed.
 */
function isSessionItemArg(arg: unknown): arg is SessionItem {
  if (!arg || typeof arg !== 'object') return false;
  const a = arg as Record<string, unknown>;
  // Validate the *types* of exactly the fields the handler reads
  // (`item.sessionId`, `item.title`) so a wrong-typed argument can't throw.
  // `sessionPath` is not read by this command, so we deliberately don't
  // require it — keeps the guard robust if SessionItem's path type changes.
  return typeof a.sessionId === 'string' && typeof a.title === 'string';
}

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

    // Rename Session (Phase 1.5) — context-menu only. Resolves the row,
    // shows an input box prefilled with the current title (all selected),
    // then plans set/reset/no-op via the pure `planRename` helper and
    // persists via the existing title index writer. Empty submit resets to
    // the derived first-message title; accepting the prefilled value
    // verbatim is a no-op (does not pin a derived title as manual); Esc cancels.
    vscode.commands.registerCommand(
      'sqoweWingman.renameSession',
      async (arg: unknown) => {
        if (!isSessionItemArg(arg)) {
          // The menu's `when: viewItem == session` clause means this is only
          // reachable from a session row in normal use; a miss here implies a
          // programmatic/unexpected invocation. Warn (no user popup) so
          // mis-wiring is diagnosable without noisy dialogs.
          console.warn(
            'sqoweWingman.renameSession: invoked without a valid session item; ignoring.',
          );
          return;
        }
        const item = arg;
        const valueSelectionEnd = item.title.length;
        const input = await vscode.window.showInputBox({
          value: item.title,
          valueSelection: [0, valueSelectionEnd],
          prompt: 'Rename session (leave empty to reset to the default title)',
        });
        const plan = planRename(input, item.title);
        // Persist + refresh + surface failures. Orchestrated in a pure,
        // unit-tested helper (applyRenamePlan) so the vscode-bound handler
        // stays thin and the wiring — including the error path — is covered.
        await applyRenamePlan(plan, item.sessionId, {
          setTitle,
          removeTitle,
          onChanged: () => treeProvider.refresh(),
          onError: (message) => {
            void vscode.window.showErrorMessage(`Sqowe Wingman: ${message}`);
          },
        });
      },
    ),

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
