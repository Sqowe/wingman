/**
 * export-html — Sqowe Wingman: Export Session as HTML command.
 * Calls pi's `export_html` RPC command and opens the resulting file.
 *
 * Security: the file path returned by pi is validated before opening:
 *  - Must be absolute.
 *  - Extension must be .html or .htm (checked before AND after realpath).
 *  - Resolved via realpath (no symlink escapes).
 *  - Must exist and be a regular file.
 *  - Paths outside every workspace folder require explicit user confirmation.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { AgentController } from '../agent/controller';

export async function exportHtml(controller: AgentController): Promise<void> {
  let response;
  try {
    response = await controller.sendCommand({ type: 'export_html' });
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: export failed — ${String(err)}`);
    return;
  }

  if (!response.success) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: export failed — ${response.error ?? 'unknown error'}`,
    );
    return;
  }

  const data = (typeof response.data === 'object' && response.data !== null)
    ? response.data as Record<string, unknown>
    : {};
  // Tolerate various key names pi may use for the output path.
  const rawPath = (
    typeof data['path'] === 'string' ? data['path'] :
    typeof data['filePath'] === 'string' ? data['filePath'] :
    typeof data['file_path'] === 'string' ? data['file_path'] :
    typeof data['output_path'] === 'string' ? data['output_path'] :
    undefined
  );

  if (!rawPath) {
    void vscode.window.showInformationMessage('Sqowe Wingman: session exported.');
    return;
  }

  // 1. Must be absolute.
  if (!path.isAbsolute(rawPath)) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: export returned a relative path — refusing to open: ${rawPath}`,
    );
    return;
  }

  // 2. Pre-realpath extension check (fast-reject obvious non-HTML).
  const preExt = path.extname(rawPath).toLowerCase();
  if (preExt !== '.html' && preExt !== '.htm') {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: export returned an unexpected file type (${preExt || 'none'}) — refusing to open.`,
    );
    return;
  }

  // 3. Resolve symlinks, verify existence and type (async to avoid blocking the host thread).
  let realFilePath: string;
  try {
    realFilePath = await fs.realpath(rawPath);
    const stat = await fs.stat(realFilePath);
    if (!stat.isFile()) {
      throw new Error('not a regular file');
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: export file not accessible — ${String(err)}`,
    );
    return;
  }

  // 4. Post-realpath extension check (symlink named .html may resolve to something else).
  const postExt = path.extname(realFilePath).toLowerCase();
  if (postExt !== '.html' && postExt !== '.htm') {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: resolved path has an unexpected extension (${postExt || 'none'}) — refusing to open.`,
    );
    return;
  }

  // 5. Workspace boundary check: inside ANY workspace folder (multi-root safe).
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  let isInsideWorkspace = false;
  for (const folder of workspaceFolders) {
    try {
      const realWsRoot = await fs.realpath(folder.uri.fsPath);
      const rel = path.relative(realWsRoot, realFilePath);
      if (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) && rel !== '..') {
        isInsideWorkspace = true;
        break;
      }
    } catch {
      // If realpath on a folder fails, skip it.
    }
  }

  if (!isInsideWorkspace) {
    const choice = await vscode.window.showWarningMessage(
      `Sqowe Wingman: the exported file is outside the workspace:\n${realFilePath}\n\nOpen it?`,
      { modal: true },
      'Open',
    );
    if (choice !== 'Open') return;
  }

  const open = await vscode.window.showInformationMessage(
    `Sqowe Wingman: session exported to ${realFilePath}`,
    'Open File',
  );
  if (open === 'Open File') {
    // Use vscode.open to open in-editor; fall back to openExternal on failure.
    try {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(realFilePath));
    } catch {
      await vscode.env.openExternal(vscode.Uri.file(realFilePath));
    }
  }
}
