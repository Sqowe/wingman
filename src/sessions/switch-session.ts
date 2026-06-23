/**
 * switch-session — Switch to a different pi session.
 *
 * Calls pi's `switch_session` RPC command, then loads the conversation
 * via `get_messages` and sends it to the webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentController } from '../agent/controller';
import type { SessionMetadata } from './session-tree-provider';
import { SessionItem } from './session-item';
import { getTreeProvider } from './index';

const LAST_SESSION_KEY = 'sqoweWingman.lastSessionPath';

export async function switchSession(
  controller: AgentController,
  sessionPathOrItem?: string | SessionItem | SessionMetadata,
  context?: vscode.ExtensionContext,
): Promise<void> {
  try {
    let sessionPath: string | undefined;

    if (typeof sessionPathOrItem === 'string') {
      sessionPath = sessionPathOrItem;
    } else if (sessionPathOrItem) {
      // Type guard to get sessionPath
      if (sessionPathOrItem instanceof SessionItem) {
        sessionPath = sessionPathOrItem.sessionPath;
      } else {
        sessionPath = sessionPathOrItem.sessionPath;
      }
    } else {
      // Prompt user to pick a session
      sessionPath = await pickSession(controller);
    }

    if (!sessionPath) {
      return; // User cancelled or no session selected
    }

    // Call switch_session RPC command
    const success = await controller.switchSession(sessionPath);

    if (!success) {
      void vscode.window.showInformationMessage('Sqowe Wingman: session switch cancelled.');
      return;
    }

    // Save session path for persistence (controller.switchSession already loaded messages)
    if (context) {
      context.workspaceState.update(LAST_SESSION_KEY, sessionPath);
    }

    void vscode.window.showInformationMessage('Sqowe Wingman: session switched successfully.');
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: failed to switch session — ${String(err)}`,
    );
  }
}

/**
 * Prompt user to pick a session from a quick pick.
 * Uses the tree provider's cached data for efficiency.
 */
async function pickSession(controller: AgentController): Promise<string | undefined> {
  const provider = getTreeProvider();
  if (!provider) {
    void vscode.window.showErrorMessage('Sqowe Wingman: session tree not initialized.');
    return undefined;
  }

  // Ensure sessions are loaded
  await provider.ensureLoaded();

  // Only offer sessions for the open workspace folder(s) — see
  // SessionTreeProvider.getScopedSessions / filterSessionsToCwds.
  const sessions = provider.getScopedSessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      'Sqowe Wingman: no sessions for this workspace yet.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map(s => ({
      label: s.sessionName || path.basename(s.sessionPath, '.jsonl'),
      description: s.cwd,
      detail: s.sessionPath,
    })),
    { placeHolder: 'Select a session to switch to...' },
  );

  return picked?.detail as string | undefined;
}

/**
 * Switch to a session by path (called from the tree view).
 */
export async function switchSessionByPath(
  controller: AgentController,
  sessionPath: string,
): Promise<void> {
  await switchSession(controller, { sessionPath } as SessionMetadata);
}
