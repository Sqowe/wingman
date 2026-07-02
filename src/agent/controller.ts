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
import type { PiStatus, PiCommand, SessionStats, ModelState, AttachedImage, InstructionFilesInfo } from '../shared/messages';
import { UiProtocolBridge } from '../ui-protocol/bridge';
import type { TrustDecision } from '../trust/project-trust';

/**
 * Commands that change the active model or thinking level (directly, or by
 * switching/branching the session). A successful one triggers a get_state
 * refresh so the model status bar reflects the new value.
 */
/**
 * Pending resolver for _reportInstructionFiles(), with a nonce for
 * correlation. Defined as a named interface (not an inline object type)
 * to prevent TypeScript's control-flow analysis from narrowing the
 * private field to 'never' after assignments across await boundaries.
 */
interface InstructionFilesWaiter {
  resolve: (info: InstructionFilesInfo | null) => void;
  nonce: number;
}

const MODEL_AFFECTING_COMMANDS = new Set<string>([
  'set_model',
  'cycle_model',
  'set_thinking_level',
  'cycle_thinking_level',
  'switch_session',
  'new_session',
  'fork',
  'clone',
]);

export class AgentController implements vscode.Disposable {
  private _transport: AgentTransport | undefined;
  private _eventDisposable: vscode.Disposable | undefined;
  private _closeDisposable: vscode.Disposable | undefined;
  private _folderWatcher: vscode.Disposable | undefined;
  /** Persistent listener for active-folder removal in running multi-root sessions. */
  private _activeFolderWatcher: vscode.Disposable | undefined;
  private _provider: WingmanViewProvider | undefined;
  private _piStatus: PiStatus | undefined;
  /**
   * The workspace folder path the user has explicitly selected (multi-root).
   * `undefined` means "use the first workspace folder" (default).
   */
  private _activeFolderPath: string | undefined;
  /**
   * The cwd the currently running transport was spawned with. Set in _doStart
   * after a successful transport.start(); cleared on teardown. Used as the
   * stable "previous cwd" reference in the folder-change watcher so we never
   * call _resolveCwd() (which mutates _activeFolderPath) for comparisons.
   */
  private _currentCwd: string | undefined;
  /**
   * The trust flag to pass when spawning pi for the current active folder.
   * `'--approve'` / `'--no-approve'` / `undefined` (no flag).
   */
  private _trustArg: string | undefined;
  /** True while pi is mid-turn (between agent_start and agent_end). */
  private _isStreaming = false;
  /** True once the agentBusy context key has been initialised (avoids a
   * setContext call before the extension is fully activated). */
  private _busyKeyInitialised = false;
  /** Most-recent session stats (updated after every agent_end). */
  private _lastSessionStats: SessionStats | null = null;
  /** True while a get_session_stats fetch is in flight — prevents races. */
  private _statsFetchSeq = 0;
  /** Cached list of user slash commands for the current session. */
  private _commands: PiCommand[] = [];
  /** In-flight getCommands promise — coalesces concurrent fetches into one RPC call. */
  private _commandsFetch: Promise<void> | undefined;
  /** Raw (unfiltered) command names from the last successful get_commands response.
   * Stored so _reportInstructionFiles() can check for internal commands without
   * issuing a second RPC round-trip. */
  private _rawCommandNames: Set<string> = new Set();
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
  /** Fires when the active workspace folder changes (multi-root). */
  private readonly _onActiveFolderChanged = new vscode.EventEmitter<string>();
  public readonly onActiveFolderChanged: vscode.Event<string> = this._onActiveFolderChanged.event;
  /** Fires with the active model + thinking level (null = unknown / pi down). */
  private readonly _onModelState = new vscode.EventEmitter<ModelState | null>();
  public readonly onModelState: vscode.Event<ModelState | null> = this._onModelState.event;
  /** Most-recent model state. */
  private _lastModelState: ModelState | null = null;
  /** Sequence guard for concurrent get_state fetches. */
  private _modelStateSeq = 0;
  /** Fires after session (re)start with resolved instruction file info (null = unavailable). */
  private readonly _onInstructionFiles = new vscode.EventEmitter<InstructionFilesInfo | null>();
  public readonly onInstructionFiles: vscode.Event<InstructionFilesInfo | null> = this._onInstructionFiles.event;
  /**
   * Holds the pending _reportInstructionFiles() resolver + its nonce.
   * Using a named interface (not an inline object literal) prevents TypeScript's
   * control-flow narrowing from inferring 'never' across await boundaries.
   * The nonce guards against stale callbacks from superseded requests.
   */
  private _instructionFilesWaiter: InstructionFilesWaiter | undefined;
  private _instructionFilesNonce = 0;

  constructor(private readonly _bundledExtensionPath?: string) {
    this._outputChannel = vscode.window.createOutputChannel('Sqowe Wingman');
    this._uiBridge = new UiProtocolBridge(
      this._outputChannel,
      (info) => {
        // Bridge callback: resolve the pending _reportInstructionFiles() promise
        // only if the nonce still matches (prevents stale cross-call delivery).
        const waiter = this._instructionFilesWaiter as InstructionFilesWaiter | undefined;
        if (waiter && waiter.nonce === this._instructionFilesNonce) {
          this._instructionFilesWaiter = undefined;
          waiter.resolve(info);
        }
      },
    );
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
   * Set the trust flag derived from the project-trust gate result.
   * Must be called before `start()` for the flag to take effect.
   *
   * - `{ kind: 'no-resources' }` → no flag
   * - `{ kind: 'saved', trusted: true }` → `--approve`
   * - `{ kind: 'saved', trusted: false }` → `--no-approve`
   * - `{ kind: 'needs-prompt' }` → clears any previous flag (safe default: no
   *   project resources loaded) so a stale decision from a prior folder never
   *   leaks into a new spawn.
   */
  public setTrustDecision(decision: TrustDecision): void {
    if (decision.kind === 'no-resources') {
      this._trustArg = undefined;
    } else if (decision.kind === 'saved' || decision.kind === 'temporary') {
      this._trustArg = decision.trusted ? '--approve' : '--no-approve';
    } else {
      // needs-prompt — caller has not resolved trust yet; clear any stale arg.
      this._trustArg = undefined;
    }
  }

  /**
   * Initialise the active folder path without triggering a transport restart.
   * Used by extension.ts during activation to restore the persisted folder
   * before `start()` is called for the first time.
   *
   * Unlike `setActiveFolderPath`, this method:
   *  - Does NOT restart the transport.
   *  - DOES fire `onActiveFolderChanged` so any listeners initialise correctly.
   *  - Validates that the path is still among the open workspace folders;
   *    silently ignores the call if it is not.
   */
  public initActiveFolderPath(folderPath: string): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.some((f) => f.uri.fsPath === folderPath)) return;
    this._activeFolderPath = folderPath;
    this._onActiveFolderChanged.fire(folderPath);
  }

  /** Serialises all start/restart operations. Every call to _serializedStart
   * chains onto this promise, so concurrent restarts queue up rather than
   * racing to spawn multiple pi processes. */
  private _restartChain: Promise<void> = Promise.resolve();

  /**
   * Force a transport restart for the current active folder, even if the
   * folder path has not changed. Used by `trustProject` to apply a new trust
   * decision immediately without requiring a folder switch.
   * Serialized against concurrent restarts and start() calls.
   * Only restarts when piStatus is 'found' or 'version-warning' (has a valid
   * executable path); returns immediately for all other statuses.
   */
  public forceRestart(piStatus: PiStatus): Promise<void> {
    if (this._disposed) return Promise.resolve();
    if (piStatus.kind !== 'found' && piStatus.kind !== 'version-warning') {
      return Promise.resolve();
    }
    return this._serializedStart(piStatus, { tearDownFirst: true });
  }

  /**
   * Reload the pi sidecar in place.
   *
   * Re-spawns the pi process with a freshly located binary (picks up system
   * updates and reinstalls) while preserving the current conversation by
   * capturing the session file and resuming it via `--session <path>`.
   *
   * This method owns all user-facing notifications and never throws — the
   * command handler does not need a try/catch around it.
   *
   * Sequence:
   *  1. Update the cached pi status.
   *  2. If `not-found`, tear down cleanly and return (caller shows the error).
   *  3. Capture `sessionFile` from `get_state` (best-effort; undefined if pi down).
   *  4. Attempt a serialized restart, optionally with `--session <path>`.
   *  5. If the transport is not running after the attempt and a session was
   *     captured, retry once without `--session` (fresh session fallback).
   *  6. Perform post-start refresh (transcript repaint or reset, commands, model).
   */
  public async reload(status: PiStatus): Promise<void> {
    // Authoritative busy guard — refuse reload mid-turn regardless of how the
    // method is invoked (command, palette, or future callers).
    if (this._isStreaming) {
      this._outputChannel.appendLine('[AgentController] reload: refused — agent is mid-turn');
      void vscode.window.showInformationMessage(
        'Sqowe Wingman: cannot reload while the agent is working.',
      );
      return;
    }

    this._piStatus = status;

    if (status.kind !== 'found' && status.kind !== 'version-warning') {
      // Not runnable (not-found or any future non-runnable kind) — tear down.
      this._tearDownTransport();
      return;
    }

    const runnableStatus = status;

    // Step 1: capture the current session file (best-effort).
    let sessionFile: string | undefined;
    try {
      if (this._transport?.isRunning) {
        const resp = await this.sendCommand({ type: 'get_state' });
        if (resp.success && typeof resp.data === 'object' && resp.data !== null) {
          const sf = (resp.data as Record<string, unknown>)['sessionFile'];
          if (typeof sf === 'string' && sf !== '') {
            sessionFile = sf;
          }
        }
      }
    } catch {
      // Best-effort — continue without resume if get_state fails.
    }

    // Step 2: attempt start (with resume if we have a session file).
    // Re-check streaming immediately before teardown — a turn may have started
    // while get_state was in flight.
    if (this._isStreaming) {
      this._outputChannel.appendLine('[AgentController] reload: aborted — agent became busy after guard');
      void vscode.window.showInformationMessage(
        'Sqowe Wingman: cannot reload while the agent is working.',
      );
      return;
    }
    await this._serializedStart(runnableStatus, {
      tearDownFirst: true,
      resumeSessionPath: sessionFile,
      quiet: true,
    });

    // Step 3: if the transport is not running and we tried to resume,
    // fall back to a fresh session.
    let usedFreshFallback = false;
    if (sessionFile && !this._transport?.isRunning) {
      this._outputChannel.appendLine(
        '[AgentController] reload: resume failed — retrying with fresh session',
      );
      await this._serializedStart(runnableStatus, { tearDownFirst: true, quiet: true });
      usedFreshFallback = true;
    }

    // Step 4: if the transport is still not running after all attempts, bail.
    if (!this._transport?.isRunning) {
      this._outputChannel.appendLine('[AgentController] reload: failed to start pi');
      void vscode.window.showErrorMessage(
        'Sqowe Wingman: reload failed — pi could not be started.',
      );
      return;
    }

    // Step 5: post-start refresh (best-effort — never throws).
    try {
      if (usedFreshFallback) {
        this._provider?.postSessionReset();
        void vscode.window.showInformationMessage(
          'Sqowe Wingman: started a fresh session (previous one could not be resumed).',
        );
        // Repaint transcript to match the new (empty) session state.
        await this.loadSessionMessages();
      } else {
        // Always sync the transcript — covers both resume (repaint from session)
        // and fresh start (pi was down; new empty session replaces old stale UI).
        await this.loadSessionMessages();
      }
      void this.getCommands();
      void this._refreshModelState();
      // Report resolved instruction files after reload (non-blocking).
      void this._reportInstructionFiles();
    } catch (err) {
      this._outputChannel.appendLine(
        `[AgentController] reload: post-start refresh failed: ${String(err)}`,
      );
      void vscode.window.showErrorMessage(
        'Sqowe Wingman: agent reloaded but failed to refresh the session view.',
      );
    }
  }

  /**
   * Initialise the `sqoweWingman.agentBusy` context key to `false`.
   * Must be called once from `extension.ts` after the controller is created,
   * so the key exists before any menu `enablement` expression is evaluated.
   */
  public initBusyContextKey(): void {
    if (this._busyKeyInitialised) return;
    this._busyKeyInitialised = true;
    // Publish the *current* streaming state so the menu enablement expression
    // is immediately correct, even if initBusyContextKey is called mid-turn.
    void vscode.commands.executeCommand('setContext', 'sqoweWingman.agentBusy', this._isStreaming);
  }

  /**
   * Set the active workspace folder (multi-root support).
   * If the path is not among the current workspace folders it is ignored.
   * Restarts the transport if the folder actually changed and pi is running.
   * Serialized against concurrent restarts.
   */
  public async setActiveFolderPath(
    folderPath: string,
    piStatus?: PiStatus,
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.some((f) => f.uri.fsPath === folderPath)) return;
    if (this._activeFolderPath === folderPath) return;

    this._activeFolderPath = folderPath;
    this._onActiveFolderChanged.fire(folderPath);

    // Only restart the transport when we have a runnable pi status.
    const status = piStatus ?? this._piStatus;
    if (status?.kind === 'found' || status?.kind === 'version-warning') {
      await this._serializedStart(status, { tearDownFirst: true });
    }
  }

  /**
   * Send an arbitrary RPC command and return the response.
   * All command code must go through this — never touch the concrete transport.
   */
  public async sendCommand(command: import('./transport').RpcCommand): Promise<import('./transport').RpcResponse> {
    if (!this._transport?.isRunning) {
      throw new Error('Sqowe Wingman: agent transport is not running');
    }
    const response = await this._transport.send(command);
    // After a command that may have changed the model/thinking level, refresh
    // the cached state (non-blocking) so the status bar stays accurate. get_state
    // is not in the set, so this never recurses.
    if (response.success && MODEL_AFFECTING_COMMANDS.has(command.type)) {
      void this._refreshModelState();
    }
    return response;
  }

  /** The most recently fetched model + thinking level, or null before the first fetch. */
  public get lastModelState(): ModelState | null {
    return this._lastModelState;
  }

  /**
   * Fetch the active model + thinking level via get_state and fire onModelState.
   * Best-effort: sequence-guarded against concurrent fetches, errors swallowed.
   */
  private async _refreshModelState(): Promise<void> {
    if (!this._transport?.isRunning) return;
    const seq = ++this._modelStateSeq;
    try {
      const response = await this.sendCommand({ type: 'get_state' });
      if (seq !== this._modelStateSeq) return; // superseded
      if (!response.success) return;
      const data = (typeof response.data === 'object' && response.data !== null)
        ? response.data as Record<string, unknown>
        : {};
      const model = (typeof data['model'] === 'object' && data['model'] !== null)
        ? data['model'] as Record<string, unknown>
        : null;
      const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
      const inputArr = Array.isArray(model?.['input']) ? (model!['input'] as unknown[]) : [];
      const state: ModelState = {
        modelId: model ? str(model['id']) : null,
        modelName: model ? str(model['name']) : null,
        provider: model ? str(model['provider']) : null,
        thinkingLevel: str(data['thinkingLevel']),
        supportsImages: inputArr.includes('image'),
      };
      this._lastModelState = state;
      this._onModelState.fire(state);
    } catch {
      // Best-effort — leave the last known state in place.
    }
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
      // Cache raw (unfiltered) normalized names so _reportInstructionFiles() can
      // check for internal commands without a second RPC round-trip.
      this._rawCommandNames = new Set(
        valid.map((c) => c.name.replace(/^\//, '')),
      );
      // Filter out built-in TUI commands that are inert over RPC.
      const BUILTIN_INERT = new Set([
        'settings', 'model', 'new', 'resume', 'fork', 'clone',
        'export', 'thinking', 'login', 'logout', 'compact',
      ]);
      const filtered: string[] = [];
      // Internal Wingman command — never shown in the autocomplete.
      const INTERNAL_WINGMAN = new Set(['wingman-instruction-report']);
      this._commands = valid
        .filter((c) => {
          const stripped = c.name.replace(/^\//, '');
          if (BUILTIN_INERT.has(stripped)) {
            filtered.push(c.name);
            return false;
          }
          if (INTERNAL_WINGMAN.has(stripped)) {
            return false; // silently excluded — never user-facing
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
   * Query pi's bundled extension for the resolved instruction files and push
   * the result to the webview banner.
   *
   * Flow:
   *   1. Check get_commands result for 'wingman-instruction-report'.
   *      - Absent (extension not loaded / old pi) → fire null immediately.
   *   2. Send '/wingman-instruction-report' as a prompt (silent — no chat bubble).
   *   3. Await the reserved setStatus callback from UiProtocolBridge (3s timeout).
   *   4. Fire the result via _onInstructionFiles and push to the provider.
   *
   * Never throws; never blocks the caller; all failures degrade to null.
   */
  private async _reportInstructionFiles(): Promise<void> {
    const COMMAND = 'wingman-instruction-report';
    const TIMEOUT_MS = 3_000;

    // Concurrency guard: cancel any in-flight report before starting a new one.
    if (this._instructionFilesWaiter) {
      this._instructionFilesWaiter.resolve(null);
      this._instructionFilesWaiter = undefined;
    }

    // Assign a nonce so a stale bridge callback from a superseded call is ignored.
    const nonce = ++this._instructionFilesNonce;

    if (!this._transport?.isRunning) {
      this._onInstructionFiles.fire(null);
      this._provider?.postInstructionFiles(null);
      return;
    }

    // Check whether our command is present using the cached raw command list
    // populated by the most recent getCommands() call. This avoids a second
    // RPC round-trip and ensures we see the same response as getCommands().
    // Fall back to a live RPC call only when the cache is empty (e.g. report
    // fires before getCommands() has completed on a fresh session).
    let commandPresent = this._rawCommandNames.has(COMMAND);

    if (!commandPresent && this._rawCommandNames.size === 0) {
      // Cache not yet populated — fetch once.
      try {
        const response = await this.sendCommand({ type: 'get_commands' });
        if (response.success) {
          const data = response.data as { commands?: unknown[] } | null;
          const raw = Array.isArray(data?.commands) ? data!.commands : [];
          commandPresent = raw.some(
            (c) => {
              if (!c || typeof c !== 'object') return false;
              const name = String((c as Record<string, unknown>)['name'] ?? '');
              return name.replace(/^\//, '') === COMMAND;
            },
          );
        }
      } catch {
        // Best-effort — treat as absent.
      }
    }

    // Guard: if superseded while awaiting get_commands fallback, bail out.
    if (nonce !== this._instructionFilesNonce) return;

    if (!commandPresent) {
      this._outputChannel.appendLine(
        `[AgentController] ${COMMAND} not found in get_commands — no instruction-file info available (extension not loaded or pi too old)`,
      );
      this._onInstructionFiles.fire(null);
      this._provider?.postInstructionFiles(null);
      return;
    }

    // Set up the promise that will be resolved by the bridge callback.
    const infoPromise = new Promise<InstructionFilesInfo | null>((resolve) => {
      this._instructionFilesWaiter = { resolve, nonce };
    });

    // Send the command silently (it is a /prompt, not an LLM turn).
    try {
      await this.sendCommand({ type: 'prompt', message: `/${COMMAND}` });
    } catch (err) {
      this._outputChannel.appendLine(
        `[AgentController] _reportInstructionFiles: sendCommand error: ${String(err)}`,
      );
      const w = this._instructionFilesWaiter as InstructionFilesWaiter | undefined;
      if (w?.nonce === nonce) {
        w.resolve(null);
        this._instructionFilesWaiter = undefined;
      }
    }

    // Guard: if superseded while awaiting sendCommand, bail out.
    if (nonce !== this._instructionFilesNonce) return;

    // Race the bridge callback against a defensive timeout.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    const info = await Promise.race([infoPromise, timeoutPromise]);

    // Clear the timeout if the bridge callback won the race.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    // Guard: if superseded while awaiting the race, bail out.
    if (nonce !== this._instructionFilesNonce) return;

    // Clean up any still-pending waiter (timeout path).
    const w2 = this._instructionFilesWaiter as InstructionFilesWaiter | undefined;
    if (w2?.nonce === nonce) {
      this._instructionFilesWaiter = undefined;
      w2.resolve(null); // resolve so the promise doesn't dangle
      this._outputChannel.appendLine(
        `[AgentController] _reportInstructionFiles: timed out after ${TIMEOUT_MS}ms — falling back to null`,
      );
    }

    this._onInstructionFiles.fire(info);
    this._provider?.postInstructionFiles(info);
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
    // A new/forked/cloned session can never legitimately be "mid-turn" — any
    // busy state carried over from the previous session's abandoned turn
    // (e.g. one that never reached a clean agent_end) is now stale and would
    // otherwise permanently block prompts in the new session.
    this._setStreaming(false);
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
    // Report instruction files for the new session (non-blocking).
    void this._reportInstructionFiles();
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

    return this._serializedStart(piStatus, { tearDownFirst: false });
  }

  /**
   * Serialized start/restart entry point.
   *
   * All concurrent calls chain onto `_restartChain` so only one spawn is ever
   * in flight at a time. `tearDownFirst: true` tears down the current transport
   * before starting (used by forceRestart / setActiveFolderPath). `false` skips
   * teardown when we are simply starting from scratch (no running transport).
   */
  private _serializedStart(
    piStatus: PiStatus & { kind: 'found' | 'version-warning' },
    opts: { tearDownFirst: boolean; resumeSessionPath?: string; quiet?: boolean },
  ): Promise<void> {
    // Each slot attaches to the current chain via .catch(() => {}) so a failure
    // in one slot does not prevent subsequent slots from running. The slot
    // itself re-throws so the direct caller still sees the error.
    const slot = this._restartChain
      .catch(() => { /* ignore predecessor failure — slot still runs */ })
      .then(async () => {
        if (this._disposed) return;
        if (opts.tearDownFirst) {
          this._tearDownTransport();
        } else if (this._transport?.isRunning) {
          return; // already running — nothing to do
        }
        // Delegate to the existing _doStart which manages the startSeq guard.
        this._starting = this._doStart(piStatus, opts.resumeSessionPath, opts.quiet).finally(() => {
          this._starting = undefined;
        });
        await this._starting;
      });

    // Advance the chain with a version that swallows errors so the next slot
    // always has a resolved predecessor to chain from.
    this._restartChain = slot.catch((err: unknown) => {
      this._outputChannel.appendLine(
        `[AgentController] serialized start error: ${String(err)}`,
      );
    });

    // Return the slot (not the chain) so the direct caller gets the raw error.
    return slot;
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
   * Send a prompt string (and optional images) to pi.
   * If the transport is not yet running, attempts a late start first.
   */
  public async sendPrompt(text: string, images?: AttachedImage[]): Promise<void> {
    if (!this._transport?.isRunning) {
      if (this._piStatus && this._piStatus.kind !== 'not-found') {
        await this.start(this._piStatus);
      }
      if (!this._transport?.isRunning) {
        throw new Error('Sqowe Wingman: agent transport is not running');
      }
    }

    const rpcImages = images?.length
      ? images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
      : undefined;

    const response = await this._transport.send({
      type: 'prompt',
      message: text,
      ...(rpcImages ? { images: rpcImages } : {}),
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

      // The switched-to session can never legitimately be "mid-turn" — any
      // busy state carried over from the previous session is now stale.
      this._setStreaming(false);

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

  /**
   * The currently active workspace folder path (multi-root).
   * Returns undefined when no workspace is open.
   */
  public get activeFolderPath(): string | undefined {
    return this._resolveCwd();
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._folderWatcher?.dispose();
    this._folderWatcher = undefined;
    this._activeFolderWatcher?.dispose();
    this._activeFolderWatcher = undefined;
    this._tearDownTransport();
    this._uiBridge.dispose();
    this._onSessionsChanged.dispose();
    this._onActiveFolderChanged.dispose();
    this._onModelState.dispose();
    this._onInstructionFiles.dispose();
    // Reject any pending instruction-files wait so it doesn't dangle.
    this._instructionFilesWaiter?.resolve(null);
    this._instructionFilesWaiter = undefined;
    this._outputChannel.dispose();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async _doStart(
    piStatus: PiStatus & { kind: 'found' | 'version-warning' },
    resumeSessionPath?: string,
    quiet = false,
  ): Promise<void> {
    if (this._disposed) return;

    const seq = ++this._startSeq;
    const cwd = this._resolveCwd();

    if (!cwd) {
      this._watchForWorkspaceFolder(piStatus);
      return;
    }

    this._tearDownTransport();

    const extraArgs = [
      ...(this._trustArg ? [this._trustArg] : []),
      ...(resumeSessionPath ? ['--session', resumeSessionPath] : []),
      ...(this._bundledExtensionPath ? ['-e', this._bundledExtensionPath] : []),
    ];
    const transport = new RpcTransport(piStatus.path, cwd, extraArgs);
    transport.outputChannel = this._outputChannel;

    try {
      await transport.start();
    } catch (err) {
      transport.dispose();
      // Only surface the error if we're still the current start and not disposed.
      // `quiet` callers (reload's resume + fresh-fallback attempts) own their own
      // messaging, so the error is logged rather than shown to avoid a misleading
      // toast before the fallback outcome is known.
      if (!this._disposed && seq === this._startSeq) {
        if (quiet) {
          this._outputChannel.appendLine(
            `[AgentController] start failed (suppressed): ${String(err)}`,
          );
        } else {
          void vscode.window.showErrorMessage(
            `Sqowe Wingman: failed to start pi — ${String(err)}`,
          );
        }
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
    this._setStreaming(false);
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
    // Record the cwd this transport was spawned with as a stable reference
    // for the folder-change watcher (avoids calling _resolveCwd() for comparisons).
    this._currentCwd = cwd;

    // Populate the model status bar with the freshly-started session's state.
    void this._refreshModelState();
    // Report resolved instruction files to the webview banner (non-blocking).
    void this._reportInstructionFiles();

    // Install (or replace) the persistent active-folder watcher now that the
    // transport is live. This watches for workspace-folder changes that affect
    // the running agent (e.g. the active folder being removed) and restarts pi
    // automatically. Unlike _folderWatcher, this is never disposed on a
    // successful start — it stays active for the lifetime of the controller.
    this._activeFolderWatcher?.dispose();
    this._activeFolderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(
      ({ removed }) => {
        if (this._disposed) return;
        const folders = vscode.workspace.workspaceFolders;

        // Use _currentCwd (set at transport-start time) as the stable "previous"
        // reference. Calling _resolveCwd() here would mutate _activeFolderPath
        // before we've handled the removal, making the comparison unreliable.
        const previousCwd = this._currentCwd;

        // If the active folder was removed, switch to the first remaining folder.
        const activeFolderRemoved =
          !!this._activeFolderPath &&
          removed.some((f) => f.uri.fsPath === this._activeFolderPath);

        if (activeFolderRemoved) {
          const next = folders?.[0]?.uri.fsPath;
          this._activeFolderPath = next;
          if (next) {
            this._onActiveFolderChanged.fire(next);
          }
        }

        // Now compute the new effective cwd after updating _activeFolderPath.
        const newCwd = this._resolveCwd();
        const ps = this._piStatus;

        if (!newCwd) {
          // No folders left — tear down and wait for a folder to re-appear.
          this._tearDownTransport();
          this._provider?.postAgentStatus({
            running: false,
            reason: 'No workspace folder open',
          });
          if (ps) this._watchForWorkspaceFolder(ps);
        } else if (newCwd !== previousCwd && (ps?.kind === 'found' || ps?.kind === 'version-warning')) {
          // Only restart when the effective cwd actually changed; removals of
          // unrelated folders in a multi-root workspace do not require a restart.
          void this._serializedStart(
            ps as PiStatus & { kind: 'found' | 'version-warning' },
            { tearDownFirst: true },
          ).catch((err: unknown) => {
            this._outputChannel.appendLine(
              `[AgentController] active-folder change restart error: ${String(err)}`,
            );
          });
        }
      },
    );
  }

  /**
   * Set the streaming flag and publish the `sqoweWingman.agentBusy` VS Code
   * context key so menu `enablement` expressions react automatically.
   * The context key is only published after `initBusyContextKey()` has been
   * called — callers that invoke `start()` before the extension is fully
   * activated will not trigger unexpected context updates.
   */
  private _setStreaming(v: boolean): void {
    this._isStreaming = v;
    if (!this._busyKeyInitialised) return;
    void vscode.commands.executeCommand('setContext', 'sqoweWingman.agentBusy', v);
  }

  /** Tracks pi's turn lifecycle so callers can tell when a prompt would be rejected. */
  private _trackStreaming(event: RpcEvent): void {
    if (event.type === 'agent_start') {
      this._setStreaming(true);
    } else if (event.type === 'agent_end') {
      this._setStreaming(false);
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
    this._setStreaming(false);
    this._provider?.postAgentStatus({ running: false, reason });
    // pi is gone — the displayed model is no longer authoritative.
    this._lastModelState = null;
    this._onModelState.fire(null);
  }

  /**
   * Watch for workspace folders being added or removed.
   *
   * - Added: retry start() when a folder first appears (no-workspace → workspace).
   * - Removed: if the active folder was removed, auto-switch to the first
   *   remaining folder and restart so the user always has a live agent.
   */
  /**
   * Watch for the first workspace folder to appear when none was open at
   * activation time. Disposes itself once a folder is available and start()
   * succeeds. Active-folder removal while the transport is running is handled
   * by the persistent `_activeFolderWatcher` installed in `_doStart`.
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
    this._setStreaming(false);
    this._transport?.dispose();
    this._transport = undefined;
    this._currentCwd = undefined;
    this._uiBridge.setTransport(undefined);
  }

  /**
   * Resolve the cwd for the pi child process.
   *
   * Priority:
   *   1. `_activeFolderPath` if it is still among the open workspace folders.
   *   2. First workspace folder (fallback / single-root default).
   *
   * Also self-heals `_activeFolderPath` when the persisted folder is no longer
   * in the workspace (e.g. after a folder is removed).
   */
  private _resolveCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;

    if (this._activeFolderPath) {
      const still = folders.find((f) => f.uri.fsPath === this._activeFolderPath);
      if (still) return still.uri.fsPath;
      // The saved folder is gone — fall back and clear the stale value.
      this._activeFolderPath = undefined;
    }

    return folders[0].uri.fsPath;
  }
}
