/**
 * SessionItem — represents a session in the tree view.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export class SessionItem extends vscode.TreeItem {
  public readonly sessionPath: string;
  public readonly sessionName: string;
  public readonly cwd: string;
  public readonly timestamp: string;
  public readonly messageCount: number;

  constructor(
    sessionPath: string,
    sessionName: string | undefined,
    cwd: string,
    timestamp: string,
    messageCount: number,
  ) {
    const label = sessionName ?? path.basename(sessionPath, '.jsonl');
    super(label, vscode.TreeItemCollapsibleState.None);

    this.sessionPath = sessionPath;
    this.sessionName = sessionName ?? '';
    this.cwd = cwd;
    this.timestamp = timestamp;
    this.messageCount = messageCount;

    // Show the working directory as description
    const home = os.homedir();
    const displayCwd = cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
    this.description = `${displayCwd} • ${messageCount} msgs`;

    // Format tooltip with full details
    this.tooltip = new vscode.MarkdownString(
      `**${label}**\n\n` +
      `Path: ${sessionPath}\n` +
      `Working Directory: ${cwd}\n` +
      `Messages: ${messageCount}\n` +
      `Created: ${new Date(timestamp).toLocaleString()}`,
    );

    // Icon based on whether it's the current session
    this.iconPath = new vscode.ThemeIcon('file-code');

    // Command to execute when clicked
    this.command = {
      command: 'sqoweWingman.switchSession',
      title: 'Switch Session',
      arguments: [this],
    };

    // Context value for context menu
    this.contextValue = 'session';
  }
}

/**
 * ProjectFolderItem — represents a project folder grouping in the tree view.
 */
export class ProjectFolderItem extends vscode.TreeItem {
  public readonly projectPath: string;

  constructor(projectPath: string, sessionsCount: number, isCurrent = false) {
    const home = os.homedir();
    const label = projectPath.startsWith(home)
      ? projectPath.replace(home, '~')
      : projectPath;
    // The current workspace's group starts expanded so its sessions are
    // immediately visible; other projects stay collapsed.
    super(
      label,
      isCurrent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    this.projectPath = projectPath;
    const count = `${sessionsCount} session${sessionsCount === 1 ? '' : 's'}`;
    this.description = isCurrent ? `current • ${count}` : count;
    this.iconPath = new vscode.ThemeIcon(isCurrent ? 'root-folder-opened' : 'folder');
    this.contextValue = isCurrent ? 'projectFolderCurrent' : 'projectFolder';
    this.tooltip = isCurrent
      ? `Project: ${projectPath} (current workspace)`
      : `Project: ${projectPath}`;
  }
}
