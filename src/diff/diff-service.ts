/**
 * DiffService — wires pi's `edit` tool patches into VS Code's native diff editor.
 *
 * Two public operations:
 *  - previewDiff(patch, cwd)  — opens VS Code's diff editor (before ↔ after, read-only)
 *  - applyPatch(patch, cwd)   — applies changes via WorkspaceEdit (appears in Source Control)
 *
 * Implements TextDocumentContentProvider for the `wingman-diff:` scheme.
 *
 * Security design:
 *  - `cwd` MUST be derived from `vscode.workspace.workspaceFolders` (never webview input).
 *  - `_resolve` resolves symlinks via `fs.promises.realpath` and validates the real path
 *    against workspace folder real paths.
 *  - For new-file patches, the parent directory must already exist and be realpath-resolved;
 *    a non-existent parent is rejected to prevent post-validation symlink-swap on creation.
 *  - Before each I/O operation (readFile / openTextDocument / applyEdit), the path is
 *    re-realpathed and re-validated to close the TOCTOU window for existing-file patches.
 *  - Patch size is capped at MAX_PATCH_BYTES inside DiffService itself so the guard holds
 *    regardless of the call site.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MAX_PATCH_BYTES } from '../shared/limits';

/** Virtual URI scheme for before/after documents shown in the diff editor. */
export const DIFF_SCHEME = 'wingman-diff';

/** Maximum number of before/after snapshots retained in memory (simple LRU cap). */
const MAX_SNAPSHOTS = 40; // 20 diff pairs

/** One stored snapshot (before or after text) keyed by URI path. */
interface Snapshot {
  text: string;
  language: string;
}

// ─── Unified diff parser ──────────────────────────────────────────────────────

interface PatchFile {
  filePath: string;
  isNewFile: boolean;
  isDeletion: boolean;
}

/**
 * Extract all target file path info from a unified diff.
 * Handles `+++ b/path`, `+++ path`, `+++ /dev/null`, CRLF line endings, and
 * strips timestamps / extra tokens after the path (split on first whitespace).
 */
function extractAllFilePaths(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patch.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('--- ')) continue;

    const nextLine = (lines[i + 1] ?? '').replace(/\r$/, '');
    if (!nextLine.startsWith('+++ ')) continue;

    const minusRaw = (line.slice(4).trim().split(/\s+/)[0]) ?? '';
    const plusRaw  = (nextLine.slice(4).trim().split(/\s+/)[0]) ?? '';

    const isNewFile  = minusRaw === '/dev/null';
    const isDeletion = plusRaw  === '/dev/null';

    let filePath: string;
    if (isDeletion) {
      filePath = minusRaw.startsWith('a/') ? minusRaw.slice(2) : minusRaw;
    } else {
      filePath = plusRaw.startsWith('b/') ? plusRaw.slice(2) : plusRaw;
    }

    files.push({ filePath, isNewFile, isDeletion });
    i++;
  }
  return files;
}

/**
 * Apply a unified diff patch to an original string.
 * Strict mode: context (' ') and deletion ('-') lines are verified against
 * `origLines[cursor]`; a mismatch throws rather than producing corrupted output.
 */
export function applyUnifiedPatch(original: string, patch: string): string {
  const origLines  = original.replace(/\r\n/g, '\n').split('\n');
  const patchLines = patch.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let cursor = 0;

  let i = 0;
  while (i < patchLines.length && !patchLines[i].startsWith('@@')) i++;

  while (i < patchLines.length) {
    const hunkHeader = patchLines[i];
    if (!hunkHeader.startsWith('@@')) { i++; continue; }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
    if (!match) throw new Error(`DiffService: malformed hunk header: ${hunkHeader}`);

    const origStart = parseInt(match[1], 10) - 1;
    const origCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const newCount  = match[4] !== undefined ? parseInt(match[4], 10) : 1;
    i++;

    if (origStart > origLines.length) {
      throw new Error(
        `DiffService: hunk start line ${origStart + 1} is beyond end of file (${origLines.length} lines)`,
      );
    }

    while (cursor < origStart) { output.push(origLines[cursor]); cursor++; }

    let origConsumed = 0;
    let newProduced  = 0;

    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const hunkLine = patchLines[i];
      const prefix  = hunkLine.charAt(0);
      const content = hunkLine.slice(1);

      if (prefix === ' ') {
        if (cursor >= origLines.length)
          throw new Error(`DiffService: context line at position ${cursor} is beyond end of file`);
        if (origLines[cursor] !== content)
          throw new Error(
            `DiffService: context mismatch at line ${cursor + 1}: ` +
            `file has ${JSON.stringify(origLines[cursor])}, patch expected ${JSON.stringify(content)}`,
          );
        output.push(content); cursor++; origConsumed++; newProduced++;
      } else if (prefix === '+') {
        output.push(content); newProduced++;
      } else if (prefix === '-') {
        if (cursor >= origLines.length)
          throw new Error(`DiffService: deletion line at position ${cursor} is beyond end of file`);
        if (origLines[cursor] !== content)
          throw new Error(
            `DiffService: deletion mismatch at line ${cursor + 1}: ` +
            `file has ${JSON.stringify(origLines[cursor])}, patch expected ${JSON.stringify(content)}`,
          );
        cursor++; origConsumed++;
      } // '\' (no-newline marker) is ignored
      i++;
    }

    if (origConsumed !== origCount)
      throw new Error(`DiffService: hunk consumed ${origConsumed} original lines but header declared ${origCount}`);
    if (newProduced !== newCount)
      throw new Error(`DiffService: hunk produced ${newProduced} new lines but header declared ${newCount}`);
  }

  while (cursor < origLines.length) { output.push(origLines[cursor]); cursor++; }
  return output.join('\n');
}

// ─── DiffService ─────────────────────────────────────────────────────────────

export class DiffService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _snapshots = new Map<string, Snapshot>();
  private readonly _onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChangeEmitter.event;

  // ─── TextDocumentContentProvider ─────────────────────────────────────────

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this._snapshots.get(uri.path)?.text ?? '';
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Open VS Code's diff editor showing before ↔ after for the given patch.
   * `cwd` MUST come from `vscode.workspace.workspaceFolders`.
   */
  public async previewDiff(patch: string, cwd: string): Promise<void> {
    this._checkPatchSize(patch);
    const resolved = await this._resolve(patch, cwd);

    if (resolved.isDeletion) {
      throw new Error(
        'DiffService: file-deletion patches cannot be previewed. Delete the file manually.',
      );
    }

    const { filePath, realPath, beforeText, afterText, isNewFile } = resolved;
    const language = this._languageId(filePath);
    const label    = path.basename(realPath);

    // Re-validate before reading the file (TOCTOU guard for existing files).
    if (!isNewFile) {
      await this._reRealpathAndValidate(realPath);
    }

    const posixPath = filePath.replace(/\\/g, '/');
    const beforeKey = `/before/${posixPath}`;
    const afterKey  = `/after/${posixPath}`;

    this._storeSnapshot(beforeKey, { text: beforeText, language });
    this._storeSnapshot(afterKey,  { text: afterText,  language });

    const beforeUri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: beforeKey });
    const afterUri  = vscode.Uri.from({ scheme: DIFF_SCHEME, path: afterKey  });

    this._onDidChangeEmitter.fire(beforeUri);
    this._onDidChangeEmitter.fire(afterUri);

    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `wingman: ${label} (edit preview)`,
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );

    try {
      const beforeDoc = await vscode.workspace.openTextDocument(beforeUri);
      const afterDoc  = await vscode.workspace.openTextDocument(afterUri);
      await vscode.languages.setTextDocumentLanguage(beforeDoc, language);
      await vscode.languages.setTextDocumentLanguage(afterDoc,  language);
    } catch { /* non-critical */ }
  }

  /**
   * Apply the patch as a real `WorkspaceEdit`.
   * `cwd` MUST come from `vscode.workspace.workspaceFolders`.
   */
  public async applyPatch(patch: string, cwd: string): Promise<void> {
    this._checkPatchSize(patch);
    const resolved = await this._resolve(patch, cwd);
    const { realPath, afterText, isNewFile, isDeletion, fileExisted } = resolved;

    if (isDeletion) {
      throw new Error(
        'DiffService: file-deletion patches are not supported. Delete the file manually.',
      );
    }

    if (!isNewFile && !fileExisted) {
      throw new Error(
        `DiffService: target file does not exist and patch is not a new-file patch: ${realPath}`,
      );
    }

    // Re-validate immediately before the write (TOCTOU guard for existing files).
    if (!isNewFile) {
      await this._reRealpathAndValidate(realPath);
    }

    const fileUri = vscode.Uri.file(realPath);
    const edit    = new vscode.WorkspaceEdit();

    if (isNewFile) {
      edit.createFile(fileUri, { ignoreIfExists: false });
      edit.insert(fileUri, new vscode.Position(0, 0), afterText);
    } else {
      const document = await vscode.workspace.openTextDocument(fileUri);
      const lastLine = document.lineAt(document.lineCount - 1);
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        lastLine.rangeIncludingLineBreak.end,
      );
      edit.replace(fileUri, fullRange, afterText);
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      throw new Error(`DiffService: workspace.applyEdit rejected the edit for ${realPath}`);
    }
  }

  public dispose(): void {
    this._snapshots.clear();
    this._onDidChangeEmitter.dispose();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Reject oversized patches early — defense-in-depth regardless of call site. */
  private _checkPatchSize(patch: string): void {
    const bytes = Buffer.byteLength(patch, 'utf8');
    if (bytes > MAX_PATCH_BYTES) {
      throw new Error(
        `DiffService: patch exceeds maximum allowed size (${bytes} > ${MAX_PATCH_BYTES} bytes)`,
      );
    }
  }

  /**
   * Parse the patch, validate a single target file, resolve symlinks, validate
   * the real path is within a workspace folder, and read the file.
   * Returns the validated real path for all subsequent I/O.
   */
  private async _resolve(
    patch: string,
    cwd: string,
  ): Promise<{
    filePath: string;
    realPath: string;
    beforeText: string;
    afterText: string;
    isNewFile: boolean;
    isDeletion: boolean;
    fileExisted: boolean;
  }> {
    const files = extractAllFilePaths(patch);

    if (files.length === 0)
      throw new Error('DiffService: could not extract file path from patch header');
    if (files.length > 1)
      throw new Error(
        `DiffService: multi-file patches are not supported (found ${files.length} targets: ` +
        files.map((f) => f.filePath).join(', ') + ')',
      );

    const { filePath, isNewFile, isDeletion } = files[0];
    const joined     = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const normalised = path.normalize(joined);

    const realPath = await this._realPathForValidation(normalised, isNewFile || isDeletion);
    await this._validateWithinWorkspace(realPath, filePath);

    if (isDeletion) {
      return { filePath, realPath, beforeText: '', afterText: '', isNewFile, isDeletion, fileExisted: false };
    }

    let beforeText = '';
    let fileExisted = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(realPath));
      beforeText = Buffer.from(bytes).toString('utf8');
      fileExisted = true;
    } catch {
      fileExisted = false;
    }

    const afterText = (fileExisted || isNewFile) ? applyUnifiedPatch(beforeText, patch) : '';
    return { filePath, realPath, beforeText, afterText, isNewFile, isDeletion, fileExisted };
  }

  /**
   * Resolve symlinks for workspace-boundary validation.
   *
   * - If the path exists: return its realpath.
   * - If the path does not exist and `allowMissingFile` is true (new-file or deletion
   *   patch): realpath the parent directory and reattach the filename. If the parent
   *   does not exist, reject — an unresolvable parent cannot be safely validated, and
   *   allowing fallback would permit symlink-swap attacks on directory creation.
   * - Otherwise: reject.
   */
  private async _realPathForValidation(absolutePath: string, allowMissingFile: boolean): Promise<string> {
    try {
      return await fs.promises.realpath(absolutePath);
    } catch {
      if (!allowMissingFile) {
        throw new Error(
          `DiffService: target file does not exist: ${absolutePath}`,
        );
      }
      const parent = path.dirname(absolutePath);
      let parentReal: string;
      try {
        parentReal = await fs.promises.realpath(parent);
      } catch {
        throw new Error(
          `DiffService: parent directory does not exist or cannot be resolved: ${parent}. ` +
          'Create the directory first.',
        );
      }
      return path.join(parentReal, path.basename(absolutePath));
    }
  }

  /**
   * Re-realpath a previously validated path and re-check it is still inside the
   * workspace. Called immediately before each file I/O to close the TOCTOU window:
   * if the path has been replaced by a symlink pointing outside the workspace since
   * `_resolve` ran, this throws and the operation is aborted.
   */
  private async _reRealpathAndValidate(previousRealPath: string): Promise<string> {
    let freshReal: string;
    try {
      freshReal = await fs.promises.realpath(previousRealPath);
    } catch {
      throw new Error(
        `DiffService: path no longer resolvable before I/O — aborting: ${previousRealPath}`,
      );
    }
    await this._validateWithinWorkspace(freshReal, previousRealPath);
    return freshReal;
  }

  /**
   * Throw if `realPath` is not inside any known VS Code workspace folder.
   * Uses `path.relative()` for containment (avoids startsWith edge cases on Windows).
   * Workspace folder paths are also realpath-resolved for comparison.
   */
  private async _validateWithinWorkspace(
    realPath: string,
    displayPath: string,
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('DiffService: no workspace folder open; cannot validate path');
    }

    const normaliseCase = (p: string): string =>
      process.platform === 'win32' ? p.toLowerCase() : p;
    const candidate = normaliseCase(realPath);

    for (const folder of folders) {
      let folderReal: string;
      try {
        folderReal = await fs.promises.realpath(folder.uri.fsPath);
      } catch {
        folderReal = path.normalize(folder.uri.fsPath);
      }
      folderReal = normaliseCase(folderReal);

      const rel = path.relative(folderReal, candidate);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
    }

    throw new Error(
      `DiffService: resolved path is outside all workspace folders: ${displayPath}`,
    );
  }

  /** Store a snapshot, evicting the oldest entry when the LRU cap is exceeded. */
  private _storeSnapshot(key: string, snapshot: Snapshot): void {
    if (this._snapshots.has(key)) this._snapshots.delete(key);
    this._snapshots.set(key, snapshot);
    while (this._snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this._snapshots.keys().next().value;
      if (oldest !== undefined) this._snapshots.delete(oldest);
    }
  }

  private _languageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const MAP: Record<string, string> = {
      '.ts': 'typescript',    '.tsx': 'typescriptreact',
      '.js': 'javascript',    '.jsx': 'javascriptreact',
      '.json': 'json',        '.md': 'markdown',
      '.py': 'python',        '.rs': 'rust',
      '.go': 'go',            '.rb': 'ruby',
      '.java': 'java',        '.c': 'c',
      '.cpp': 'cpp',          '.h': 'c',
      '.css': 'css',          '.scss': 'scss',
      '.html': 'html',        '.xml': 'xml',
      '.yaml': 'yaml',        '.yml': 'yaml',
      '.sh': 'shellscript',   '.toml': 'toml',
    };
    return MAP[ext] ?? 'plaintext';
  }
}
