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
import type { PiStatus, PiCommand, SessionStats } from '../shared/messages';
import { UiProtocolBridge } from '../ui-protocol/bridge';

export class AgentController implements vscode.Disposable {
  private _transport: AgentTransport | undefined;
  private _eventDisposable: vscode.Disposable | undefined;
  private _closeDisposable: vscode.Disposable | undefined;
  private _folderWatcher: vscode.Disposable | undefined;
  private _provider: WingmanViewProvider | undefined;
  private _piStatus: PiStatus | undefined;
  /** True while pi is mid-turn (between agent_start and agent_end). */
  private _isStreaming = false;
  /** Most-recent session stats (updated after every agent_end). */
  private _lastSessionStats: SessionStats | null = null;
  /** True while a get_session_stats fetch is in flight — prevents races. */
  private _statsFetchSeq = 0;
  /** Cached list of user slash commands for the current session. */
  private _commands: PiCommand[] = [];
  /** In-flight getCommands promise — coalesces concurrent fetches into one RPC call. */
  private _commandsFetch: Promise<void> | undefined;
  /** In-flight start promise — prevents concurrent spawns. */
  private _starting: Promise<void> | undefined;
  private _disposed = false;
  /** Incremented on every _doStart call; used to detect stale completions. */
  private _startSeq = 0;
  /** Owned output channel — disposed with the controller. */
  private readonly _outputChannel: vscode.OutputChannel;
  /** Handles extension_ui_request events from pi. */
  private readonly _uiBridge: UiProtocolBridge;
  /** Fires when a session is created or branched (new / fork / clone) so the
   * sessions view can refresh without the user hitting Refresh manually. */
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
  public readonly onSessionsChanged: vscode.Event<void> = this._onSessionsChanged.event;

  constructor() {
    this._outputChannel = vscode.window.createOutputChannel('Sqowe Wingman');
    this._uiBridge = new UiProtocolBridge(this._outputChannel);
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

  /** The most recently fetched session statistics, or null before the first turn. */
  public get lastSessionStats(): SessionStats | null {
    return this._lastSessionStats;
  }

  /** The most recently fetched slash command list. */
  public get commands(): PiCommand[] {
    return this._commands;
  }

  public setProvider(provider: WingmanViewProvider): void {
    this._provider = provider;
    this._uiBridge.setProvider(provider);
  }

  /**
   * Send an arbitrary RPC command and return the response.
   * All command code must go through this — never touch the concrete transport.
   */
  public async sendCommand(command: import('./transport').RpcCommand): Promise<import('./transport').RpcResponse> {
    if (!this._transport?.isRunning) {
      throw new Error('Sqowe Wingman: agent transport is not running');
    }
    return this._transport.send(command);
  }

  /**
   * Fetch and cache the user slash command list from pi.
   * Pushes the result to the webview automatically.
   *
   * Concurrent callers (extension activation pre-warm + the webview `ready`
   * replay) share a single in-flight fetch so pi sees only one RPC round-trip.
   */
  public getCommands(): Promise<void> {
    if (this._commandsFetch) return this._commandsFetch;
    this._commandsFetch = this._doGetCommands().finally(() => {
      this._commandsFetch = undefined;
    });
    return this._commandsFetch;
  }

  private async _doGetCommands(): Promise<void> {
    if (!this._transport?.isRunning) return;
    try {
      const response = await this.sendCommand({ type: 'get_commands' });
      if (!response.success) {
        this._outputChannel.appendLine(
          `[AgentController] get_commands failed: ${response.error ?? 'unknown'}`,
        );
        return;
      }
      const data = response.data as { commands?: unknown[] } | null;
      const raw = Array.isArray(data?.commands) ? data!.commands : [];
      // Validate each entry — skip malformed ones defensively.
      const valid = raw.filter(
        (c): c is { name: string; description?: unknown } =>
          !!c && typeof c === 'object' && typeof (c as Record<string, unknown>)['name'] === 'string',
      );
      // Filter out built-in TUI commands that are inert over RPC.
      const BUILTIN_INERT = new Set([
        'settings', 'model', 'new', 'resume', 'fork', 'clone',
        'export', 'thinking', 'login', 'logout', 'compact',
      ]);
      const filtered: string[] = [];
      this._commands = valid
        .filter((c) => {
          const stripped = c.name.replace(/^\//, '');
          if (BUILTIN_INERT.has(stripped)) {
            filtered.push(c.name);
            return false;
          }
          return true;
        })
        .map((c) => ({
          // Normalise: ensure every command name starts with '/'
          name: c.name.startsWith('/') ? c.name : `/${c.name}`,
          description: typeof c.description === 'string' ? c.description : '',
        }));
      if (filtered.length > 0) {
        this._outputChannel.appendLine(
          `[AgentController] filtered out ${filtered.length} inert built-in command(s): ${filtered.join(', ')}`,
        );
      }
      this._provider?.postCommandsList(this._commands);
    } catch (err) {
      this._outputChannel.appendLine(`[AgentController] get_commands error: ${String(err)}`);
    }
  }

  /**
   * Called after new_session / fork / clone to reset per-session state and
   * refresh the command list and status bar.
   *
   * `clearTranscript` wipes the webview's rendered conversation — only correct
   * for `new_session` (a fresh, empty session). fork / clone branch the
   * existing history, so their transcript stays valid and must not be cleared.
   */
  public onNewSession(opts?: { clearTranscript?: boolean }): void {
    this._lastSessionStats = null;
    this._commands = [];
    this._provider?.postCommandsList([]);
    // Signal a stats reset to the status bar via the provider callback.
    this._provider?.postSessionStats(null);
    if (opts?.clearTranscript) {
      this._provider?.postSessionReset();
    }
    // Notify views (e.g. the sessions tree) that the session set changed.
    this._onSessionsChanged.fire();
    // Refresh commands for the new session (non-blocking).
    void this.getCommands();
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

  /**
   * Switch to a different session.
   * Calls `switch_session` RPC, then loads messages.
   * Returns true if successful, false if cancelled or failed.
   */
  public async switchSession(sessionPath: string): Promise<boolean> {
    if (!this._transport?.isRunning) {
      throw new Error('Sqowe Wingman: agent transport is not running');
    }

    try {
      const response = await this.sendCommand({
        type: 'switch_session',
        sessionPath,
      });

      if (!response.success) {
        throw new Error(
          `Sqowe Wingman: switch_session failed — ${response.error ?? 'unknown error'}`,
        );
      }

      const data = response.data as { cancelled?: boolean } | null;
      if (data?.cancelled) {
        return false; // Cancelled, not an error
      }

      // Load the messages from the new session
      await this.loadSessionMessages();
      return true;
    } catch (err) {
      this._outputChannel.appendLine(
        `[AgentController] switchSession error: ${String(err)}`,
      );
      throw err; // Re-throw for caller to handle
    }
  }

  /**
   * Load messages from the current session via `get_messages` RPC.
   * Sends the messages to the webview to replace the transcript.
   * Returns true if successful, false if failed.
   */
  public async loadSessionMessages(): Promise<boolean> {
    if (!this._transport?.isRunning) {
      this._outputChannel.appendLine('[AgentController] loadSessionMessages: transport not running');
      return false;
    }

    try {
      const response = await this.sendCommand({ type: 'get_messages' });
      if (!response.success) {
        this._outputChannel.appendLine(
          `[AgentController] get_messages failed: ${response.error ?? 'unknown'}`,
        );
        return false;
      }

      const data = response.data as { messages?: unknown[] } | null;
      const messages = Array.isArray(data?.messages) ? data.messages : [];

      // Send messages to webview to replace the transcript
      this._provider?.postSessionMessages(messages);

      // Refresh stats for the new session
      void this._fetchSessionStats();
      return true;
    } catch (err) {
      this._outputChannel.appendLine(
        `[AgentController] loadSessionMessages error: ${String(err)}`,
      );
      return false;
    }
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._folderWatcher?.dispose();
    this._folderWatcher = undefined;
    this._tearDownTransport();
    this._uiBridge.dispose();
    this._onSessionsChanged.dispose();
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
    this._uiBridge.setTransport(transport);
    this._isStreaming = false;
    this._eventDisposable = transport.onEvent((event: RpcEvent) => {
      this._trackStreaming(event);
      // UI protocol events are handled natively — do not forward to the webview.
      if (!this._uiBridge.handleEvent(event)) {
        this._provider?.postAgentEvent(event);
      }
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
      // Refresh stats after every completed turn (non-blocking).
      void this._fetchSessionStats();
    }
  }

  /** Fetch session stats from pi and push them to the status bar + provider. */
  private async _fetchSessionStats(): Promise<void> {
    if (!this._transport?.isRunning) return;
    // Sequence guard: only the latest fetch updates state.
    const seq = ++this._statsFetchSeq;
    try {
      const response = await this.sendCommand({ type: 'get_session_stats' });
      if (seq !== this._statsFetchSeq) return; // superseded by a newer fetch
      if (!response.success) return;
      // Normalise at the RPC boundary: tolerate camelCase/snake_case and coerce
      // types — RPC payloads can return strings or undefined for numeric fields.
      const data = (typeof response.data === 'object' && response.data !== null)
        ? response.data as Record<string, unknown>
        : {};
      const toFiniteOrNull = (v: unknown): number | null => {
        // Treat null / undefined / empty string as absent — not as 0.
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const stats: SessionStats = {
        totalTokens:   toFiniteOrNull(data['totalTokens']   ?? data['total_tokens']),
        totalCost:     toFiniteOrNull(data['totalCost']     ?? data['total_cost']),
        totalMessages: toFiniteOrNull(data['totalMessages'] ?? data['total_messages']),
      };
      this._lastSessionStats = stats;
      this._provider?.postSessionStats(stats);
    } catch {
      // Stats are best-effort — swallow errors silently.
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
    this._uiBridge.setTransport(undefined);
  }

  private _resolveCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    // Phase 1: use the first folder. Multi-root support comes in Phase 8.
    return folders[0].uri.fsPath;
  }
}
