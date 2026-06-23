/**
 * AgentController — owns the session lifecycle for one workspace folder.
 *
 * Phase 1 additions vs scaffold:
 *  - Holds a single RpcTransport; disposes it cleanly on restart or deactivation.
 *  - Guards concurrent start() calls with an in-flight promise (_starting).
 *  - Creates and owns a VS Code OutputChannel for transport diagnostics.
 *  - Retries start when a workspace folder becomes available.
 */

import * as vscode from 'vscode';
import { RpcTransport } from './rpc-transport';
import type { AgentTransport, RpcEvent } from './transport';
import type { WingmanViewProvider } from '../webview/provider';
import type { PiStatus } from '../shared/messages';

export class AgentController implements vscode.Disposable {
  private _transport: AgentTransport | undefined;
  private _eventDisposable: vscode.Disposable | undefined;
  private _closeDisposable: vscode.Disposable | undefined;
  private _folderWatcher: vscode.Disposable | undefined;
  private _provider: WingmanViewProvider | undefined;
  private _piStatus: PiStatus | undefined;
  /** True while pi is mid-turn (between agent_start and agent_end). */
  private _isStreaming = false;
  /** In-flight start promise — prevents concurrent spawns. */
  private _starting: Promise<void> | undefined;
  private _disposed = false;
  /** Incremented on every _doStart call; used to detect stale completions. */
  private _startSeq = 0;
  /** Owned output channel — disposed with the controller. */
  private readonly _outputChannel: vscode.OutputChannel;

  constructor() {
    this._outputChannel = vscode.window.createOutputChannel('Sqowe Wingman');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** The shared diagnostics channel (also used by the pi locator at startup). */
  public get outputChannel(): vscode.OutputChannel {
    return this._outputChannel;
  }

  /**
   * True while pi is processing a turn. A prompt sent now would be rejected by
   * pi unless it carries a streamingBehavior, so callers should gate on this
   * (Phase 2 will add steer / follow-up queueing instead of plain rejection).
   */
  public get isStreaming(): boolean {
    return this._isStreaming;
  }

  public setProvider(provider: WingmanViewProvider): void {
    this._provider = provider;
  }

  /**
   * Start the transport using the resolved pi status.
   * Concurrent calls share the same in-flight promise — only one pi process
   * is ever spawned at a time.
   */
  public start(piStatus: PiStatus): Promise<void> {
    this._piStatus = piStatus;

    if (this._disposed) return Promise.resolve();

    if (piStatus.kind === 'not-found') {
      // Stop any previously running transport — pi is no longer available.
      this._tearDownTransport();
      return Promise.resolve();
    }

    if (this._transport?.isRunning) return Promise.resolve();
    if (this._starting) return this._starting;

    this._starting = this._doStart(piStatus).finally(() => {
      this._starting = undefined;
    });

    return this._starting;
  }

  /**
   * Send an abort command to pi (stops the current turn).
   * Silently no-ops when the transport is not running.
   *
   * `isRunning` is defined on the `AgentTransport` interface (transport.ts) and
   * accurately reflects whether the underlying process is alive and ready to
   * accept commands. Abort during transport startup (before isRunning = true)
   * is intentionally a no-op — pi has not yet accepted any prompt to abort.
   */
  public async sendAbort(): Promise<void> {
    if (!this._transport?.isRunning) {
      this._outputChannel.appendLine('[AgentController] sendAbort: transport not running, ignoring');
      return;
    }
    try {
      await this._transport.send({ type: 'abort' });
    } catch (err) {
      this._outputChannel.appendLine(`[AgentController] sendAbort failed: ${String(err)}`);
    }
  }

  /**
   * Send a prompt string to pi.
   * If the transport is not yet running, attempts a late start first.
   */
  public async sendPrompt(text: string): Promise<void> {
    if (!this._transport?.isRunning) {
      if (this._piStatus && this._piStatus.kind !== 'not-found') {
        await this.start(this._piStatus);
      }
      if (!this._transport?.isRunning) {
        throw new Error('Sqowe Wingman: agent transport is not running');
      }
    }

    const response = await this._transport.send({
      type: 'prompt',
      message: text,
    });

    if (!response.success) {
      throw new Error(
        `Sqowe Wingman: prompt rejected — ${response.error ?? 'unknown error'}`,
      );
    }
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._folderWatcher?.dispose();
    this._folderWatcher = undefined;
    this._tearDownTransport();
    this._outputChannel.dispose();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async _doStart(
    piStatus: PiStatus & { kind: 'found' | 'version-warning' },
  ): Promise<void> {
    if (this._disposed) return;

    const seq = ++this._startSeq;
    const cwd = this._resolveCwd();

    if (!cwd) {
      this._watchForWorkspaceFolder(piStatus);
      return;
    }

    this._tearDownTransport();

    const transport = new RpcTransport(piStatus.path, cwd);
    transport.outputChannel = this._outputChannel;

    try {
      await transport.start();
    } catch (err) {
      transport.dispose();
      // Only surface the error if we're still the current start and not disposed.
      if (!this._disposed && seq === this._startSeq) {
        void vscode.window.showErrorMessage(
          `Sqowe Wingman: failed to start pi — ${String(err)}`,
        );
      }
      return;
    }

    // If the controller was disposed or a newer start superseded us, discard
    // this transport to prevent leaking a child process.
    if (this._disposed || seq !== this._startSeq) {
      transport.dispose();
      return;
    }

    this._transport = transport;
    this._isStreaming = false;
    this._eventDisposable = transport.onEvent((event: RpcEvent) => {
      this._trackStreaming(event);
      this._provider?.postAgentEvent(event);
    });
    this._closeDisposable = transport.onClose(({ reason }) => {
      this._handleTransportClose(transport, reason);
    });

    // Tell the webview the agent is live (clears any prior "pi exited" notice).
    this._provider?.postAgentStatus({ running: true, cwd });
  }

  /** Tracks pi's turn lifecycle so callers can tell when a prompt would be rejected. */
  private _trackStreaming(event: RpcEvent): void {
    if (event.type === 'agent_start') {
      this._isStreaming = true;
    } else if (event.type === 'agent_end') {
      this._isStreaming = false;
    }
  }

  /**
   * Handles an *unexpected* transport death (pi crashed/exited). Surfaces it to
   * the webview instead of letting the UI appear to silently hang. A later
   * sendPrompt will respawn pi via the late-start path.
   */
  private _handleTransportClose(transport: AgentTransport, reason: string): void {
    // Ignore if a newer transport has already replaced this one.
    if (transport !== this._transport) return;
    this._isStreaming = false;
    this._provider?.postAgentStatus({ running: false, reason });
  }

  /**
   * Watch for workspace folders being added. When one appears, retry start()
   * automatically so the user doesn't have to reload after opening a folder.
   */
  private _watchForWorkspaceFolder(piStatus: PiStatus): void {
    if (this._folderWatcher) return; // already watching

    this._folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this._resolveCwd()) {
        this._folderWatcher?.dispose();
        this._folderWatcher = undefined;
        void this.start(piStatus);
      }
    });
  }

  /** Disposes the active transport and its subscriptions together. */
  private _tearDownTransport(): void {
    this._eventDisposable?.dispose();
    this._eventDisposable = undefined;
    this._closeDisposable?.dispose();
    this._closeDisposable = undefined;
    this._isStreaming = false;
    this._transport?.dispose();
    this._transport = undefined;
  }

  private _resolveCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    // Phase 1: use the first folder. Multi-root support comes in Phase 8.
    return folders[0].uri.fsPath;
  }
}
