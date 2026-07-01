/**
 * Unit tests for the reloadAgent command handler.
 *
 * Covers:
 *  - busy guard: no-ops with info message when pi is mid-turn.
 *  - confirm cancelled: controller.reload is never called.
 *  - happy path: locate → applyStatus → controller.reload called with located status.
 *  - not-found: applyStatus called, controller.reload still invoked (tears down).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => import('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { reloadAgent } from './reload';
import type { PiStatus } from '../shared/messages';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FOUND: PiStatus = { kind: 'found', path: '/usr/bin/pi' } as unknown as PiStatus;
const NOT_FOUND: PiStatus = { kind: 'not-found' } as unknown as PiStatus;
const VERSION_WARN: PiStatus = {
  kind: 'version-warning',
  path: '/usr/bin/pi',
  version: '0.1.0',
  minimum: '0.80.0',
} as unknown as PiStatus;

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    isStreaming: false,
    reload: vi.fn(async () => {}),
    outputChannel: { appendLine: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── busy guard ──────────────────────────────────────────────────────────────

describe('reloadAgent — busy guard', () => {
  it('shows info message and does not call locate or reload when streaming', async () => {
    const controller = makeController({ isStreaming: true });
    const locate = vi.fn(async () => FOUND);
    const applyStatus = vi.fn();
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await reloadAgent(controller as never, locate, applyStatus);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('cannot reload'));
    expect(locate).not.toHaveBeenCalled();
    expect(controller.reload).not.toHaveBeenCalled();
  });
});

// ─── confirmation cancelled ───────────────────────────────────────────────────

describe('reloadAgent — confirmation cancelled', () => {
  it('does not call reload when the user dismisses the modal', async () => {
    const controller = makeController();
    const locate = vi.fn(async () => FOUND);
    const applyStatus = vi.fn();
    // showWarningMessage returns undefined when dismissed (no button chosen).
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

    await reloadAgent(controller as never, locate, applyStatus);

    expect(locate).not.toHaveBeenCalled();
    expect(controller.reload).not.toHaveBeenCalled();
  });
});

// ─── happy path ───────────────────────────────────────────────────────────────

describe('reloadAgent — happy path', () => {
  it('calls locate, applyStatus, and controller.reload with the located status', async () => {
    const controller = makeController();
    const locate = vi.fn(async () => FOUND);
    const applyStatus = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reload' as never);
    // withProgress executes the task immediately in the mock.
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      async (_opts, task) => task({ report: vi.fn() } as never, undefined as never),
    );

    await reloadAgent(controller as never, locate, applyStatus);

    expect(locate).toHaveBeenCalledOnce();
    expect(applyStatus).toHaveBeenCalledWith(FOUND);
    expect(controller.reload).toHaveBeenCalledWith(FOUND);
  });

  it('also works for version-warning status', async () => {
    const controller = makeController();
    const locate = vi.fn(async () => VERSION_WARN);
    const applyStatus = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reload' as never);
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      async (_opts, task) => task({ report: vi.fn() } as never, undefined as never),
    );

    await reloadAgent(controller as never, locate, applyStatus);

    expect(applyStatus).toHaveBeenCalledWith(VERSION_WARN);
    expect(controller.reload).toHaveBeenCalledWith(VERSION_WARN);
  });
});

// ─── not-found ────────────────────────────────────────────────────────────────

describe('reloadAgent — not-found', () => {
  it('calls applyStatus and controller.reload even when pi is not found', async () => {
    const controller = makeController();
    const locate = vi.fn(async () => NOT_FOUND);
    const applyStatus = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reload' as never);
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      async (_opts, task) => task({ report: vi.fn() } as never, undefined as never),
    );

    await reloadAgent(controller as never, locate, applyStatus);

    expect(applyStatus).toHaveBeenCalledWith(NOT_FOUND);
    expect(controller.reload).toHaveBeenCalledWith(NOT_FOUND);
  });
});

// ─── locate error ─────────────────────────────────────────────────────────────

describe('reloadAgent — locate error', () => {
  it('shows an error message and does not call reload when locate throws', async () => {
    const controller = makeController();
    const locate = vi.fn(async () => { throw new Error('binary missing'); });
    const applyStatus = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reload' as never);
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      async (_opts, task) => task({ report: vi.fn() } as never, undefined as never),
    );
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

    await reloadAgent(controller as never, locate, applyStatus);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('binary missing'));
    expect(controller.reload).not.toHaveBeenCalled();
  });
});

// ─── streaming race ───────────────────────────────────────────────────────────

describe('reloadAgent — streaming race', () => {
  it('does not call reload when agent becomes busy after confirmation', async () => {
    // isStreaming is false at entry (passes the first guard), but flips to true
    // inside withProgress (simulates a prompt arriving during the modal).
    const controller = makeController({ isStreaming: false });
    const locate = vi.fn(async () => FOUND);
    const applyStatus = vi.fn();
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reload' as never);
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(
      async (_opts, task) => {
        // Flip streaming to true before the task body runs.
        (controller as Record<string, unknown>)['isStreaming'] = true;
        return task({ report: vi.fn() } as never, undefined as never);
      },
    );

    await reloadAgent(controller as never, locate, applyStatus);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('cannot reload'));
    expect(controller.reload).not.toHaveBeenCalled();
  });
});
