/**
 * Minimal vscode module mock for unit tests.
 * Only the surfaces used by the tested code are stubbed.
 */

export class Disposable {
  constructor(private readonly _fn: () => void) {}
  dispose() { this._fn(); }
  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }
}

export class EventEmitter<T> {
  private _listeners: Array<(e: T) => void> = [];
  public event = (listener: (e: T) => void): Disposable => {
    this._listeners.push(listener);
    return new Disposable(() => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    });
  };
  fire(data: T): void {
    for (const l of [...this._listeners]) l(data);
  }
  dispose(): void {
    this._listeners = [];
  }
}

export const ProgressLocation = {
  Notification: 15,
  Window: 10,
  SourceControl: 1,
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => {},
    dispose: () => {},
  }),
  showErrorMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
  showWarningMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
  showInformationMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
  withProgress: (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
    task({ report: () => {} }, undefined),
};

/** Backs `workspace.onDidChangeWorkspaceFolders` so tests can fire folder changes. */
const _workspaceFoldersEmitter = new EventEmitter<{
  added: readonly unknown[];
  removed: readonly unknown[];
}>();

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
  }),
  // Settable from tests: assign an array of `{ uri: { fsPath }, name }` folders.
  workspaceFolders: undefined as
    | readonly { uri: { fsPath: string }; name?: string }[]
    | undefined,
  onDidChangeWorkspaceFolders: (
    handler: (e: { added: readonly unknown[]; removed: readonly unknown[] }) => void,
  ): Disposable => _workspaceFoldersEmitter.event(handler),
};

/**
 * Test helper: fire `onDidChangeWorkspaceFolders` with the given added/removed
 * folders (each defaults to an empty array).
 */
export function __fireWorkspaceFoldersChanged(e: {
  added?: readonly unknown[];
  removed?: readonly unknown[];
}): void {
  _workspaceFoldersEmitter.fire({ added: e.added ?? [], removed: e.removed ?? [] });
}

/** Test helper: reset workspace mock state (call in `beforeEach`). */
export function __resetWorkspace(): void {
  workspace.workspaceFolders = undefined;
  _workspaceFoldersEmitter.dispose();
}

export const env = {
  openExternal: (_uri: unknown) => Promise.resolve(true),
  clipboard: {
    writeText: (_text: string) => Promise.resolve(),
    readText: () => Promise.resolve(''),
  },
};

export const Uri = {
  parse: (str: string) => ({ toString: () => str }),
  joinPath: (_base: unknown, ..._parts: string[]) => ({}),
};

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => new Disposable(() => {}),
  // Returns a resolved Promise to match VS Code's real Thenable return type.
  // Production code using `void executeCommand(...)` is unaffected; tests that
  // spy on this function get consistent, predictable behaviour.
  executeCommand: (_id: string, ..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
};
