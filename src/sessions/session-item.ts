/**
 * SessionItem — represents a session in the tree view.
 */

import * as vscode from 'vscode';
import * as os from 'os';

export class SessionItem extends vscode.TreeItem {
  public readonly sessionPath: string;
  public readonly sessionId: string;
  public readonly sessionName: string;
  public readonly cwd: string;
  public readonly timestamp: string;
  public readonly messageCount: number;

  constructor(
    sessionPath: string,
    /** Pre-computed human-readable title (from deriveSessionTitle). */
    title: string,
    sessionId: string,
    sessionName: string | undefined,
    cwd: string,
    timestamp: string,
    messageCount: number,
  ) {
    super(title, vscode.TreeItemCollapsibleState.None);

    this.sessionPath = sessionPath;
    this.sessionId = sessionId;
    this.sessionName = sessionName ?? '';
    this.cwd = cwd;
    this.timestamp = timestamp;
    this.messageCount = messageCount;

    // Description: short date · message count (cwd is shown by the project
    // group header so it's redundant here).
    const date = formatShortDate(timestamp);
    this.description = `${date} · ${messageCount} msgs`;

    // Tooltip: bold title + full disambiguation details.
    // Escape markdown in untrusted strings (title from user message, paths)
    // to prevent misleading rendering in the MarkdownString.
    const home = os.homedir();
    const displayCwd = cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
    const safeTitle = escapeMd(title);
    const createdStr = (() => {
      const d = new Date(timestamp);
      return Number.isNaN(d.getTime()) ? timestamp : d.toLocaleString();
    })();
    this.tooltip = new vscode.MarkdownString(
      `**${safeTitle}**\n\n` +
      `Path: \`${escapeBackticks(sessionPath)}\`\n` +
      `Working Directory: \`${escapeBackticks(displayCwd)}\`\n` +
      `Messages: ${messageCount}\n` +
      `Created: ${createdStr}` +
      (sessionId ? `\nID: \`${escapeBackticks(sessionId)}\`` : ''),
    );

    this.iconPath = new vscode.ThemeIcon('file-code');

    this.command = {
      command: 'sqoweWingman.switchSession',
      title: 'Switch Session',
      arguments: [this],
    };

    this.contextValue = 'session';
  }
}

/**
 * Escape markdown special characters in a string so it renders as plain text
 * inside a vscode.MarkdownString tooltip.
 */
function escapeMd(s: string): string {
  // Escape characters that have meaning in Markdown: \ ` * _ { } [ ] ( ) # + - . !
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

/** Escape backticks so a string is safe inside a Markdown inline code span. */
function escapeBackticks(s: string): string {
  return s.replace(/`/g, '\\`');
}

/**
 * Format a timestamp as a short date string, e.g. "27 Jun".
 * Falls back to the raw timestamp string on parse failure.
 */
function formatShortDate(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
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
