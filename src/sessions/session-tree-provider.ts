/**
 * SessionTreeProvider — VS Code TreeDataProvider for pi sessions.
 *
 * Reads session files from ~/.pi/agent/sessions/ and displays them
 * grouped by project directory.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import { SessionItem, ProjectFolderItem } from './session-item';
import {
  SessionMetadataAccumulator,
  groupSessionsByProject,
  sortSessionsByRecency,
} from './session-parse';
import type { SessionMetadata } from './session-parse';

export type { SessionMetadata } from './session-parse';

/** Build a tree leaf for one session. */
function toSessionItem(s: SessionMetadata): SessionItem {
  return new SessionItem(s.sessionPath, s.sessionName, s.cwd, s.timestamp, s.messageCount);
}

export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _sessionsDir: string;
  private _sessions: SessionMetadata[] = [];
  private _groupByProject = true;
  private _loadingPromise: Promise<void> | undefined;
  private _isLoaded = false;
  private _dirty = true; // Set to true to force reload on next access

  constructor() {
    this._sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  refresh(): void {
    // Mark as dirty so next access reloads
    this._dirty = true;
    this._isLoaded = false;
    // Trigger async reload; fire event when done
    this._loadSessions().then(() => {
      this._onDidChangeTreeData.fire();
    }).catch((err) => {
      console.error('Failed to refresh sessions:', err);
      this._onDidChangeTreeData.fire();
    });
  }

  /**
   * Ensure sessions are loaded. Resolves immediately if already loaded and not dirty.
   */
  async ensureLoaded(): Promise<void> {
    if (this._isLoaded && !this._dirty) {
      return;
    }
    return this._loadSessions();
  }

  private async _loadSessions(): Promise<void> {
    // Coalesce concurrent loads
    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    this._loadingPromise = this._doLoadSessions();
    try {
      await this._loadingPromise;
      this._isLoaded = true;
      this._dirty = false;
    } finally {
      this._loadingPromise = undefined;
    }
  }

  private async _doLoadSessions(): Promise<void> {
    this._sessions = [];

    if (!await this._fileExists(this._sessionsDir)) {
      return;
    }

    try {
      const dirs = await fs.readdir(this._sessionsDir);

      for (const dir of dirs) {
        const dirPath = path.join(this._sessionsDir, dir);
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
          continue;
        }

        // Parse sessions from this directory
        await this._parseSessionDir(dirPath);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async _parseSessionDir(dirPath: string): Promise<void> {
    try {
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        const filePath = path.join(dirPath, file);
        const metadata = await this._parseSessionMetadata(filePath);
        if (metadata) {
          this._sessions.push(metadata);
        }
      }
    } catch (err) {
      console.error('Failed to parse session dir:', err);
    }
  }

  private async _parseSessionMetadata(sessionPath: string): Promise<SessionMetadata | null> {
    let fileStream: fsSync.ReadStream | undefined;
    let rl: readline.Interface | undefined;
    try {
      // Stream the file line-by-line (no full load into memory) and fold each
      // line into the pure metadata accumulator (see session-parse.ts).
      fileStream = fsSync.createReadStream(sessionPath, { encoding: 'utf-8' });
      rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      const acc = new SessionMetadataAccumulator();
      for await (const line of rl) {
        acc.addLine(line);
      }
      return acc.finalize(sessionPath);
    } catch (err) {
      console.error('Failed to parse session:', sessionPath, err);
      return null;
    } finally {
      // Clean up readline interface and file stream
      if (rl) {
        rl.close();
      }
      if (fileStream) {
        fileStream.close();
      }
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      // Root level - return project folders (or a flat list).
      // Ensure sessions are loaded (uses cache if available).
      return this.ensureLoaded().then(() => {
        if (this._sessions.length === 0) {
          return [];
        }

        if (this._groupByProject) {
          // Group by project directory. The open workspace folders sort first
          // and render expanded, so the sessions you can actually resume here
          // are surfaced ahead of other projects (pi's process cwd is pinned
          // to the workspace folder).
          return groupSessionsByProject(this._sessions, this._currentCwds()).map(
            (g) => new ProjectFolderItem(g.projectPath, g.sessions.length, g.isCurrent),
          );
        }

        // Flat list, newest first.
        return sortSessionsByRecency(this._sessions).map(toSessionItem);
      });
    } else if (element instanceof ProjectFolderItem) {
      // Return this project's sessions, newest first.
      const sessions = sortSessionsByRecency(
        this._sessions.filter((s) => s.cwd === element.projectPath),
      );
      return Promise.resolve(sessions.map(toSessionItem));
    }

    return Promise.resolve([]);
  }

  /** Absolute paths of the currently open workspace folders. */
  private _currentCwds(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  /**
   * Get session metadata by path.
   */
  getSessionByPath(sessionPath: string): SessionMetadata | undefined {
    return this._sessions.find((s) => s.sessionPath === sessionPath);
  }

  /**
   * Get all sessions.
   */
  getAllSessions(): SessionMetadata[] {
    return this._sessions;
  }
}
