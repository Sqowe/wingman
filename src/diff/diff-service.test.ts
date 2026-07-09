/**
 * Unit tests for DiffService:
 *  - applyUnifiedPatch: pure function
 *  - invertPatch: pure function (after → before reconstruction)
 *  - previewDiff: reconstructs "before" from the current on-disk "after"
 *    (pi's edit tool has already written the file)
 *  - DiffService workspace-boundary validation (symlink-resolved paths)
 *  - Multi-file patch rejection
 *  - Deletion patch rejection in preview
 *  - Timestamp stripping in patch headers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyUnifiedPatch, invertPatch, DiffService } from './diff-service';

// ─── applyUnifiedPatch pure-function tests ────────────────────────────────────

describe('applyUnifiedPatch', () => {
  it('applies a simple single-line replacement', () => {
    const original = 'hello world\n';
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,1 @@',
      '-hello world',
      '+hello TypeScript',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe('hello TypeScript\n');
  });

  it('applies multiple hunks correctly', () => {
    const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      '-line1',
      '+LINE1',
      ' line2',
      '@@ -4,2 +4,2 @@',
      ' line4',
      '-line5',
      '+LINE5',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe(
      ['LINE1', 'line2', 'line3', 'line4', 'LINE5'].join('\n'),
    );
  });

  it('handles new-file patch (empty original)', () => {
    const original = '';
    const patch = [
      '--- /dev/null',
      '+++ b/new-file.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n');
    // empty string splits to [''], so a trailing empty element is preserved
    expect(applyUnifiedPatch(original, patch)).toBe('line one\nline two\nline three\n');
  });

  it('handles CRLF input (normalises to LF)', () => {
    const original = 'hello world\r\n';
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,1 @@',
      '-hello world',
      '+goodbye world',
    ].join('\r\n');
    expect(applyUnifiedPatch(original, patch)).toBe('goodbye world\n');
  });

  it('handles context lines unchanged', () => {
    const original = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -2,3 +2,3 @@',
      ' b', '-c', '+C', ' d',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe(['a', 'b', 'C', 'd', 'e'].join('\n'));
  });

  it('handles addition-only hunk', () => {
    const original = ['a', 'b'].join('\n');
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,3 @@',
      ' a', '+inserted1', '+inserted2',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe(
      ['a', 'inserted1', 'inserted2', 'b'].join('\n'),
    );
  });

  it('handles deletion-only hunk', () => {
    const original = ['a', 'b', 'c'].join('\n');
    const patch = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -2,1 +2,0 @@',
      '-b',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe(['a', 'c'].join('\n'));
  });

  it('strips timestamps from patch headers', () => {
    const original = 'x\n';
    const patch = [
      '--- a/file.ts\t2024-01-01 00:00:00.000000000 +0000',
      '+++ b/file.ts\t2024-01-02 00:00:00.000000000 +0000',
      '@@ -1,1 +1,1 @@',
      '-x', '+y',
    ].join('\n');
    expect(applyUnifiedPatch(original, patch)).toBe('y\n');
  });

  it('throws on context line mismatch', () => {
    const original = 'actual line\n';
    const patch = [
      '--- a/file.ts', '+++ b/file.ts', '@@ -1,1 +1,1 @@', ' wrong context',
    ].join('\n');
    expect(() => applyUnifiedPatch(original, patch)).toThrow(/context mismatch/);
  });

  it('throws on deletion line mismatch', () => {
    const original = 'actual line\n';
    const patch = [
      '--- a/file.ts', '+++ b/file.ts', '@@ -1,1 +1,0 @@', '-wrong deletion',
    ].join('\n');
    expect(() => applyUnifiedPatch(original, patch)).toThrow(/deletion mismatch/);
  });

  it('throws when deletion is beyond end of file', () => {
    const original = 'only one line';
    const patch = [
      '--- a/file.ts', '+++ b/file.ts', '@@ -1,2 +1,1 @@',
      ' only one line', '-ghost line',
    ].join('\n');
    expect(() => applyUnifiedPatch(original, patch)).toThrow(/beyond end of file/);
  });

  it('throws on malformed hunk header', () => {
    expect(() => applyUnifiedPatch('line\n', '--- a/f\n+++ b/f\n@@ bad @@\n-line\n')).toThrow(
      /malformed hunk header/,
    );
  });

  it('throws when hunk start is beyond end of file', () => {
    const patch = [
      '--- a/file.ts', '+++ b/file.ts', '@@ -10,1 +10,1 @@', '-line1', '+line2',
    ].join('\n');
    expect(() => applyUnifiedPatch('line1\n', patch)).toThrow(/beyond end of file/);
  });

  it('throws on hunk origCount mismatch', () => {
    const original = ['a', 'b', 'c'].join('\n');
    const patch = [
      '--- a/file.ts', '+++ b/file.ts', '@@ -1,3 +1,2 @@', ' a', '-b',
    ].join('\n');
    expect(() => applyUnifiedPatch(original, patch)).toThrow(/hunk consumed/);
  });
});

// ─── invertPatch pure-function tests ──────────────────────────────────────────

describe('invertPatch', () => {
  it('swaps +/- lines and the hunk ranges', () => {
    const patch = [
      '--- a/file.ts', '+++ b/file.ts',
      '@@ -1,1 +1,1 @@', '-const x = 1;', '+const x = 2;',
    ].join('\n');
    expect(invertPatch(patch)).toBe([
      '--- a/file.ts', '+++ b/file.ts',
      '@@ -1,1 +1,1 @@', '+const x = 1;', '-const x = 2;',
    ].join('\n'));
  });

  it('leaves file headers and context lines untouched', () => {
    const patch = [
      '--- a/file.ts', '+++ b/file.ts',
      '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
    ].join('\n');
    expect(invertPatch(patch)).toBe([
      '--- a/file.ts', '+++ b/file.ts',
      '@@ -1,3 +1,3 @@', ' a', '+b', '-B', ' c',
    ].join('\n'));
  });

  it('is an involution — applying the after→before patch reproduces the before', () => {
    const before = ['a', 'b', 'c'].join('\n');
    const patch = [
      '--- a/f', '+++ b/f', '@@ -2,1 +2,1 @@', '-b', '+B',
    ].join('\n');
    const after = applyUnifiedPatch(before, patch);            // a,B,c
    expect(applyUnifiedPatch(after, invertPatch(patch))).toBe(before);
  });

  it('reconstructs an empty "before" for an all-addition (new-file) patch', () => {
    const after = 'export const y = 42;\n';
    const patch = [
      '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+export const y = 42;',
    ].join('\n');
    expect(applyUnifiedPatch(after, invertPatch(patch))).toBe('');
  });
});

// ─── DiffService integration tests ───────────────────────────────────────────

vi.mock('vscode', async () => {
  const base = await vi.importActual<typeof import('../__mocks__/vscode')>('../__mocks__/vscode');

  class EventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  }

  class Position {
    constructor(public readonly line: number, public readonly character: number) {}
  }

  class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
  }

  class Uri {
    scheme: string; fsPath: string; path: string;
    private constructor(scheme: string, p: string) {
      this.scheme = scheme; this.fsPath = p; this.path = p;
    }
    static file(p: string) { return new Uri('file', p); }
    static from(c: { scheme: string; path: string }) { return new Uri(c.scheme, c.path); }
    toString() { return `${this.scheme}:${this.path}`; }
  }

  class WorkspaceEdit {
    readonly _creates: Array<{ uri: unknown; opts: unknown }> = [];
    readonly _inserts: Array<{ uri: unknown; pos: unknown; text: string }> = [];
    readonly _replaces: Array<{ uri: unknown; range: unknown; text: string }> = [];
    createFile(uri: unknown, opts: unknown) { this._creates.push({ uri, opts }); }
    insert(uri: unknown, pos: unknown, text: string) { this._inserts.push({ uri, pos, text }); }
    replace(uri: unknown, range: unknown, text: string) { this._replaces.push({ uri, range, text }); }
  }

  return {
    ...base,
    EventEmitter, Position, Range, Uri, WorkspaceEdit,
    languages: { setTextDocumentLanguage: vi.fn().mockResolvedValue(undefined) },
    commands: { ...base.commands, executeCommand: vi.fn().mockResolvedValue(undefined) },
    workspace: {
      ...base.workspace,
      fs: { readFile: vi.fn() },
      openTextDocument: vi.fn(),
      applyEdit: vi.fn(),
      workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string } }>,
    },
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, promises: { ...actual.promises, realpath: vi.fn() } };
});

import * as vscode from 'vscode';
import * as fs from 'fs';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function setWorkspaceFolders(folders: string[]) {
  // @ts-expect-error mutating mock
  vscode.workspace.workspaceFolders = folders.map((f) => ({ uri: { fsPath: f } }));
}
function clearWorkspaceFolders() {
  // @ts-expect-error mutating mock
  vscode.workspace.workspaceFolders = undefined;
}
function realpathIdentity() {
  vi.mocked(fs.promises.realpath).mockImplementation((p) => Promise.resolve(p as string));
}

const WORKSPACE = '/home/user/project';

const SIMPLE_PATCH = [
  '--- a/src/foo.ts', '+++ b/src/foo.ts',
  '@@ -1,1 +1,1 @@', '-const x = 1;', '+const x = 2;',
].join('\n');

const MULTI_FILE_PATCH = [
  '--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -1,1 +1,1 @@', '-const x = 1;', '+const x = 2;',
  '--- a/src/bar.ts', '+++ b/src/bar.ts', '@@ -1,1 +1,1 @@', '-const y = 1;', '+const y = 2;',
].join('\n');

const DELETION_PATCH = [
  '--- a/src/old.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-const old = true;',
].join('\n');

const NEW_FILE_PATCH = [
  '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+export const y = 42;',
].join('\n');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DiffService', () => {
  let service: DiffService;

  beforeEach(() => {
    service = new DiffService();
    setWorkspaceFolders([WORKSPACE]);
    realpathIdentity();

    // pi's edit tool has already written the file, so the on-disk content is
    // the "after". SIMPLE_PATCH turns `const x = 1;` into `const x = 2;`.
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      Buffer.from('const x = 2;') as unknown as Uint8Array,
    );
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      lineCount: 1,
      lineAt: (_: number) => ({
        rangeIncludingLineBreak: { end: { line: 0, character: 12 } },
      }),
    } as unknown as vscode.TextDocument);
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
  });

  afterEach(() => {
    service.dispose();
    clearWorkspaceFolders();
    vi.clearAllMocks();
  });

  describe('previewDiff', () => {
    it('calls vscode.diff with wingman-diff: URIs', async () => {
      await service.previewDiff(SIMPLE_PATCH, WORKSPACE);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ scheme: 'wingman-diff' }),
        expect.objectContaining({ scheme: 'wingman-diff' }),
        expect.stringContaining('foo.ts'),
        expect.any(Object),
      );
    });

    it('returns before text from provideTextDocumentContent', async () => {
      await service.previewDiff(SIMPLE_PATCH, WORKSPACE);
      expect(service.provideTextDocumentContent({ path: '/before/src/foo.ts' } as vscode.Uri))
        .toBe('const x = 1;');
    });

    it('returns after text from provideTextDocumentContent', async () => {
      await service.previewDiff(SIMPLE_PATCH, WORKSPACE);
      expect(service.provideTextDocumentContent({ path: '/after/src/foo.ts' } as vscode.Uri))
        .toBe('const x = 2;');
    });

    it('reads the file using the validated real path, not a re-joined path', async () => {
      await service.previewDiff(SIMPLE_PATCH, WORKSPACE);
      const readArg = vi.mocked(vscode.workspace.fs.readFile).mock.calls[0][0] as { fsPath: string };
      expect(readArg.fsPath).toBe(`${WORKSPACE}/src/foo.ts`);
    });

    it('rejects patch exceeding MAX_PATCH_BYTES', async () => {
      const hugePatch = 'x'.repeat(1_048_577);
      await expect(service.previewDiff(hugePatch, WORKSPACE)).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    it('rejects new-file patch when parent directory does not exist', async () => {
      vi.mocked(fs.promises.realpath).mockRejectedValue(new Error('ENOENT'));
      await expect(service.previewDiff(NEW_FILE_PATCH, WORKSPACE)).rejects.toThrow(
        /parent directory does not exist/,
      );
    });

    it('rejects new-file patch when parent resolves outside workspace', async () => {
      vi.mocked(fs.promises.realpath).mockImplementation((p) => {
        const ps = p as string;
        if (ps === `${WORKSPACE}/src/new.ts`) return Promise.reject(new Error('ENOENT'));
        if (ps === `${WORKSPACE}/src`) return Promise.resolve('/etc');
        return Promise.resolve(ps);
      });
      await expect(service.previewDiff(NEW_FILE_PATCH, WORKSPACE)).rejects.toThrow(
        /outside all workspace folders/,
      );
    });

    it('throws a clear error when the file changed after pi applied the edit', async () => {
      // Disk no longer contains the patch's "after" side, so the before cannot
      // be reconstructed by inverting the patch.
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
        Buffer.from('const x = 999;') as unknown as Uint8Array,
      );
      await expect(service.previewDiff(SIMPLE_PATCH, WORKSPACE)).rejects.toThrow(
        /cannot reconstruct the pre-edit content/,
      );
    });

    it('throws when no workspace folder is open (previewDiff)', async () => {
      clearWorkspaceFolders();
      await expect(service.previewDiff(SIMPLE_PATCH, WORKSPACE)).rejects.toThrow(
        /no workspace folder/,
      );
    });

    it('throws when resolved path is outside workspace (path traversal)', async () => {
      const outsidePatch = [
        '--- a/../../etc/passwd', '+++ b/../../etc/passwd',
        '@@ -1,1 +1,1 @@', '-root:x:0:0', '+evil',
      ].join('\n');
      await expect(service.previewDiff(outsidePatch, WORKSPACE)).rejects.toThrow(
        /outside all workspace folders/,
      );
    });

    it('rejects deletion patches with a clear message', async () => {
      await expect(service.previewDiff(DELETION_PATCH, WORKSPACE)).rejects.toThrow(
        /file-deletion patches cannot be previewed/,
      );
    });

    it('rejects multi-file patches', async () => {
      await expect(service.previewDiff(MULTI_FILE_PATCH, WORKSPACE)).rejects.toThrow(
        /multi-file patches are not supported/,
      );
    });

    it('shows the created content as "after" and an empty "before" for a new-file patch', async () => {
      // pi created the file, so it exists on disk with the full new content.
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
        Buffer.from('export const y = 42;\n') as unknown as Uint8Array,
      );
      await service.previewDiff(NEW_FILE_PATCH, WORKSPACE);
      expect(service.provideTextDocumentContent({ path: '/after/src/new.ts' } as vscode.Uri))
        .toBe('export const y = 42;\n');
      expect(service.provideTextDocumentContent({ path: '/before/src/new.ts' } as vscode.Uri))
        .toBe('');
    });

    it('rejects symlink traversal outside workspace', async () => {
      vi.mocked(fs.promises.realpath).mockImplementation((p) => {
        const ps = p as string;
        if (ps.includes('src/foo.ts')) return Promise.resolve('/etc/passwd');
        return Promise.resolve(ps);
      });
      await expect(service.previewDiff(SIMPLE_PATCH, WORKSPACE)).rejects.toThrow(
        /outside all workspace folders/,
      );
    });

    it('uses the realpath (not the normalised path) for readFile', async () => {
      const realResolved = `${WORKSPACE}/src/foo.ts`;
      vi.mocked(fs.promises.realpath).mockImplementation((p) =>
        Promise.resolve(p === realResolved ? realResolved : (p as string)),
      );
      await service.previewDiff(SIMPLE_PATCH, WORKSPACE);
      const readArg = vi.mocked(vscode.workspace.fs.readFile).mock.calls[0][0] as { fsPath: string };
      expect(readArg.fsPath).toBe(realResolved);
    });
  });

  describe('previewDiff — missing-file policy', () => {
    it('throws when the target file is missing and the patch is not a new-file patch', async () => {
      vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('not found'));
      await expect(service.previewDiff(SIMPLE_PATCH, WORKSPACE)).rejects.toThrow(
        /target file no longer exists/,
      );
    });
  });

  describe('provideTextDocumentContent', () => {
    it('returns empty string for unknown URI', () => {
      expect(service.provideTextDocumentContent({ path: '/before/does-not-exist.ts' } as vscode.Uri))
        .toBe('');
    });
  });
});
