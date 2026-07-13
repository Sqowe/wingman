/**
 * RpcTransport — spawns `pi --mode rpc` as a child process and speaks the
 * JSONL protocol described in pi's docs/rpc.md.
 *
 * Framing rules (from rpc.md):
 *  - Split stdout on LF (`\n`) only — never `U+2028` / `U+2029`.
 *  - Strip a trailing CR from each line.
 *  - Buffer partial lines across chunk boundaries.
 *  - Do NOT use Node `readline`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as os from 'os';
import * as vscode from 'vscode';
import type {
  AgentTransport,
  RpcCommand,
  RpcEvent,
  RpcResponse,
} from './transport';

/** Milliseconds before a send() rejects if pi never responds. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Default cap on the stdout line buffer (MB), overridable via the
 * `sqoweWingman.maxStdoutBufferMb` setting. This buffer must hold the largest single
 * RPC line pi emits — the per-turn `agent_end`, whose serialized size grows with the
 * context window (several MB at a 1M-token context, more with inline base64 images).
 */
const DEFAULT_STDOUT_BUF_MAX_MB = 64;

/** Maximum serialized event size forwarded to the webview (bytes). Lifecycle/state events
 * bypass this (see {@link isCriticalEvent}) — only bulk *content* events are bounded. */
const MAX_EVENT_BYTES = 16_777_216; // 16 MB

/**
 * Floor for the stdout buffer cap: it must never be smaller than {@link MAX_EVENT_BYTES},
 * or a large-but-forwardable content event would trip the buffer kill (terminating pi)
 * before the event-size decision is ever reached.
 */
const MIN_STDOUT_BUF_MAX_BYTES = MAX_EVENT_BYTES;

/** Hard cap on the stderr line buffer (bytes). */
const STDERR_BUF_MAX_BYTES = 524_288; // 512 KB

/**
 * Event-type prefixes/names that are **never** size-dropped. These carry pi's lifecycle
 * and session state (agent/turn boundaries, compaction, retries, queue). Dropping one —
 * `agent_end` above all — would strand the UI in a permanent "Agent is working…" state,
 * since Wingman clears its streaming flag only on that event. Bulk *content* events
 * (`message_update`, `tool_execution_*`) are not listed and remain bounded by MAX_EVENT_BYTES.
 */
const CRITICAL_EVENT_PREFIXES = ['agent_', 'turn_', 'compaction_', 'auto_retry_'] as const;
const CRITICAL_EVENT_TYPES = new Set<string>(['queue_update']);

function isCriticalEvent(type: string): boolean {
  return (
    CRITICAL_EVENT_TYPES.has(type) ||
    CRITICAL_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))
  );
}

/** Resolve the stdout buffer cap (bytes) from settings, clamped to a safe floor. */
function readStdoutBufMaxBytes(): number {
  const mb = vscode.workspace
    .getConfiguration('sqoweWingman')
    .get<number>('maxStdoutBufferMb', DEFAULT_STDOUT_BUF_MAX_MB);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_STDOUT_BUF_MAX_MB;
  return Math.max(safeMb * 1024 * 1024, MIN_STDOUT_BUF_MAX_BYTES);
}

interface PendingRequest {
  resolve: (value: RpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Env allowlist ─────────────────────────────────────────────────────────
// pi needs PATH to find tools, HOME/USERPROFILE to locate ~/.pi/agent/ config,
// and temp dirs + locale vars. Avoid forwarding every extension-host variable.
/**
 * Variables always forwarded to the pi child process (cross-platform).
 * Comparison is case-insensitive on Windows (see buildChildEnv).
 * PI_* and common proxy/git/ssh vars are also forwarded.
 */
const ENV_ALLOWLIST_COMMON = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NODE_PATH',
  // Proxy / TLS
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Git
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_CONFIG_NOSYSTEM',
  // SSH agent
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
]);

/**
 * Additional variables required on Windows for spawning shells and locating
 * the runtime environment.
 */
const ENV_ALLOWLIST_WINDOWS_UPPER = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE',
]);

function buildChildEnv(
  platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): NodeJS.ProcessEnv {
  const isWindows = platform === 'win32';
  // On Windows, uppercase the common allowlist for case-insensitive matching.
  const commonUpper = isWindows
    ? new Set(Array.from(ENV_ALLOWLIST_COMMON).map((k) => k.toUpperCase()))
    : null;
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;

    const keyUpper = isWindows ? key.toUpperCase() : key;

    if (
      (isWindows ? commonUpper!.has(keyUpper) : ENV_ALLOWLIST_COMMON.has(key)) ||
      (isWindows && ENV_ALLOWLIST_WINDOWS_UPPER.has(keyUpper)) ||
      keyUpper.startsWith('PI_')
    ) {
      env[key] = value;
    }
  }

  // Ensure HOME is always set — pi requires it to locate ~/.pi/agent/.
  env['HOME'] = env['HOME'] ?? homeDir;
  return env;
}

/** Exported for unit tests only — do not call from production code. */
export { buildChildEnv as _buildChildEnvForTesting };

/** Maximum number of payloads queued for stdin writes. */
const WRITE_QUEUE_MAX = 256;

// ─── RpcTransport ─────────────────────────────────────────────────────────────

export class RpcTransport implements AgentTransport {
  private _proc: ChildProcessWithoutNullStreams | undefined;
  private _buf = '';
  private _nextId = 1;
  private _pending = new Map<string, PendingRequest>();
  private _eventHandlers = new Set<(event: RpcEvent) => void>();
  private _closeHandlers = new Set<(info: { reason: string }) => void>();
  private _isRunning = false;
  /** Optional output channel for transport diagnostics. */
  public outputChannel: vscode.OutputChannel | undefined;

  /** Running byte count of the stdout line buffer (accurate for multibyte chars). */
  private _bufBytes = 0;
  private _writeQueue: string[] = [];
  private _writeFlushing = false;

  /** Cap on the stdout line buffer (bytes); resolved from `sqoweWingman.maxStdoutBufferMb`. */
  private readonly _stdoutBufMaxBytes = readStdoutBufMaxBytes();
  /** Cap on the size of a single forwarded (non-critical) event (bytes). */
  private readonly _maxEventBytes = MAX_EVENT_BYTES;

  /**
   * @param piPath     Absolute path to the `pi` executable.
   * @param cwd        Working directory (active workspace folder).
   * @param extraArgs  Additional CLI flags to pass after `--mode rpc`.
   *                   Used by Phase 8 to pass `--approve` / `--no-approve`
   *                   for the project-trust gate.
   */
  constructor(
    private readonly _piPath: string,
    private readonly _cwd: string,
    private readonly _extraArgs: string[] = [],
  ) {}

  // ─── AgentTransport ───────────────────────────────────────────────────────

  get isRunning(): boolean {
    return this._isRunning;
  }

  public start(): Promise<void> {
    if (this._isRunning) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const env = buildChildEnv();

      const proc = spawn(this._piPath, ['--mode', 'rpc', ...this._extraArgs], {
        cwd: this._cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._proc = proc;

      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          this._isRunning = true;
          resolve();
        }
      };

      // Fail fast on spawn error.
      proc.once('error', (err) => settle(err));

      // Track the readiness ping id/timer so we can clean them up on early exit.
      let readinessId: string | undefined;
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanupReadiness = (): void => {
        if (readinessTimer !== undefined) {
          clearTimeout(readinessTimer);
          readinessTimer = undefined;
        }
        if (readinessId !== undefined) {
          this._pending.delete(readinessId);
          readinessId = undefined;
        }
      };

      // If the process dies before we confirm readiness, clean up and reject.
      proc.once('close', (code) => {
        cleanupReadiness();
        settle(new Error(`pi exited before becoming ready (code ${code ?? 'null'})`));
        // Also handle the ongoing exit path for after readiness.
        this._handleExit(`pi process closed (exit code ${code ?? 'null'})`);
      });

      this._attachJsonlReader(proc);
      this._attachStderrReader(proc);

      // Confirm readiness by sending get_state and awaiting a successful
      // response. This catches cases where pi spawns but then exits immediately.
      proc.once('spawn', () => {
        const id = `ready-${this._nextId++}`;
        const payload = JSON.stringify({ type: 'get_state', id }) + '\n';

        readinessId = id;
        readinessTimer = setTimeout(() => {
          cleanupReadiness();
          settle(new Error('RpcTransport: pi did not respond to readiness ping'));
        }, 10_000);

        this._pending.set(id, {
          resolve: (res) => {
            cleanupReadiness();
            // Validate the response: must be a successful get_state reply.
            if (!res.success) {
              settle(new Error(
                `RpcTransport: pi readiness check failed — ${res.error ?? 'unknown error'}`,
              ));
              return;
            }
            settle(); // process is alive and responding
          },
          reject: (err) => {
            cleanupReadiness();
            settle(err);
          },
          timer: readinessTimer,
        });

        proc.stdin.write(payload, (err) => {
          if (err) {
            cleanupReadiness();
            settle(err);
          }
        });
      });
    });
  }

  public sendRaw(payload: Record<string, unknown>): void {
    if (!this._isRunning || !this._proc) {
      throw new Error('RpcTransport: transport is not running');
    }
    const line = JSON.stringify(payload) + '\n';
    this._enqueueWrite(line);
  }

  public send(command: RpcCommand): Promise<RpcResponse> {
    if (!this._isRunning || !this._proc) {
      return Promise.reject(new Error('RpcTransport: transport is not running'));
    }

    return new Promise((resolve, reject) => {
      const id = `req-${this._nextId++}`;
      const payload = JSON.stringify({ ...command, id }) + '\n';

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RpcTransport: request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });

      this._enqueueWrite(payload);
    });
  }

  public onEvent(handler: (event: RpcEvent) => void): vscode.Disposable {
    this._eventHandlers.add(handler);
    return new vscode.Disposable(() => {
      this._eventHandlers.delete(handler);
    });
  }

  public onClose(handler: (info: { reason: string }) => void): vscode.Disposable {
    this._closeHandlers.add(handler);
    return new vscode.Disposable(() => {
      this._closeHandlers.delete(handler);
    });
  }

  /** Invokes and clears the close handlers exactly once (unexpected death only). */
  private _fireClose(reason: string): void {
    const handlers = Array.from(this._closeHandlers);
    this._closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler({ reason });
      } catch {
        // A misbehaving handler must not break the others.
      }
    }
  }

  public dispose(): void {
    this._isRunning = false;
    this._rejectAllPending('transport disposed');
    this._eventHandlers.clear();
    // Deliberate teardown — drop close listeners without notifying them.
    this._closeHandlers.clear();
    this._writeQueue = [];

    if (this._proc) {
      try {
        this._proc.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
      } catch {
        // stdin may already be closed — ignore
      }
      const proc = this._proc;
      this._proc = undefined;
      setTimeout(() => proc.kill(), 300);
    }
  }

  // ─── Stdin write queue ────────────────────────────────────────────────────
  // A single flush loop processes writes one at a time, awaiting the 'drain'
  // event when stdin signals backpressure. This avoids accumulating one
  // 'drain' listener per send() call under sustained load.

  private _enqueueWrite(payload: string): void {
    if (this._writeQueue.length >= WRITE_QUEUE_MAX) {
      // Queue is full — fail the transport immediately rather than silently
      // dropping or buffering unbounded data.
      this._handleFatalIoError('stdin write queue overflow');
      return;
    }
    this._writeQueue.push(payload);
    if (!this._writeFlushing) {
      this._flushWriteQueue();
    }
  }

  private _flushWriteQueue(): void {
    if (!this._proc || this._writeQueue.length === 0) {
      this._writeFlushing = false;
      return;
    }

    this._writeFlushing = true;
    const payload = this._writeQueue.shift()!;

    const canWrite = this._proc.stdin.write(payload, (err) => {
      if (err) {
        this._handleFatalIoError(`stdin write error: ${err.message}`);
        return;
      }
      // Continue flushing after a successful write.
      setImmediate(() => this._flushWriteQueue());
    });

    if (!canWrite) {
      // stdin buffer is full — wait for drain before continuing.
      this._proc.stdin.once('drain', () => {
        this.outputChannel?.appendLine('[RpcTransport] stdin drained');
        this._flushWriteQueue();
      });
    }
  }

  /**
   * Called on unrecoverable I/O errors. Transitions the transport to a failed
   * state immediately so callers get fast rejections rather than waiting for
   * REQUEST_TIMEOUT_MS.
   */
  private _handleFatalIoError(reason: string): void {
    this.outputChannel?.appendLine(`[RpcTransport] fatal I/O error: ${reason}`);
    this._isRunning = false;
    this._writeQueue = [];
    this._writeFlushing = false;
    const proc = this._proc;
    this._proc = undefined;
    this._rejectAllPending(`fatal I/O error: ${reason}`);
    this._eventHandlers.clear();
    this._fireClose(`fatal I/O error: ${reason}`);
    if (proc) {
      try { proc.stdin.destroy(); } catch { /* ignore */ }
      setTimeout(() => proc.kill(), 300);
    }
  }

  // ─── JSONL reader ─────────────────────────────────────────────────────────

  private _attachJsonlReader(proc: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder('utf8');

    proc.stdout.on('data', (chunk: Buffer) => {
      const decoded = decoder.write(chunk);
      this._buf += decoded;
      this._bufBytes += Buffer.byteLength(decoded, 'utf8');
      this._drainLines();
    });

    proc.stdout.on('end', () => {
      const decoded = decoder.end();
      this._buf += decoded;
      this._bufBytes += Buffer.byteLength(decoded, 'utf8');
      this._drainLines(/* flush */ true);
    });
  }

  private _attachStderrReader(proc: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder('utf8');
    let stderrBuf = '';
    let stderrBufBytes = 0;

    proc.stderr.on('data', (chunk: Buffer) => {
      const decoded = decoder.write(chunk);
      stderrBuf += decoded;
      stderrBufBytes += Buffer.byteLength(decoded, 'utf8');

      // Hard cap using accurate byte count.
      if (stderrBufBytes > STDERR_BUF_MAX_BYTES) {
        this.outputChannel?.appendLine('[RpcTransport] stderr buffer exceeded limit — truncating');
        // Keep only the tail so we preserve the most recent output.
        stderrBuf = stderrBuf.slice(-Math.floor(stderrBuf.length / 2));
        stderrBufBytes = Buffer.byteLength(stderrBuf, 'utf8');
      }

      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '');
        stderrBufBytes -= Buffer.byteLength(stderrBuf.slice(0, nl + 1), 'utf8');
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.length > 0) {
          this.outputChannel?.appendLine(`[pi stderr] ${line}`);
        }
      }
    });

    proc.stderr.on('end', () => {
      stderrBuf += decoder.end();
      if (stderrBuf.length > 0) {
        const line = stderrBuf.replace(/\r?\n$/, '');
        if (line.length > 0) {
          this.outputChannel?.appendLine(`[pi stderr] ${line}`);
        }
      }
    });
  }

  private _drainLines(flush = false): void {
    // Hard cap using accurate byte count (correct for multibyte chars).
    if (this._bufBytes > this._stdoutBufMaxBytes) {
      this.outputChannel?.appendLine(
        `[RpcTransport] stdout buffer exceeded ${this._stdoutBufMaxBytes} bytes — terminating pi process`,
      );
      this._buf = '';
      this._bufBytes = 0;
      this.dispose();
      return;
    }
    while (true) {
      const nl = this._buf.indexOf('\n');
      if (nl === -1) break;

      let line = this._buf.slice(0, nl);
      const consumed = this._buf.slice(0, nl + 1);
      this._bufBytes -= Buffer.byteLength(consumed, 'utf8');
      this._buf = this._buf.slice(nl + 1);

      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) this._dispatchLine(line);
    }

    if (flush && this._buf.length > 0) {
      const line = this._buf.endsWith('\r') ? this._buf.slice(0, -1) : this._buf;
      this._buf = '';
      this._bufBytes = 0;
      if (line.length > 0) this._dispatchLine(line);
    }
  }

  // ─── Line dispatch ─────────────────────────────────────────────────────────

  private _dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const sample = line.length > 120 ? line.slice(0, 120) + '…' : line;
      this.outputChannel?.appendLine(`[RpcTransport] malformed JSON from pi: ${sample}`);
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
      return;
    }

    const msg = parsed as { type: string; id?: string };

    if (msg.type === 'response' && typeof msg.id === 'string') {
      const pending = this._pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        pending.resolve(msg as unknown as RpcResponse);
      }
    } else if (msg.type !== 'response') {
      // Size guard, but never for lifecycle/state events: dropping one (e.g. `agent_end`)
      // would strand the UI in a permanent "Agent is working…" state. Only bulk *content*
      // events are bounded here.
      if (!isCriticalEvent(msg.type) && Buffer.byteLength(line, 'utf8') > this._maxEventBytes) {
        this.outputChannel?.appendLine(
          `[RpcTransport] oversized event (${line.length} chars) dropped: type=${msg.type}`,
        );
        return;
      }

      // `agent_end` carries the whole turn's `messages` array — which grows with the context
      // window (megabytes at large contexts) yet Wingman never reads it (only the event's
      // `type`, to clear the streaming flag). Strip it so a big turn can neither bloat the
      // webview nor push a future line past the stdout buffer cap.
      let event = msg;
      if (msg.type === 'agent_end' && (msg as Record<string, unknown>).messages !== undefined) {
        const slim: Record<string, unknown> = { ...(msg as Record<string, unknown>) };
        delete slim.messages;
        event = slim as typeof msg;
      }

      for (const handler of this._eventHandlers) {
        try {
          handler(event as RpcEvent);
        } catch {
          // A misbehaving handler must not break the others.
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _handleExit(reason: string): void {
    if (!this._isRunning) return; // already handled
    this._isRunning = false;
    this._proc = undefined;
    this._buf = '';
    this._bufBytes = 0;
    this._writeQueue = [];
    this._writeFlushing = false;
    this._eventHandlers.clear();
    this.outputChannel?.appendLine(`[RpcTransport] exit: ${reason}`);
    this._rejectAllPending(reason);
    this._fireClose(reason);
  }

  private _rejectAllPending(reason: string): void {
    const err = new Error(`RpcTransport: ${reason}`);
    // Snapshot entries before iterating to avoid mutating the map mid-loop.
    const entries = Array.from(this._pending.entries());
    this._pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}
