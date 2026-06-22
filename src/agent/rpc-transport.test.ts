/**
 * Unit tests for RpcTransport's JSONL framing, response correlation,
 * request timeout, buffer caps, write-queue overflow, and env building.
 *
 * Framing tests exercise the parser in isolation by feeding synthetic chunks.
 * Env tests use the exported _buildChildEnvForTesting pure function directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import type { RpcResponse } from '../agent/transport';
import { _buildChildEnvForTesting } from '../agent/rpc-transport';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internals = any;

async function makeTransport() {
  const { RpcTransport } = await import('../agent/rpc-transport');
  const t = new RpcTransport('/fake/pi', '/fake/cwd');
  const i = t as Internals;
  const lines: string[] = [];
  i.outputChannel = { appendLine: (l: string) => lines.push(l), dispose: () => {} };
  return { t, i, lines };
}

/**
 * Feed raw string chunks into the transport's internal buffer and drain.
 * Simulates data arriving on stdout (already decoded from UTF-8).
 */
function feedChunks(i: Internals, ...chunks: string[]): void {
  for (const chunk of chunks) {
    i._buf += chunk;
    i._bufBytes += Buffer.byteLength(chunk, 'utf8');
    i._drainLines();
  }
}

/**
 * Feed raw Buffer chunks through StringDecoder, exactly as the real
 * _attachJsonlReader does. Use this for multibyte / binary boundary tests.
 */
function feedBufferChunks(i: Internals, ...chunks: Buffer[]): void {
  const decoder = new StringDecoder('utf8');
  for (const chunk of chunks) {
    const decoded = decoder.write(chunk);
    i._buf += decoded;
    i._bufBytes += Buffer.byteLength(decoded, 'utf8');
    i._drainLines();
  }
  // flush
  const tail = decoder.end();
  if (tail) {
    i._buf += tail;
    i._bufBytes += Buffer.byteLength(tail, 'utf8');
    i._drainLines();
  }
}

// ─── JSONL framing ────────────────────────────────────────────────────────────

describe('RpcTransport JSONL framing', () => {
  it('dispatches a complete line in one chunk', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    feedChunks(i, '{"type":"agent_start"}\n');
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('agent_start');
  });

  it('buffers a partial line across two chunks', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    feedChunks(i, '{"type":"agent_', 'start"}\n');
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('agent_start');
  });

  it('dispatches multiple lines from one chunk', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    feedChunks(i, '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    expect(events).toHaveLength(3);
    expect(events.map((e: any) => e.type)).toEqual(['a', 'b', 'c']);
  });

  it('strips trailing CR (CRLF line endings)', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    feedChunks(i, '{"type":"agent_start"}\r\n');
    expect(events).toHaveLength(1);
  });

  it('silently drops malformed JSON and logs to outputChannel', async () => {
    const { i, lines } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    feedChunks(i, 'not-json\n');
    expect(events).toHaveLength(0);
    expect(lines.some((l: string) => l.includes('malformed JSON'))).toBe(true);
  });

  it('flushes unterminated fragment on stream end', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));
    i._buf = '{"type":"agent_end"}';
    i._bufBytes = Buffer.byteLength(i._buf, 'utf8');
    i._drainLines(true);
    expect(events).toHaveLength(1);
  });

  it('handles a multibyte UTF-8 char (€, 3 bytes) split across Buffer chunks', async () => {
    const { i } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));

    // Build the full Buffer for the JSONL line containing '€'.
    const fullBuf = Buffer.from('{"type":"t","msg":"€"}\n', 'utf8');

    // '€' is 3 bytes (0xE2 0x82 0xAC). Find its position and split in the middle.
    const euroStart = fullBuf.indexOf(0xe2); // first byte of '€'
    expect(euroStart).toBeGreaterThan(0);

    const part1 = fullBuf.slice(0, euroStart + 1); // includes 0xE2 only
    const part2 = fullBuf.slice(euroStart + 1);    // 0x82 0xAC + rest

    feedBufferChunks(i, part1, part2);
    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe('t');
    expect((events[0] as any).msg).toBe('€');
  });
});

// ─── Response correlation ──────────────────────────────────────────────────────

describe('RpcTransport response correlation', () => {
  it('resolves a pending send() when a correlated response arrives', async () => {
    const { i } = await makeTransport();
    i._isRunning = true;
    i._proc = { stdin: { write: (_d: string, cb: () => void) => { cb(); return true; } } };

    const promise = i.send({ type: 'get_state' }) as Promise<RpcResponse>;
    const id = `req-${i._nextId - 1}`;

    feedChunks(
      i,
      JSON.stringify({ type: 'response', id, command: 'get_state', success: true }) + '\n',
    );

    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.command).toBe('get_state');
  });

  it('rejects pending requests when the transport disposes', async () => {
    const { t, i } = await makeTransport();
    i._isRunning = true;
    i._proc = {
      stdin: { write: () => true, destroy: () => {} },
      kill: () => {},
    };

    const promise = i.send({ type: 'get_state' });
    t.dispose();

    await expect(promise).rejects.toThrow('transport disposed');
  });
});

// ─── Request timeout ──────────────────────────────────────────────────────────

describe('RpcTransport request timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects a send() after 60 s with no response', async () => {
    const { i } = await makeTransport();
    i._isRunning = true;
    i._proc = { stdin: { write: (_d: string, cb: () => void) => { cb(); return true; } } };

    const promise = i.send({ type: 'get_state' });
    vi.advanceTimersByTime(60_001);

    await expect(promise).rejects.toThrow('timed out');
  });
});

// ─── Stdout buffer cap ────────────────────────────────────────────────────────

describe('RpcTransport stdout buffer cap', () => {
  it('disposes the transport when the stdout buffer exceeds 2 MB', async () => {
    const { t, i, lines } = await makeTransport();
    i._isRunning = true;
    i._proc = { stdin: { write: () => true, destroy: () => {} }, kill: () => {} };

    const disposeSpy = vi.spyOn(t, 'dispose');

    // 3 MB with no newline — exceeds the 2 MB cap.
    const bigChunk = 'x'.repeat(3 * 1024 * 1024);
    i._buf = bigChunk;
    i._bufBytes = Buffer.byteLength(bigChunk, 'utf8');
    i._drainLines();

    expect(disposeSpy).toHaveBeenCalled();
    expect(lines.some((l: string) => l.includes('exceeded'))).toBe(true);
  });
});

// ─── Oversized event ──────────────────────────────────────────────────────────

describe('RpcTransport oversized event dropping', () => {
  it('drops events larger than 512 KB and logs a diagnostic', async () => {
    const { i, lines } = await makeTransport();
    const events: unknown[] = [];
    i._eventHandlers.add((e: unknown) => events.push(e));

    const bigEvent = { type: 'message_update', data: 'x'.repeat(600_000) };
    feedChunks(i, JSON.stringify(bigEvent) + '\n');

    expect(events).toHaveLength(0);
    expect(lines.some((l: string) => l.includes('oversized event'))).toBe(true);
  });
});

// ─── Write queue overflow ─────────────────────────────────────────────────────

describe('RpcTransport write queue overflow', () => {
  it('calls _handleFatalIoError when queue exceeds WRITE_QUEUE_MAX', async () => {
    const { i } = await makeTransport();
    i._isRunning = true;
    i._proc = {
      stdin: {
        // Always signal backpressure; never emits drain.
        write: () => false,
        once: () => {},
        destroy: () => {},
      },
      kill: () => {},
    };

    const fatalSpy = vi.spyOn(i, '_handleFatalIoError');

    // Pre-fill the queue to WRITE_QUEUE_MAX (256).
    for (let n = 0; n < 256; n++) {
      i._writeQueue.push('x');
    }
    // One more enqueue should detect overflow.
    i._enqueueWrite('{"type":"prompt","id":"req-1"}\n');

    expect(fatalSpy).toHaveBeenCalledWith(expect.stringContaining('overflow'));
  });
});

// ─── onClose (unexpected death notification) ──────────────────────────────────

describe('RpcTransport onClose', () => {
  it('fires close handlers on unexpected process exit after start', async () => {
    const { t, i } = await makeTransport();
    i._isRunning = true;
    const calls: Array<{ reason: string }> = [];
    t.onClose((info: { reason: string }) => calls.push(info));

    i._handleExit('pi process closed (exit code 1)');

    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toContain('exit code 1');
  });

  it('fires close handlers on a fatal I/O error', async () => {
    const { t, i } = await makeTransport();
    i._isRunning = true;
    i._proc = { stdin: { destroy: () => {} }, kill: () => {} };
    const calls: Array<{ reason: string }> = [];
    t.onClose((info: { reason: string }) => calls.push(info));

    i._handleFatalIoError('stdin write error: boom');

    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toContain('boom');
  });

  it('does NOT fire close handlers on a deliberate dispose()', async () => {
    const { t, i } = await makeTransport();
    i._isRunning = true;
    i._proc = { stdin: { write: () => true, destroy: () => {} }, kill: () => {} };
    const calls: unknown[] = [];
    t.onClose(() => calls.push(1));

    t.dispose();

    expect(calls).toHaveLength(0);
  });

  it('fires close handlers at most once', async () => {
    const { i } = await makeTransport();
    i._isRunning = true;
    const calls: unknown[] = [];
    (i as Internals).onClose(() => calls.push(1));

    i._handleExit('first');
    i._isRunning = true; // simulate a stray second exit signal
    i._handleExit('second');

    expect(calls).toHaveLength(1);
  });

  it('unregisters a close handler when its disposable is disposed', async () => {
    const { t, i } = await makeTransport();
    i._isRunning = true;
    const calls: unknown[] = [];
    const sub = t.onClose(() => calls.push(1));

    sub.dispose();
    i._handleExit('x');

    expect(calls).toHaveLength(0);
  });
});

// ─── buildChildEnv (pure function, no process mutation) ───────────────────────

describe('buildChildEnv', () => {
  it('forwards PATH on Linux/macOS', () => {
    const result = _buildChildEnvForTesting('linux', { PATH: '/usr/bin', SECRET: 'hidden' });
    expect(result.PATH).toBe('/usr/bin');
    expect(result.SECRET).toBeUndefined();
  });

  it('forwards Path (Windows casing) when platform is win32', () => {
    const result = _buildChildEnvForTesting('win32', { Path: 'C:\\Windows\\System32' });
    // The original key 'Path' should be present in the output.
    expect(result['Path']).toBe('C:\\Windows\\System32');
  });

  it('forwards SYSTEMROOT on Windows (case-insensitive)', () => {
    const result = _buildChildEnvForTesting('win32', { SystemRoot: 'C:\\Windows' });
    expect(result['SystemRoot']).toBe('C:\\Windows');
  });

  it('forwards PI_* vars on both platforms', () => {
    const r1 = _buildChildEnvForTesting('linux', { PI_TOKEN: 'abc' });
    const r2 = _buildChildEnvForTesting('win32', { PI_TOKEN: 'abc' });
    expect(r1.PI_TOKEN).toBe('abc');
    expect(r2.PI_TOKEN).toBe('abc');
  });

  it('does not forward arbitrary vars', () => {
    const result = _buildChildEnvForTesting('linux', {
      SECRET_KEY: 'super-secret',
      VSCODE_SOMETHING: 'internal',
    });
    expect(result.SECRET_KEY).toBeUndefined();
    expect(result.VSCODE_SOMETHING).toBeUndefined();
  });

  it('ensures HOME is always set, using homeDir param when missing', () => {
    const result = _buildChildEnvForTesting('linux', {}, '/home/testuser');
    expect(result.HOME).toBe('/home/testuser');
  });

  it('forwards proxy vars', () => {
    const result = _buildChildEnvForTesting('linux', {
      HTTP_PROXY: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost',
    });
    expect(result.HTTP_PROXY).toBe('http://proxy:3128');
    expect(result.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(result.NO_PROXY).toBe('localhost');
  });
});
