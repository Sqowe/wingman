/**
 * Unit tests for UiProtocolBridge (Phase 6).
 *
 * Tests that:
 *  - extension_ui_request events are consumed (not forwarded to the webview).
 *  - Blocking dialogs (select / confirm / input / editor) always receive a
 *    matching extension_ui_response — even on cancellation.
 *  - Fire-and-forget methods (notify / setStatus / setWidget / setTitle /
 *    set_editor_text) forward to VS Code / provider without crashing.
 *  - Unknown extension_ui_request methods are consumed but don't throw.
 *  - Non-UI events are NOT consumed (handleEvent returns false).
 *  - Malformed extension_ui_request events ARE consumed (returns true) but get no response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── VS Code API mock ─────────────────────────────────────────────────────────
// vi.mock() is hoisted before imports by Vitest's transform, but we use
// vi.hoisted() to create the mock functions so they exist before the factory
// runs.  This makes the hoisting intent explicit and avoids fragile ordering.

const {
  mockShowQuickPick,
  mockShowWarningMessage,
  mockShowInputBox,
  mockShowInformationMessage,
  mockShowErrorMessage,
  mockOpenTextDocument,
  mockShowTextDocument,
  mockExecuteCommand,
} = vi.hoisted(() => ({
  mockShowQuickPick: vi.fn<(items: string[], opts?: unknown) => Promise<string | undefined>>(),
  mockShowWarningMessage: vi.fn<(msg: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  mockShowInputBox: vi.fn<(opts?: unknown) => Promise<string | undefined>>(),
  mockShowInformationMessage: vi.fn<(msg: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  mockShowErrorMessage: vi.fn<(msg: string, ...rest: unknown[]) => Promise<string | undefined>>(),
  mockOpenTextDocument: vi.fn<(opts?: unknown) => Promise<{ getText: () => string; isClosed: boolean }>>(),
  mockShowTextDocument: vi.fn<(doc: unknown, opts?: unknown) => Promise<{ document: { getText: () => string; isClosed: boolean } }>>(),
  mockExecuteCommand: vi.fn<(cmd: string, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...(args as Parameters<typeof mockShowQuickPick>)),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...(args as Parameters<typeof mockShowWarningMessage>)),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...(args as Parameters<typeof mockShowInputBox>)),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...(args as Parameters<typeof mockShowInformationMessage>)),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...(args as Parameters<typeof mockShowErrorMessage>)),
    showTextDocument: (...args: unknown[]) => mockShowTextDocument(...(args as Parameters<typeof mockShowTextDocument>)),
  },
  workspace: {
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...(args as Parameters<typeof mockOpenTextDocument>)),
    fs: {
      writeFile: async () => undefined,
      delete: async () => undefined,
    },
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...(args as Parameters<typeof mockExecuteCommand>)),
  },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() { this.fn(); }
  },
  OutputChannel: class {},
}));

import { UiProtocolBridge } from './bridge';
import type { RpcEvent } from '../agent/transport';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOutputChannel() {
  return {
    appendLine: vi.fn<(line: string) => void>(),
  } as unknown as import('vscode').OutputChannel;
}

interface MockTransport {
  isRunning: boolean;
  sentRaw: Array<Record<string, unknown>>;
  sendRaw: (payload: Record<string, unknown>) => void;
}

function makeTransport(running = true): MockTransport {
  const t: MockTransport = {
    isRunning: running,
    sentRaw: [],
    sendRaw(payload) {
      // Match production RpcTransport behaviour: throw when not running.
      if (!t.isRunning) {
        throw new Error('RpcTransport: transport is not running');
      }
      t.sentRaw.push(payload);
    },
  };
  return t;
}

function makeProvider() {
  return {
    postUiStatus: vi.fn<(label: string, value: string | null) => void>(),
    postUiWidget: vi.fn<(id: string, options: string[] | null, value: string) => void>(),
    postUiTitle: vi.fn<(title: string) => void>(),
    postUiSetEditorText: vi.fn<(text: string) => void>(),
  };
}

function makeRequest(method: string, extra: Record<string, unknown> = {}): RpcEvent {
  return { type: 'extension_ui_request', id: 'test-id-1', method, ...extra } as RpcEvent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UiProtocolBridge', () => {
  let bridge: UiProtocolBridge;
  let transport: MockTransport;
  let provider: ReturnType<typeof makeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new UiProtocolBridge(makeOutputChannel());
    transport = makeTransport();
    provider = makeProvider();
    bridge.setTransport(transport as unknown as import('../agent/transport').AgentTransport);
    bridge.setProvider(provider as unknown as import('../webview/provider').WingmanViewProvider);
  });

  // ── Non-UI events pass through ──────────────────────────────────────────

  it('returns false for non-UI events', () => {
    expect(bridge.handleEvent({ type: 'agent_start' } as RpcEvent)).toBe(false);
    expect(bridge.handleEvent({ type: 'message_update', assistantMessageEvent: {} } as RpcEvent)).toBe(false);
    expect(bridge.handleEvent({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'y', args: {} } as RpcEvent)).toBe(false);
  });

  it('returns false for a response-type event (never a UI request)', () => {
    expect(bridge.handleEvent({ type: 'response', id: 'r1', command: 'prompt', success: true } as RpcEvent)).toBe(false);
  });

  // ── Malformed extension_ui_request ────────────────────────────────────

  it('returns true (consumed) for extension_ui_request missing id -- prevents webview leak', () => {
    expect(bridge.handleEvent({ type: 'extension_ui_request', method: 'select' } as RpcEvent)).toBe(true);
  });

  it('returns true (consumed) for extension_ui_request missing method -- prevents webview leak', () => {
    expect(bridge.handleEvent({ type: 'extension_ui_request', id: 'x' } as RpcEvent)).toBe(true);
  });

  it('does not send a response for malformed requests (no id to echo)', async () => {
    bridge.handleEvent({ type: 'extension_ui_request', method: 'select' } as RpcEvent);
    await Promise.resolve();
    expect(transport.sentRaw.length).toBe(0);
  });

  // ── select ────────────────────────────────────────────────────────────

  it('select: consumed immediately (returns true)', () => {
    mockShowQuickPick.mockResolvedValue('Allow');
    expect(bridge.handleEvent(makeRequest('select', { options: ['Allow', 'Block'] }))).toBe(true);
  });

  it('select: sends value response when user picks an option', async () => {
    mockShowQuickPick.mockResolvedValue('Allow');
    bridge.handleEvent(makeRequest('select', { options: ['Allow', 'Block'] }));
    // Let the microtask queue drain.
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      value: 'Allow',
    });
  });

  it('select: sends cancelled response when user dismisses', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    bridge.handleEvent(makeRequest('select', { options: ['Allow', 'Block'] }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      cancelled: true,
    });
  });

  // ── confirm ───────────────────────────────────────────────────────────

  it('confirm: consumed immediately (returns true)', () => {
    mockShowWarningMessage.mockResolvedValue('Yes');
    expect(bridge.handleEvent(makeRequest('confirm', { title: 'Are you sure?' }))).toBe(true);
  });

  it('confirm: sends confirmed:true when user clicks Yes', async () => {
    mockShowWarningMessage.mockResolvedValue('Yes');
    bridge.handleEvent(makeRequest('confirm', { title: 'Clear session?', message: 'All messages lost.' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      confirmed: true,
    });
  });

  it('confirm: maps title → modal primary line and message → detail', async () => {
    mockShowWarningMessage.mockResolvedValue('Yes');
    bridge.handleEvent(makeRequest('confirm', { title: 'Clear session?', message: 'All messages will be lost.' }));
    await vi.waitFor(() => expect(mockShowWarningMessage).toHaveBeenCalled());
    const [primary, opts] = mockShowWarningMessage.mock.calls[0];
    expect(primary).toBe('Clear session?');
    expect(opts).toMatchObject({ modal: true, detail: 'All messages will be lost.' });
  });

  it('confirm: uses the lone message as the primary line when no title is given', async () => {
    mockShowWarningMessage.mockResolvedValue('No');
    bridge.handleEvent(makeRequest('confirm', { message: 'Proceed anyway?' }));
    await vi.waitFor(() => expect(mockShowWarningMessage).toHaveBeenCalled());
    const [primary, opts] = mockShowWarningMessage.mock.calls[0];
    expect(primary).toBe('Proceed anyway?');
    expect((opts as { detail?: string }).detail).toBeUndefined();
  });

  it('confirm: sends confirmed:false when user clicks No', async () => {
    mockShowWarningMessage.mockResolvedValue('No');
    bridge.handleEvent(makeRequest('confirm', { title: 'Clear session?' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      confirmed: false,
    });
  });

  it('confirm: sends cancelled when user dismisses modal', async () => {
    mockShowWarningMessage.mockResolvedValue(undefined);
    bridge.handleEvent(makeRequest('confirm', { title: 'Clear session?' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      cancelled: true,
    });
  });

  // ── input ─────────────────────────────────────────────────────────────

  it('input: sends value response when user types text', async () => {
    mockShowInputBox.mockResolvedValue('my value');
    bridge.handleEvent(makeRequest('input', { title: 'Enter a value', placeholder: 'type...' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      value: 'my value',
    });
  });

  it('input: sends cancelled response when user cancels', async () => {
    mockShowInputBox.mockResolvedValue(undefined);
    bridge.handleEvent(makeRequest('input', { title: 'Enter a value' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      cancelled: true,
    });
  });

  // ── editor ────────────────────────────────────────────────────────────

  it('editor: sends value response on Submit', async () => {
    const fakeDoc = { getText: () => 'edited content\nline 2', isClosed: false, isDirty: false };
    const fakeEditor = { document: fakeDoc };
    mockOpenTextDocument.mockResolvedValue(fakeDoc);
    mockShowTextDocument.mockResolvedValue(fakeEditor);
    mockShowQuickPick.mockResolvedValue('Submit');
    mockExecuteCommand.mockResolvedValue(undefined);

    bridge.handleEvent(makeRequest('editor', { title: 'Edit text', prefill: 'Line 1\nLine 2' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      value: 'edited content\nline 2',
    });
  });

  it('editor: sends cancelled response on Cancel', async () => {
    const fakeDoc = { getText: () => '', isClosed: false, isDirty: false };
    const fakeEditor = { document: fakeDoc };
    mockOpenTextDocument.mockResolvedValue(fakeDoc);
    mockShowTextDocument.mockResolvedValue(fakeEditor);
    mockShowQuickPick.mockResolvedValue('Cancel');
    mockExecuteCommand.mockResolvedValue(undefined);

    bridge.handleEvent(makeRequest('editor', { title: 'Edit text' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      cancelled: true,
    });
  });

  it('editor: reverts a dirty temp doc before closing so no save prompt fires', async () => {
    // A file-backed temp doc with unsaved edits must be reverted to a clean
    // state, otherwise closeActiveEditor would pop a "Save changes?" dialog.
    const fakeDoc = { getText: () => 'edited', isClosed: false, isDirty: true };
    const fakeEditor = { document: fakeDoc };
    mockOpenTextDocument.mockResolvedValue(fakeDoc);
    mockShowTextDocument.mockResolvedValue(fakeEditor);
    mockShowQuickPick.mockResolvedValue('Submit');
    mockExecuteCommand.mockResolvedValue(undefined);

    bridge.handleEvent(makeRequest('editor', { title: 'Edit text' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));

    const commands = mockExecuteCommand.mock.calls.map((c) => c[0]);
    const revertIdx = commands.indexOf('workbench.action.revertActiveEditor');
    const closeIdx = commands.indexOf('workbench.action.closeActiveEditor');
    expect(revertIdx).toBeGreaterThanOrEqual(0); // revert was issued
    expect(closeIdx).toBeGreaterThanOrEqual(0); // close was issued
    expect(revertIdx).toBeLessThan(closeIdx); // revert happened before close
  });

  it('editor: does not revert a clean temp doc (nothing to discard)', async () => {
    const fakeDoc = { getText: () => '', isClosed: false, isDirty: false };
    const fakeEditor = { document: fakeDoc };
    mockOpenTextDocument.mockResolvedValue(fakeDoc);
    mockShowTextDocument.mockResolvedValue(fakeEditor);
    mockShowQuickPick.mockResolvedValue('Cancel');
    mockExecuteCommand.mockResolvedValue(undefined);

    bridge.handleEvent(makeRequest('editor', { title: 'Edit text' }));
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));

    const commands = mockExecuteCommand.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain('workbench.action.revertActiveEditor');
    expect(commands).toContain('workbench.action.closeActiveEditor');
  });

  // ── notify ────────────────────────────────────────────────────────────

  it('notify: consumed without sending a response', async () => {
    mockShowInformationMessage.mockResolvedValue(undefined);
    const consumed = bridge.handleEvent(makeRequest('notify', { message: 'Hello', notifyType: 'info' }));
    expect(consumed).toBe(true);
    await Promise.resolve(); // drain microtasks
    expect(transport.sentRaw.length).toBe(0);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Hello');
  });

  it('notify: uses showWarningMessage for notifyType warning', () => {
    bridge.handleEvent(makeRequest('notify', { message: 'Watch out', notifyType: 'warning' }));
    expect(mockShowWarningMessage).toHaveBeenCalledWith('Watch out');
  });

  it('notify: uses showErrorMessage for notifyType error', () => {
    bridge.handleEvent(makeRequest('notify', { message: 'Oops', notifyType: 'error' }));
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Oops');
  });

  // ── setStatus ─────────────────────────────────────────────────────────

  it('setStatus: forwards to provider and returns true', () => {
    const consumed = bridge.handleEvent(
      makeRequest('setStatus', { statusKey: 'my-ext', statusText: 'Turn 3' }),
    );
    expect(consumed).toBe(true);
    expect(provider.postUiStatus).toHaveBeenCalledWith('my-ext', 'Turn 3');
    expect(transport.sentRaw.length).toBe(0);
  });

  it('setStatus: forwards null text to clear the entry', () => {
    bridge.handleEvent(makeRequest('setStatus', { statusKey: 'my-ext' }));
    expect(provider.postUiStatus).toHaveBeenCalledWith('my-ext', null);
  });

  // ── setWidget ─────────────────────────────────────────────────────────

  it('setWidget: forwards to provider with lines and placement', () => {
    bridge.handleEvent(
      makeRequest('setWidget', {
        widgetKey: 'wk',
        widgetLines: ['line 1', 'line 2'],
        widgetPlacement: 'belowEditor',
      }),
    );
    expect(provider.postUiWidget).toHaveBeenCalledWith('wk', ['line 1', 'line 2'], 'belowEditor');
  });

  it('setWidget: forwards null lines to clear the widget', () => {
    bridge.handleEvent(makeRequest('setWidget', { widgetKey: 'wk' }));
    expect(provider.postUiWidget).toHaveBeenCalledWith('wk', null, 'aboveEditor');
  });

  // ── setTitle ──────────────────────────────────────────────────────────

  it('setTitle: forwards to provider', () => {
    bridge.handleEvent(makeRequest('setTitle', { title: 'pi — my project' }));
    expect(provider.postUiTitle).toHaveBeenCalledWith('pi — my project');
    expect(transport.sentRaw.length).toBe(0);
  });

  // ── set_editor_text ───────────────────────────────────────────────────

  it('set_editor_text: forwards to provider', () => {
    bridge.handleEvent(makeRequest('set_editor_text', { text: 'prefilled text' }));
    expect(provider.postUiSetEditorText).toHaveBeenCalledWith('prefilled text');
    expect(transport.sentRaw.length).toBe(0);
  });

  // ── Unknown method ────────────────────────────────────────────────────

  it('unknown method: consumed (returns true) and sends cancelled to prevent pi deadlock', async () => {
    const consumed = bridge.handleEvent(makeRequest('nonexistent_method'));
    expect(consumed).toBe(true);
    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toEqual({
      type: 'extension_ui_response',
      id: 'test-id-1',
      cancelled: true,
    });
  });

  // ── Transport not running ─────────────────────────────────────────────

  it('does not crash when transport is not running at response time', async () => {
    transport.isRunning = false;
    mockShowQuickPick.mockResolvedValue('Allow');
    bridge.handleEvent(makeRequest('select', { options: ['Allow'] }));
    await vi.waitFor(() =>
      (bridge as unknown as { _outputChannel: { appendLine: ReturnType<typeof vi.fn> } })
        ._outputChannel.appendLine.mock.calls.length > 0,
    );
    // Transport not running: sendRaw throws, bridge catches it. No response recorded.
    expect(transport.sentRaw.length).toBe(0);
  });

  it('logs and does not crash when sendRaw throws even with running transport', async () => {
    // Force sendRaw to throw despite isRunning=true (simulates proc missing).
    transport.sendRaw = () => { throw new Error('stdin write error'); };
    mockShowQuickPick.mockResolvedValue('Allow');
    bridge.handleEvent(makeRequest('select', { options: ['Allow'] }));
    const outputChannel = (bridge as unknown as { _outputChannel: { appendLine: ReturnType<typeof vi.fn> } })
      ._outputChannel;
    // Wait specifically for the 'sendResponse failed' log line (not just any log).
    await vi.waitFor(() => {
      const logged = outputChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('sendResponse failed'),
      );
      if (!logged) throw new Error('not yet logged');
    });
    const logged = outputChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('sendResponse failed'),
    );
    expect(logged).toBe(true);
  });

  // ── Timeout suppression ──────────────────────────────────────────────

  it('suppresses a late response when the request timeout has already fired', async () => {
    vi.useFakeTimers();
    // Simulate a select with a 100ms timeout.
    // The user responds *after* the timer fires.
    let resolvePick!: (v: string | undefined) => void;
    mockShowQuickPick.mockReturnValue(new Promise<string | undefined>((r) => { resolvePick = r; }));

    bridge.handleEvent(makeRequest('select', { options: ['Allow'], timeout: 100 }));

    // Advance past the timeout — request id is now marked as expired.
    vi.advanceTimersByTime(150);
    vi.clearAllTimers();
    vi.useRealTimers();

    // Now the user picks an option — response must be suppressed.
    resolvePick('Allow');
    await Promise.resolve(); // drain microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(transport.sentRaw.length).toBe(0);
  });

  it('allows a response when the user responds before the timeout fires', async () => {
    vi.useFakeTimers();
    mockShowQuickPick.mockResolvedValue('Allow');

    bridge.handleEvent(makeRequest('select', { options: ['Allow'], timeout: 5000 }));

    // Advance time but NOT past the timeout — user responds before deadline.
    vi.advanceTimersByTime(10);
    vi.clearAllTimers();
    vi.useRealTimers();

    await vi.waitFor(() => expect(transport.sentRaw.length).toBe(1));
    expect(transport.sentRaw[0]).toMatchObject({ value: 'Allow' });
  });

  // ── dispose ───────────────────────────────────────────────────────────

  it('does not send response after dispose', async () => {
    mockShowQuickPick.mockResolvedValue('Allow');
    bridge.handleEvent(makeRequest('select', { options: ['Allow'] }));
    bridge.dispose();
    // Let the async handler finish — it should see _disposed = true.
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.sentRaw.length).toBe(0);
  });
});

// ─── Reserved setStatus key (wingman:instructionFiles) ─────────────────────────────

describe('UiProtocolBridge — reserved setStatus key (wingman:instructionFiles)', () => {
  function makeSetStatusEvent(statusKey: string, statusText?: string) {
    return {
      type: 'extension_ui_request',
      id: 'r1',
      method: 'setStatus',
      statusKey,
      statusText,
    };
  }

  it('routes the reserved key to the callback instead of postUiStatus', () => {
    const received: Array<unknown> = [];
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      (info) => received.push(info),
    );
    const provider = { postUiStatus: vi.fn() };
    bridge2.setProvider(provider as never);
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:instructionFiles',
      JSON.stringify({ files: [{ path: '/a/AGENTS.md', scope: 'global', role: 'context' }] }),
    ) as never);
    expect(provider.postUiStatus).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect((received[0] as { files: unknown[] }).files).toHaveLength(1);
    bridge2.dispose();
  });

  it('calls callback with null for malformed JSON on the reserved key', () => {
    const received: Array<unknown> = [];
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      (info) => received.push(info),
    );
    bridge2.handleEvent(makeSetStatusEvent('wingman:instructionFiles', 'NOT JSON') as never);
    expect(received).toHaveLength(1);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('calls callback with null for unsupported payload', () => {
    const received: Array<unknown> = [];
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      (info) => received.push(info),
    );
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:instructionFiles',
      JSON.stringify({ unsupported: true }),
    ) as never);
    expect(received).toHaveLength(1);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('calls callback with null for error payload', () => {
    const received: Array<unknown> = [];
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      (info) => received.push(info),
    );
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:instructionFiles',
      JSON.stringify({ error: 'something went wrong' }),
    ) as never);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('routes every other statusKey through postUiStatus unaffected', () => {
    const received: Array<unknown> = [];
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      (info) => received.push(info),
    );
    const provider = { postUiStatus: vi.fn() };
    bridge2.setProvider(provider as never);
    bridge2.handleEvent(makeSetStatusEvent('some-other-key', 'hello') as never);
    expect(provider.postUiStatus).toHaveBeenCalledWith('some-other-key', 'hello');
    expect(received).toHaveLength(0);
    bridge2.dispose();
  });
});

// ─── Reserved setStatus key (wingman:claudeMemory) ───────────────────────────

describe('UiProtocolBridge — reserved setStatus key (wingman:claudeMemory)', () => {
  function makeSetStatusEvent(statusKey: string, statusText?: string) {
    return {
      type: 'extension_ui_request',
      id: 'm1',
      method: 'setStatus',
      statusKey,
      statusText,
    };
  }

  function makeBridge(onMemory: (info: unknown) => void) {
    return new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
      undefined,
      onMemory as never,
    );
  }

  it('routes the reserved key to the memory callback instead of postUiStatus', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    const provider = { postUiStatus: vi.fn() };
    bridge2.setProvider(provider as never);
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({
        dir: '/home/u/.claude/projects/x/memory',
        count: 2,
        files: [
          { path: '/home/u/.claude/projects/x/memory/a.md', title: 'Alpha' },
          { path: '/home/u/.claude/projects/x/memory/b.md', title: 'Beta' },
        ],
      }),
    ) as never);
    expect(provider.postUiStatus).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    const info = received[0] as { dir: string; count: number; files: unknown[] };
    expect(info.dir).toBe('/home/u/.claude/projects/x/memory');
    expect(info.count).toBe(2);
    expect(info.files).toHaveLength(2);
    bridge2.dispose();
  });

  it('drops malformed/out-of-dir file entries but keeps the reported total count', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({
        dir: '/mem',
        count: 3,
        files: [
          { path: '/mem/a.md', title: 'A' },
          { path: '/mem/b.md' }, // missing title
          { title: 'no path' }, // missing path
        ],
      }),
    ) as never);
    const info = received[0] as { count: number; files: unknown[] };
    // Only one entry is well-formed, but count reflects the true total (3).
    expect(info.files).toHaveLength(1);
    expect(info.count).toBe(3);
    bridge2.dispose();
  });

  it('drops entries whose path escapes the reported dir', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({
        dir: '/mem',
        count: 2,
        files: [
          { path: '/mem/a.md', title: 'A' },
          { path: '/etc/passwd', title: 'Escape' },
          { path: 'relative/b.md', title: 'Relative' },
        ],
      }),
    ) as never);
    const info = received[0] as { files: Array<{ path: string }> };
    expect(info.files).toHaveLength(1);
    expect(info.files[0].path).toBe('/mem/a.md');
    bridge2.dispose();
  });

  it('calls callback with null when dir is not absolute', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({ dir: 'relative/mem', count: 0, files: [] }),
    ) as never);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('clamps a negative/non-integer count to a safe value', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({
        dir: '/mem',
        count: -5,
        files: [{ path: '/mem/a.md', title: 'A' }],
      }),
    ) as never);
    const info = received[0] as { count: number };
    // Negative clamped, and never below the number of kept entries.
    expect(info.count).toBe(1);
    bridge2.dispose();
  });

  it('calls callback with null for malformed JSON', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent('wingman:claudeMemory', 'NOT JSON') as never);
    expect(received).toHaveLength(1);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('calls callback with null when dir is missing', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    bridge2.handleEvent(makeSetStatusEvent(
      'wingman:claudeMemory',
      JSON.stringify({ count: 0, files: [] }),
    ) as never);
    expect(received[0]).toBeNull();
    bridge2.dispose();
  });

  it('does not intercept the memory key when no callback is provided', () => {
    const bridge2 = new UiProtocolBridge(
      { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
    );
    const provider = { postUiStatus: vi.fn() };
    bridge2.setProvider(provider as never);
    // No memory callback wired: the reserved key is swallowed (returns), and must
    // NOT leak to the generic status strip.
    bridge2.handleEvent(makeSetStatusEvent('wingman:claudeMemory', '{"dir":"/m","files":[]}') as never);
    expect(provider.postUiStatus).not.toHaveBeenCalled();
    bridge2.dispose();
  });

  it('routes every other statusKey through postUiStatus unaffected', () => {
    const received: Array<unknown> = [];
    const bridge2 = makeBridge((info) => received.push(info));
    const provider = { postUiStatus: vi.fn() };
    bridge2.setProvider(provider as never);
    bridge2.handleEvent(makeSetStatusEvent('some-other-key', 'hi') as never);
    expect(provider.postUiStatus).toHaveBeenCalledWith('some-other-key', 'hi');
    expect(received).toHaveLength(0);
    bridge2.dispose();
  });
});
