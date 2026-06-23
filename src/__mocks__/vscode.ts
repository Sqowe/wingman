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

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => {},
    dispose: () => {},
  }),
  showErrorMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
  showWarningMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
  showInformationMessage: (_msg: string, ..._args: string[]) => Promise.resolve(undefined),
};

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
  }),
  workspaceFolders: undefined as undefined,
  onDidChangeWorkspaceFolders: (_handler: () => void) => new Disposable(() => {}),
};

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
  executeCommand: (_id: string, ..._args: unknown[]) => Promise.resolve(undefined),
};
