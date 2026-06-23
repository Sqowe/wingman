/**
 * Unit tests for WingmanViewProvider message routing.
 *
 * Covers:
 *  - Runtime validation (_validateMessage): known types pass, unknown/malformed drop.
 *  - copyToClipboard: calls vscode.env.clipboard.writeText; error is caught and logged.
 *  - abortTurn: calls controller.sendAbort().
 *  - openExternal: opens valid http/https/mailto URLs; rejects unsafe schemes.
 *  - Size limit: oversized clipboard payload is dropped by validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock must be called before any import that depends on 'vscode'. Vitest
// hoists vi.mock() calls above imports, so this explicit factory ensures the
// __mocks__/vscode stub is used regardless of ESM resolution order.
vi.mock('vscode', async () => {
  const mod = await import('../__mocks__/vscode');
  return mod;
});

import * as vscode from 'vscode';
import { WingmanViewProvider } from './provider';
import type { AgentController } from '../agent/controller';

// ─── Helpers: flush microtask queue ──────────────────────────────────────────

/** Flush the microtask queue (Promises, async/await continuations). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Stub the webview surface ─────────────────────────────────────────────────

function makeWebviewView() {
  let messageHandler: ((msg: unknown) => void) | undefined;
  const postMessage = vi.fn();

  const webview = {
    options: {} as vscode.WebviewOptions,
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (handler: (msg: unknown) => void) => {
      messageHandler = handler;
      return new vscode.Disposable(() => { messageHandler = undefined; });
    },
    postMessage,
  };

  const view = {
    webview,
    onDidDispose: (_cb: () => void) => new vscode.Disposable(() => {}),
  } as unknown as vscode.WebviewView;

  const sendMessage = (msg: unknown) => {
    if (messageHandler) messageHandler(msg);
  };

  return { view, webview, sendMessage, postMessage };
}

// ─── Minimal AgentController stub ────────────────────────────────────────────

function makeController(opts?: { abortShouldThrow?: boolean }) {
  return {
    outputChannel: vscode.window.createOutputChannel('test'),
    isStreaming: false,
    sendAbort: vi.fn(async () => {
      if (opts?.abortShouldThrow) throw new Error('transport gone');
    }),
    sendPrompt: vi.fn(async (_text: string) => {}),
    sendCommand: vi.fn(async () => ({ type: 'response' as const, success: true })),
    getCommands: vi.fn(async () => {}),
  };
}

// ─── resolveProvider helper ───────────────────────────────────────────────────

function resolveProvider(opts?: Parameters<typeof makeController>[0]) {
  const { view, sendMessage, postMessage } = makeWebviewView();
  const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
  const controller = makeController(opts);
  provider.setController(controller as unknown as AgentController);
  provider.resolveWebviewView(
    view,
    {} as vscode.WebviewViewResolveContext,
    { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
  );
  // Signal ready so the provider accepts subsequent messages.
  sendMessage({ type: 'ready' });
  return { provider, controller, sendMessage, postMessage };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WingmanViewProvider — runtime message validation', () => {
  it('drops null payload', () => {
    const { sendMessage } = resolveProvider();
    expect(() => sendMessage(null)).not.toThrow();
  });

  it('drops payload with unknown type', () => {
    const { sendMessage } = resolveProvider();
    expect(() => sendMessage({ type: 'unknownType', foo: 'bar' })).not.toThrow();
  });

  it('drops payload missing required field (copyToClipboard without text)', () => {
    const { sendMessage } = resolveProvider();
    expect(() => sendMessage({ type: 'copyToClipboard' })).not.toThrow();
  });

  it('drops non-object payload', () => {
    const { sendMessage } = resolveProvider();
    expect(() => sendMessage('hello')).not.toThrow();
  });

  it('drops payload with non-string type', () => {
    const { sendMessage } = resolveProvider();
    expect(() => sendMessage({ type: 42 })).not.toThrow();
  });

  it('drops messages received before the webview sends ready', () => {
    const { view } = makeWebviewView();
    let capturedHandler: ((msg: unknown) => void) | undefined;
    const webview = view.webview as unknown as {
      onDidReceiveMessage: (h: (m: unknown) => void) => vscode.Disposable;
    };
    const origOnMsg = webview.onDidReceiveMessage.bind(webview);
    webview.onDidReceiveMessage = (h) => {
      capturedHandler = h;
      return origOnMsg(h);
    };

    const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
    const controller = makeController();
    provider.setController(controller as unknown as AgentController);
    provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );
    // Send abortTurn before ready — should be dropped.
    if (capturedHandler) capturedHandler({ type: 'abortTurn' });
    expect(controller.sendAbort).not.toHaveBeenCalled();
  });

  it('drops non-ready messages after dispose and re-resolve (before new ready)', () => {
    // First resolve + ready cycle.
    const { view: view1, sendMessage: send1 } = makeWebviewView();
    const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
    const controller = makeController();
    provider.setController(controller as unknown as AgentController);

    let disposeCallback: (() => void) | undefined;
    const origOnDidDispose = view1.onDidDispose.bind(view1);
    (view1 as unknown as { onDidDispose: typeof view1.onDidDispose }).onDidDispose = (cb) => {
      disposeCallback = cb;
      return origOnDidDispose(cb);
    };

    provider.resolveWebviewView(
      view1,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );
    send1({ type: 'ready' });

    // Simulate webview disposal (panel hidden/closed).
    disposeCallback?.();

    // Re-resolve with a fresh webview (user re-opens the panel).
    const { view: view2, sendMessage: send2 } = makeWebviewView();
    provider.resolveWebviewView(
      view2,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );

    // abortTurn before new ready — must be dropped.
    send2({ type: 'abortTurn' });
    expect(controller.sendAbort).not.toHaveBeenCalled();

    // After ready, it should go through.
    send2({ type: 'ready' });
    send2({ type: 'abortTurn' });
    expect(controller.sendAbort).toHaveBeenCalledTimes(1);
  });
});

describe('WingmanViewProvider — copyToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls clipboard.writeText with the provided text', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue();
    sendMessage({ type: 'copyToClipboard', text: 'hello clipboard' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledWith('hello clipboard');
  });

  it('does not throw when clipboard.writeText rejects', async () => {
    const { sendMessage } = resolveProvider();
    vi.spyOn(vscode.env.clipboard, 'writeText').mockRejectedValue(new Error('no clipboard'));
    expect(() => sendMessage({ type: 'copyToClipboard', text: 'x' })).not.toThrow();
    await flushMicrotasks();
  });

  it('drops oversized clipboard payloads (> MAX_CLIPBOARD_BYTES)', () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue();
    // 5 MB + 1 byte — constructed cheaply via repeat of a substring.
    const oversized = 'a'.repeat(5_242_881);
    sendMessage({ type: 'copyToClipboard', text: oversized });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rate-limits bursts: second copy within 200ms is ignored', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue();
    sendMessage({ type: 'copyToClipboard', text: 'first' });
    // Send immediately — still within the 200 ms rate-limit window.
    sendMessage({ type: 'copyToClipboard', text: 'second' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('first');
  });
});

describe('WingmanViewProvider — abortTurn', () => {
  it('calls controller.sendAbort()', async () => {
    const { controller, sendMessage } = resolveProvider();
    sendMessage({ type: 'abortTurn' });
    await flushMicrotasks();
    expect(controller.sendAbort).toHaveBeenCalledTimes(1);
  });
});

describe('WingmanViewProvider — openExternal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a valid https URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'https://example.com/path' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('opens a valid http URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'http://example.com' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('opens a mailto URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'mailto:user@example.com' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops a javascript: URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'javascript:alert(1)' });
    await flushMicrotasks();
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops a data: URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'data:text/html,<h1>x</h1>' });
    await flushMicrotasks();
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops an invalid URL', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'not a url at all' });
    await flushMicrotasks();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not produce an unhandled rejection when openExternal rejects', async () => {
    const { sendMessage } = resolveProvider();
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('os error'));
    expect(() =>
      sendMessage({ type: 'openExternal', url: 'https://example.com' }),
    ).not.toThrow();
    await flushMicrotasks();
  });

  it('drops a URL exceeding 2048 characters', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    sendMessage({ type: 'openExternal', url: longUrl });
    await flushMicrotasks();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rate-limits bursts: second openExternal within 500ms is ignored', async () => {
    const { sendMessage } = resolveProvider();
    const spy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    sendMessage({ type: 'openExternal', url: 'https://example.com/first' });
    sendMessage({ type: 'openExternal', url: 'https://example.com/second' });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('WingmanViewProvider — prompt size enforcement', () => {
  it('rejects a prompt exceeding MAX_PROMPT_BYTES with promptRejected', async () => {
    const { sendMessage, postMessage } = resolveProvider();
    // Build a string that exceeds 32 KB when UTF-8 encoded.
    const oversized = 'a'.repeat(32_769);
    sendMessage({ type: 'sendPrompt', text: oversized });
    await flushMicrotasks();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'promptRejected', reason: 'too-large' }),
    );
  });
});

describe('WingmanViewProvider — session stats / status bar wiring', () => {
  it('calls onSessionStats callback with stats when postSessionStats is called', () => {
    const { provider } = resolveProvider();
    const cb = vi.fn();
    provider.onSessionStats(cb);
    const stats = { totalTokens: 100, totalCost: 0.002, totalMessages: 3 };
    provider.postSessionStats(stats);
    expect(cb).toHaveBeenCalledWith(stats);
  });

  it('calls onSessionStats with null on session reset (onNewSession)', () => {
    // Simulate what AgentController.onNewSession() does: posts null stats.
    const { provider } = resolveProvider();
    const cb = vi.fn();
    provider.onSessionStats(cb);
    provider.postSessionStats(null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('does not throw when no onSessionStats callback is registered', () => {
    const { provider } = resolveProvider();
    expect(() => provider.postSessionStats({ totalTokens: 1, totalCost: 0, totalMessages: 1 })).not.toThrow();
    expect(() => provider.postSessionStats(null)).not.toThrow();
  });
});

describe('WingmanViewProvider — commands list flow', () => {
  it('calls controller.getCommands() on ready when no commands are cached', () => {
    const { controller } = resolveProvider();
    // resolveProvider() already sends ready — getCommands must have been called.
    expect(controller.getCommands).toHaveBeenCalledTimes(1);
  });

  it('posts cached commandsList on ready when commands are already available', () => {
    const { view, sendMessage, postMessage } = makeWebviewView();
    const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
    const controller = makeController();
    provider.setController(controller as unknown as AgentController);

    // Pre-populate the commands cache before the webview signals ready.
    const cmds = [{ name: '/hello', description: 'Say hello' }];
    provider.postCommandsList(cmds);

    provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );
    sendMessage({ type: 'ready' });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'commandsList', commands: cmds }),
    );
    // Should NOT trigger a fresh fetch when cache is populated.
    expect(controller.getCommands).not.toHaveBeenCalled();
  });

  it('calls controller.getCommands() when webview sends requestCommands', async () => {
    const { controller, sendMessage } = resolveProvider();
    const callsBefore = (controller.getCommands as ReturnType<typeof vi.fn>).mock.calls.length;
    sendMessage({ type: 'requestCommands' });
    await flushMicrotasks();
    expect(controller.getCommands).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it('does not trigger a fetch on ready when commands cache is populated', () => {
    const { view, sendMessage } = makeWebviewView();
    const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
    const controller = makeController();
    provider.setController(controller as unknown as AgentController);
    provider.postCommandsList([{ name: '/foo', description: 'bar' }]);
    provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );
    sendMessage({ type: 'ready' });
    expect(controller.getCommands).not.toHaveBeenCalled();
  });
});

describe('WingmanViewProvider — session reset', () => {
  it('posts a sessionReset message to the webview when ready', () => {
    const { provider, postMessage } = resolveProvider();
    provider.postSessionReset();
    expect(postMessage).toHaveBeenCalledWith({ type: 'sessionReset' });
  });

  it('does not post sessionReset before the webview is ready (nothing to clear)', () => {
    const { view, postMessage } = makeWebviewView();
    const provider = new WingmanViewProvider(vscode.Uri.parse('vscode-resource://ext'));
    provider.setController(makeController() as unknown as AgentController);
    provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => {}) },
    );
    // No 'ready' sent yet.
    provider.postSessionReset();
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'sessionReset' });
  });
});

describe('WingmanViewProvider — new-session shortcut forwarding', () => {
  it('runs the newSession command when the webview forwards the shortcut', () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const { sendMessage } = resolveProvider();
    sendMessage({ type: 'newSession' });
    expect(exec).toHaveBeenCalledWith('sqoweWingman.newSession');
    exec.mockRestore();
  });
});
