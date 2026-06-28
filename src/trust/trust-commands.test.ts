/**
 * Unit tests for src/trust/trust-commands.ts (Phase 8).
 *
 * Covers the VS Code-facing orchestration:
 *  - showTrustPrompt: modal answer → outcome + persistence, save-failure path.
 *  - promptForTrust: maps evaluateTrust results to --approve / --no-approve,
 *    shows the modal only on needs-prompt, and never throws.
 *  - registerTrustCommands: selectFolder + trustProject command behaviour.
 *
 * The pure fs helpers in project-trust.ts are mocked here — their own logic is
 * covered by project-trust.test.ts. These tests focus on the decision wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockShowWarningMessage,
  mockShowInformationMessage,
  mockShowQuickPick,
  mockRegisterCommand,
  registeredCommands,
} = vi.hoisted(() => {
  const registry = new Map<string, (...args: unknown[]) => unknown>();
  return {
    mockShowWarningMessage: vi.fn<(msg: string, ...rest: unknown[]) => Promise<string | undefined>>(),
    mockShowInformationMessage: vi.fn<(msg: string, ...rest: unknown[]) => Promise<string | undefined>>(),
    mockShowQuickPick: vi.fn<(items: unknown[], opts?: unknown) => Promise<unknown>>(),
    mockRegisterCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registry.set(id, handler);
      return { dispose() {} };
    }),
    registeredCommands: registry,
  };
});

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...(args as Parameters<typeof mockShowWarningMessage>)),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...(args as Parameters<typeof mockShowInformationMessage>)),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...(args as Parameters<typeof mockShowQuickPick>)),
  },
  workspace: {
    workspaceFolders: undefined as undefined | { uri: { fsPath: string }; name: string }[],
  },
  commands: {
    registerCommand: (...args: unknown[]) => mockRegisterCommand(...(args as Parameters<typeof mockRegisterCommand>)),
  },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() { this.fn(); }
  },
}));

// project-trust pure helpers — stubbed so we control trust evaluation/persistence.
const { mockEvaluateTrust, mockHasProjectResources, mockSaveTrustDecision } = vi.hoisted(() => ({
  mockEvaluateTrust: vi.fn(),
  mockHasProjectResources: vi.fn(),
  mockSaveTrustDecision: vi.fn(),
}));

vi.mock('./project-trust', () => ({
  evaluateTrust: (...a: unknown[]) => mockEvaluateTrust(...a),
  hasProjectResources: (...a: unknown[]) => mockHasProjectResources(...a),
  saveTrustDecision: (...a: unknown[]) => mockSaveTrustDecision(...a),
}));

import * as vscode from 'vscode';
import {
  showTrustPrompt,
  promptForTrust,
  registerTrustCommands,
} from './trust-commands';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setWorkspaceFolders(paths: string[]): void {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = paths.map((p) => ({
    uri: { fsPath: p },
    name: p.split('/').pop() ?? p,
  }));
}

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    activeFolderPath: '/proj',
    setTrustDecision: vi.fn(),
    setActiveFolderPath: vi.fn(async () => {}),
    forceRestart: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeContext() {
  return {
    subscriptions: [] as unknown[],
    workspaceState: { update: vi.fn(async () => {}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredCommands.clear();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
});

// ─── showTrustPrompt ────────────────────────────────────────────────────────

describe('showTrustPrompt', () => {
  it('shows a modal warning with Trust / Don\'t Trust choices', async () => {
    mockShowWarningMessage.mockResolvedValueOnce('Trust');
    await showTrustPrompt('/path/to/myproj');
    const [msg, opts, ...choices] = mockShowWarningMessage.mock.calls[0];
    expect(String(msg)).toContain('myproj');
    expect(opts).toEqual({ modal: true });
    expect(choices).toEqual(['Trust', "Don't Trust"]);
  });

  it('persists trust=true and returns trusted when the user clicks Trust', async () => {
    mockShowWarningMessage.mockResolvedValueOnce('Trust');
    const result = await showTrustPrompt('/proj');
    expect(mockSaveTrustDecision).toHaveBeenCalledWith('/proj', true);
    expect(result).toEqual({ outcome: 'trusted', persisted: true });
  });

  it('persists trust=false and returns denied when the user declines', async () => {
    mockShowWarningMessage.mockResolvedValueOnce("Don't Trust");
    const result = await showTrustPrompt('/proj');
    expect(mockSaveTrustDecision).toHaveBeenCalledWith('/proj', false);
    expect(result).toEqual({ outcome: 'denied', persisted: true });
  });

  it('returns dismissed without persisting when the dialog is closed', async () => {
    mockShowWarningMessage.mockResolvedValueOnce(undefined);
    const result = await showTrustPrompt('/proj');
    expect(mockSaveTrustDecision).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'dismissed', persisted: false });
  });

  it('returns trusted-but-not-persisted when saving fails on Trust', async () => {
    mockShowWarningMessage.mockResolvedValueOnce('Trust');
    mockSaveTrustDecision.mockImplementationOnce(() => { throw new Error('EACCES'); });
    const result = await showTrustPrompt('/proj');
    expect(result).toEqual({ outcome: 'trusted', persisted: false });
    // A follow-up warning is surfaced (the modal call is #1, the warning is #2).
    expect(mockShowWarningMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns denied-but-not-persisted when saving fails on Don\'t Trust', async () => {
    mockShowWarningMessage.mockResolvedValueOnce("Don't Trust");
    mockSaveTrustDecision.mockImplementationOnce(() => { throw new Error('EROFS'); });
    const result = await showTrustPrompt('/proj');
    expect(result).toEqual({ outcome: 'denied', persisted: false });
  });
});

// ─── promptForTrust ─────────────────────────────────────────────────────────

describe('promptForTrust', () => {
  it('returns no flag and shows no modal when there are no project resources', async () => {
    mockEvaluateTrust.mockReturnValueOnce({ kind: 'no-resources' });
    const result = await promptForTrust('/proj');
    expect(result).toEqual({ arg: undefined, persisted: false });
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it('returns --approve from a saved trusted decision (no modal)', async () => {
    mockEvaluateTrust.mockReturnValueOnce({ kind: 'saved', trusted: true });
    const result = await promptForTrust('/proj');
    expect(result).toEqual({ arg: '--approve', persisted: true });
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it('returns --no-approve from a saved untrusted decision (no modal)', async () => {
    mockEvaluateTrust.mockReturnValueOnce({ kind: 'saved', trusted: false });
    const result = await promptForTrust('/proj');
    expect(result).toEqual({ arg: '--no-approve', persisted: true });
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it('shows the modal on needs-prompt and returns --approve when trusted', async () => {
    mockEvaluateTrust.mockReturnValueOnce({ kind: 'needs-prompt' });
    mockShowWarningMessage.mockResolvedValueOnce('Trust');
    const result = await promptForTrust('/proj');
    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ arg: '--approve', persisted: true });
  });

  it('returns --no-approve (not persisted) when the prompt is dismissed', async () => {
    mockEvaluateTrust.mockReturnValueOnce({ kind: 'needs-prompt' });
    mockShowWarningMessage.mockResolvedValueOnce(undefined);
    const result = await promptForTrust('/proj');
    expect(result).toEqual({ arg: '--no-approve', persisted: false });
  });

  it('falls back to --no-approve when evaluateTrust throws', async () => {
    mockEvaluateTrust.mockImplementationOnce(() => { throw new Error('boom'); });
    const result = await promptForTrust('/proj');
    expect(result).toEqual({ arg: '--no-approve', persisted: false });
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });
});

// ─── registerTrustCommands ──────────────────────────────────────────────────

describe('registerTrustCommands', () => {
  it('registers selectFolder and trustProject', () => {
    const ctx = makeContext();
    const controller = makeController();
    registerTrustCommands(ctx as never, controller as never, () => undefined);
    expect(registeredCommands.has('sqoweWingman.selectFolder')).toBe(true);
    expect(registeredCommands.has('sqoweWingman.trustProject')).toBe(true);
    expect(ctx.subscriptions).toHaveLength(2);
  });

  describe('selectFolder', () => {
    function setup(folders: string[], controllerOverrides: Record<string, unknown> = {}) {
      const ctx = makeContext();
      const controller = makeController(controllerOverrides);
      registerTrustCommands(ctx as never, controller as never, () => ({ kind: 'found', path: '/usr/bin/pi' } as never));
      setWorkspaceFolders(folders);
      const handler = registeredCommands.get('sqoweWingman.selectFolder')!;
      return { ctx, controller, handler };
    }

    it('informs the user and does nothing when no folders are open', async () => {
      const { controller, handler } = setup([]);
      await handler();
      expect(mockShowInformationMessage).toHaveBeenCalled();
      expect(controller.setActiveFolderPath).not.toHaveBeenCalled();
    });

    it('informs the user and does nothing for a single-folder workspace', async () => {
      const { controller, handler } = setup(['/only']);
      await handler();
      expect(mockShowInformationMessage).toHaveBeenCalled();
      expect(controller.setActiveFolderPath).not.toHaveBeenCalled();
    });

    it('does nothing when the quick pick is cancelled', async () => {
      const { ctx, controller, handler } = setup(['/a', '/b']);
      mockShowQuickPick.mockResolvedValueOnce(undefined);
      await handler();
      expect(ctx.workspaceState.update).not.toHaveBeenCalled();
      expect(controller.setActiveFolderPath).not.toHaveBeenCalled();
    });

    it('runs the trust gate, persists the folder, and switches on selection', async () => {
      const { ctx, controller, handler } = setup(['/a', '/b'], { activeFolderPath: '/a' });
      mockShowQuickPick.mockResolvedValueOnce({ folderPath: '/b' });
      mockEvaluateTrust.mockReturnValueOnce({ kind: 'saved', trusted: true });

      await handler();

      expect(ctx.workspaceState.update).toHaveBeenCalledWith('sqoweWingman.activeFolder', '/b');
      expect(controller.setTrustDecision).toHaveBeenCalledWith({ kind: 'saved', trusted: true });
      expect(controller.setActiveFolderPath).toHaveBeenCalledWith('/b', expect.anything());
    });

    it('records a no-resources decision when the folder has no .pi/ resources', async () => {
      const { controller, handler } = setup(['/a', '/b']);
      mockShowQuickPick.mockResolvedValueOnce({ folderPath: '/b' });
      mockEvaluateTrust.mockReturnValueOnce({ kind: 'no-resources' });

      await handler();

      expect(controller.setTrustDecision).toHaveBeenCalledWith({ kind: 'no-resources' });
    });

    it('records a temporary decision when the prompt was dismissed (not persisted)', async () => {
      const { controller, handler } = setup(['/a', '/b']);
      mockShowQuickPick.mockResolvedValueOnce({ folderPath: '/b' });
      mockEvaluateTrust.mockReturnValueOnce({ kind: 'needs-prompt' });
      mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismiss

      await handler();

      expect(controller.setTrustDecision).toHaveBeenCalledWith({ kind: 'temporary', trusted: false });
    });
  });

  describe('trustProject', () => {
    function setup(controllerOverrides: Record<string, unknown> = {}, piStatus: unknown = { kind: 'found', path: '/usr/bin/pi' }) {
      const ctx = makeContext();
      const controller = makeController(controllerOverrides);
      registerTrustCommands(ctx as never, controller as never, () => piStatus as never);
      const handler = registeredCommands.get('sqoweWingman.trustProject')!;
      return { ctx, controller, handler };
    }

    it('informs the user when there is no active folder', async () => {
      const { controller, handler } = setup({ activeFolderPath: undefined });
      await handler();
      expect(mockShowInformationMessage).toHaveBeenCalled();
      expect(controller.forceRestart).not.toHaveBeenCalled();
    });

    it('informs the user when the folder has no trust-gated resources', async () => {
      const { controller, handler } = setup({ activeFolderPath: '/proj' });
      mockHasProjectResources.mockReturnValueOnce(false);
      await handler();
      expect(mockShowInformationMessage).toHaveBeenCalled();
      expect(controller.setTrustDecision).not.toHaveBeenCalled();
      expect(controller.forceRestart).not.toHaveBeenCalled();
    });

    it('applies a saved decision and forces a restart when the user trusts', async () => {
      const { controller, handler } = setup({ activeFolderPath: '/proj' });
      mockHasProjectResources.mockReturnValueOnce(true);
      mockShowWarningMessage.mockResolvedValueOnce('Trust'); // persisted (save succeeds)

      await handler();

      expect(controller.setTrustDecision).toHaveBeenCalledWith({ kind: 'saved', trusted: true });
      expect(controller.forceRestart).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the trust dialog is dismissed', async () => {
      const { controller, handler } = setup({ activeFolderPath: '/proj' });
      mockHasProjectResources.mockReturnValueOnce(true);
      mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismissed

      await handler();

      expect(controller.setTrustDecision).not.toHaveBeenCalled();
      expect(controller.forceRestart).not.toHaveBeenCalled();
    });

    it('does not restart when pi is not found', async () => {
      const { controller, handler } = setup({ activeFolderPath: '/proj' }, { kind: 'not-found' });
      mockHasProjectResources.mockReturnValueOnce(true);
      mockShowWarningMessage.mockResolvedValueOnce('Trust');

      await handler();

      expect(controller.setTrustDecision).toHaveBeenCalled();
      expect(controller.forceRestart).not.toHaveBeenCalled();
    });
  });
});
