/**
 * DiffService — wires pi's `edit` tool patches into VS Code's native diff editor.
 *
 * One public operation:
 *  - previewDiff(patch, cwd)  — opens VS Code's diff editor (before ↔ after, read-only)
 *
 * pi's `edit` tool has *already written the file to disk* by the time we receive
 * `details.patch` — the patch is a record of `baseContent → newContent`, not
 * pending work. So the file on disk is the "after". We reconstruct the "before"
 * by inverting the patch and applying it to the current file (see `invertPatch`).
 * There is deliberately no apply step: the change is already on disk.
 *
 * Implements TextDocumentContentProvider for the `wingman-diff:` scheme.
 *
 * Security design:
 *  - `cwd` MUST be derived from `vscode.workspace.workspaceFolders` (never webview input).
 *  - `_resolve` resolves symlinks via `fs.promises.realpath` and validates the real path
 *    against workspace folder real paths.
 *  - For new-file patches, the parent directory must already exist and be realpath-resolved;
 *    a non-existent parent is rejected to prevent post-validation symlink-swap on creation.
 *  - The only real-file I/O is a single read inside `_resolve`, performed after the path is
 *    realpath-resolved and validated against the workspace boundary. previewDiff itself is
 *    read-only (it renders virtual `wingman-diff:` documents), so there is no write to guard.
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

/**
 * Invert a unified diff so it transforms `after → before` instead of
 * `before → after`. Used to reconstruct the pre-edit content from the current
 * on-disk file, since pi's `edit` tool has already written the "after".
 *
 * Per hunk: swap the two `@@` ranges, and swap `+`/`-` line prefixes (context
 * ` ` and the `\ No newline` marker are unchanged). Non-hunk lines (headers,
 * `---`/`+++`, blanks) are passed through untouched.
 */
export function invertPatch(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const hunk = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      const [, oStart, oCount = '', nStart, nCount = '', rest] = hunk;
      // after → before: the new side becomes the original side.
      out.push(`@@ -${nStart}${nCount} +${oStart}${oCount} @@${rest}`);
      continue;
    }
    // Leave file headers (`--- a/path`, `+++ b/path`) untouched — only hunk
    // body lines carry the +/- content that must be swapped.
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      out.push(line);
      continue;
    }
    const prefix = line.charAt(0);
    if (prefix === '+') out.push('-' + line.slice(1));
    else if (prefix === '-') out.push('+' + line.slice(1));
    else out.push(line);
  }

  return out.join('\n');
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

    const { filePath, realPath, currentText, isNewFile, fileExisted } = resolved;

    if (!isNewFile && !fileExisted) {
      throw new Error(`DiffService: target file no longer exists: ${realPath}`);
    }

    // pi's `edit` tool has already written the file, so the current on-disk
    // content is the "after". Reconstruct the "before" by inverting the patch
    // and applying it to the current content. If the file was changed after
    // pi's edit, the invert-apply mismatches and this throws (surfaced as an
    // inline banner) rather than showing a bogus diff.
    const afterText = currentText;
    let beforeText: string;
    try {
      beforeText = applyUnifiedPatch(currentText, invertPatch(patch));
    } catch (err) {
      throw new Error(
        'DiffService: cannot reconstruct the pre-edit content — the file appears to have ' +
        `changed since pi applied this edit. ${String(err)}`,
      );
    }

    const language = this._languageId(filePath);
    const label    = path.basename(realPath);

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
   * the real path is within a workspace folder, and read the current file.
   * `currentText` is the on-disk content (the "after", since pi already wrote).
   */
  private async _resolve(
    patch: string,
    cwd: string,
  ): Promise<{
    filePath: string;
    realPath: string;
    currentText: string;
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
      return { filePath, realPath, currentText: '', isNewFile, isDeletion, fileExisted: false };
    }

    let currentText = '';
    let fileExisted = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(realPath));
      currentText = Buffer.from(bytes).toString('utf8');
      fileExisted = true;
    } catch {
      fileExisted = false;
    }

    return { filePath, realPath, currentText, isNewFile, isDeletion, fileExisted };
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
