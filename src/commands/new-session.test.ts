/**
 * Unit tests for the newSession command handler.
 *
 * The interesting part is the model/thinking re-apply: pi's `new_session`
 * rebuilds the runtime and re-resolves both halves from its global settings,
 * and its RPC exposes no way to persist a selection, so Wingman has to
 * remember and re-apply the choice itself. See src/agent/model-memory.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => import('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { newSession } from './new-session';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    isStreaming: false,
    sendCommand: vi.fn(async () => ({ type: 'response', success: true, command: 'new_session' })),
    runSuppressingModelRefresh: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    restoreModelChoice: vi.fn(async () => {}),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── happy path ──────────────────────────────────────────────────────────────

describe('newSession — success', () => {
  it('sends new_session, re-applies the remembered choice, then resets the view', async () => {
    const calls: string[] = [];
    const controller = makeController({
      sendCommand: vi.fn(async () => {
        calls.push('new_session');
        return { type: 'response', success: true, command: 'new_session' };
      }),
      restoreModelChoice: vi.fn(async () => { calls.push('restore'); }),
      onNewSession: vi.fn(() => { calls.push('onNewSession'); }),
    });

    await newSession(controller as never);

    expect(controller.sendCommand).toHaveBeenCalledWith({ type: 'new_session' });
    expect(calls).toEqual(['new_session', 'restore', 'onNewSession']);
  });

  it('clears the webview transcript', async () => {
    const controller = makeController();
    await newSession(controller as never);
    expect(controller.onNewSession).toHaveBeenCalledWith({ clearTranscript: true });
  });

  it('wraps the sends in runSuppressingModelRefresh so the default never flashes', async () => {
    const controller = makeController();
    await newSession(controller as never);
    expect(controller.runSuppressingModelRefresh).toHaveBeenCalledTimes(1);
  });
});

// ─── failure ─────────────────────────────────────────────────────────────────

describe('newSession — failure', () => {
  it('shows an error, and does not restore or reset the view', async () => {
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const controller = makeController({
      sendCommand: vi.fn(async () => ({
        type: 'response', success: false, command: 'new_session', error: 'cancelled',
      })),
    });

    await newSession(controller as never);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    expect(controller.restoreModelChoice).not.toHaveBeenCalled();
    expect(controller.onNewSession).not.toHaveBeenCalled();
    // A genuinely failed new_session is an error, not a warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('surfaces pi\'s error text verbatim', async () => {
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const controller = makeController({
      sendCommand: vi.fn(async () => ({
        type: 'response', success: false, command: 'new_session', error: 'no API key for provider',
      })),
    });

    await newSession(controller as never);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no API key for provider'));
  });
});

// ─── thrown transport error ──────────────────────────────────────────────────

describe('newSession — transport throws', () => {
  it('shows an error and does not reset the view', async () => {
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const controller = makeController({
      sendCommand: vi.fn(async () => { throw new Error('transport down'); }),
    });

    await newSession(controller as never);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('transport down'));
    expect(controller.onNewSession).not.toHaveBeenCalled();
  });
});

// ─── non-fatal restore failure ───────────────────────────────────────────────
//
// pi has already created the session by the time the re-apply runs. If it is
// rejected, the new session is real and the UI must still be reset — reporting
// "new session failed" and leaving a stale transcript behind would be wrong on
// both counts.

describe('newSession — the re-apply fails', () => {
  it('warns, but still resets the view', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const controller = makeController({
      restoreModelChoice: vi.fn(async () => { throw new Error('Model not found: p/gone'); }),
    });

    await newSession(controller as never);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Model not found: p/gone'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('new session started'));
    expect(controller.onNewSession).toHaveBeenCalledWith({ clearTranscript: true });
    // Not reported as a new-session failure — the session exists.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('does not let the restore failure escape the suppress window', async () => {
    const controller = makeController({
      restoreModelChoice: vi.fn(async () => { throw new Error('boom'); }),
    });

    await expect(newSession(controller as never)).resolves.toBeUndefined();
  });
});
