/**
 * Unit tests for the model / thinking memory hooks in the command layer.
 *
 * pi's RPC exposes no way to persist a model or thinking selection (its
 * `set_model` / `set_thinking_level` commands carry no `persist` field, and pi's
 * handler calls `session.setModel(model)` with no options), so a `new_session`
 * would otherwise revert to pi's global default. These commands are therefore
 * the place where the user's explicit choice is recorded — see
 * src/agent/model-memory.ts.
 *
 * `fs/promises` is mocked at module level so `readEnabledModels()` reads a fixed
 * shortlist instead of the real ~/.pi/agent/settings.json.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => import('../__mocks__/vscode'));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify({
      enabledModels: ['anthropic/claude-opus-4.8'],
    })),
  },
}));

import * as vscode from 'vscode';
import { pickModel, cycleModel } from './model-picker';
import { setThinkingLevel, cycleThinkingLevel, normalizeLevels, buildLevelItems, FALLBACK_LEVELS }
  from './thinking-level';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(command: string, data?: unknown) {
  return { type: 'response', success: true, command, data };
}

function makeController(sendImpl: (cmd: { type: string; [k: string]: unknown }) => unknown) {
  return {
    sendCommand: vi.fn(async (cmd: { type: string; [k: string]: unknown }) => sendImpl(cmd)),
    rememberModelChoice: vi.fn(),
    rememberThinkingLevel: vi.fn(),
    // Pre-switch snapshot, as the controller's cached `get_state` holds it
    // while the cycle command is still in flight.
    lastModelState: { thinkingLevel: 'minimal' } as { thinkingLevel: string | null },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
  vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
});

// ─── Set Model ───────────────────────────────────────────────────────────────

describe('pickModel — memory', () => {
  it('records the picked provider/modelId after a successful set_model', async () => {
    const controller = makeController((cmd) => ok(cmd.type, { models: [
      { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', provider: 'anthropic' },
    ] }));
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({
      label: 'Claude Opus 4.8', provider: 'anthropic', modelId: 'claude-opus-4.8',
    } as never);

    await pickModel(controller as never);

    expect(controller.sendCommand).toHaveBeenCalledWith({
      type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-4.8',
    });
    expect(controller.rememberModelChoice).toHaveBeenCalledWith('anthropic', 'claude-opus-4.8');
  });

  it('does not remember anything when set_model fails', async () => {
    const controller = makeController((cmd) => (
      cmd.type === 'set_model'
        ? { type: 'response', success: false, command: 'set_model', error: 'no auth' }
        : ok(cmd.type, { models: [{ id: 'claude-opus-4.8', name: 'C', provider: 'anthropic' }] })
    ));
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({
      label: 'Claude Opus 4.8', provider: 'anthropic', modelId: 'claude-opus-4.8',
    } as never);

    await pickModel(controller as never);

    expect(controller.rememberModelChoice).not.toHaveBeenCalled();
  });

  it('does not remember anything when the user cancels the quick pick', async () => {
    const controller = makeController((cmd) => ok(cmd.type, { models: [] }));
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await pickModel(controller as never);

    expect(controller.rememberModelChoice).not.toHaveBeenCalled();
  });
});

// ─── Cycle Model ─────────────────────────────────────────────────────────────

describe('cycleModel — memory', () => {
  it("records the cycled-to model from pi's nested { model: {...} } response", async () => {
    const controller = makeController(() => ok('cycle_model', {
      model: { id: 'claude-opus-5', provider: 'local-claude' },
      thinkingLevel: 'high',
      isScoped: true,
    }));

    await cycleModel(controller as never);

    expect(controller.rememberModelChoice).toHaveBeenCalledWith('local-claude', 'claude-opus-5');
  });

  it('does not record the thinkingLevel pi reports — that is the post-switch default', async () => {
    // pi's setModel calls setThinkingLevel(_getThinkingLevelForModelSwitch(model))
    // with no explicit level, so the level in a cycle_model response is
    // `defaultThinkingLevel` (or a modelThinkingLevels pin), NOT the user's
    // choice. Recording it would destroy a deliberate pick in workspaceState,
    // where it would outlive this session and mis-seed the next new_session.
    const controller = makeController(() => ok('cycle_model', {
      model: { id: 'z-ai/glm-5.3', provider: 'openrouter' },
      thinkingLevel: 'high',
      isScoped: true,
    }));

    await cycleModel(controller as never);

    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });

  it('records the model but not the level when the response omits a level', async () => {
    const controller = makeController(() => ok('cycle_model', {
      model: { id: 'm', provider: 'p' },
    }));

    await cycleModel(controller as never);

    expect(controller.rememberModelChoice).toHaveBeenCalledWith('p', 'm');
    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });

  it('names the new model in the info message (the nested shape used to be blank)', async () => {
    const controller = makeController(() => ok('cycle_model', {
      model: { id: 'claude-opus-5', provider: 'local-claude' },
    }));

    await cycleModel(controller as never);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('local-claude/claude-opus-5'),
    );
  });

  it('remembers nothing when cycle_model fails', async () => {
    const controller = makeController(() => ({
      type: 'response', success: false, command: 'cycle_model', error: 'x',
    }));

    await cycleModel(controller as never);

    expect(controller.rememberModelChoice).not.toHaveBeenCalled();
  });
});

// ─── Thinking Level ──────────────────────────────────────────────────────────

describe('setThinkingLevel — memory', () => {
  it('records the picked level', async () => {
    const controller = makeController((cmd) => ok(cmd.type));
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(
      { label: 'xhigh', level: 'xhigh' } as never,
    );

    await setThinkingLevel(controller as never);

    expect(controller.sendCommand).toHaveBeenCalledWith({ type: 'set_thinking_level', level: 'xhigh' });
    expect(controller.rememberThinkingLevel).toHaveBeenCalledWith('xhigh');
  });

  it('remembers nothing when the command fails', async () => {
    const controller = makeController((cmd) =>
      cmd.type === 'get_available_thinking_levels'
        ? ok(cmd.type, { levels: FALLBACK_LEVELS })
        : { type: 'response', success: false, command: 'set_thinking_level', error: 'nope' });
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(
      { label: 'max', level: 'max' } as never,
    );

    await setThinkingLevel(controller as never);

    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });

  it('remembers nothing when the quick pick is cancelled', async () => {
    const controller = makeController((cmd) => ok(cmd.type));
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    expect(controller.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_thinking_level' }),
    );
    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });
});

describe('setThinkingLevel — level list comes from pi', () => {
  it('offers exactly the levels the current model reports', async () => {
    const controller = makeController((cmd) =>
      ok(cmd.type, { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }));
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    expect(controller.sendCommand).toHaveBeenCalledWith({ type: 'get_available_thinking_levels' });
    const items = pick.mock.calls[0][0] as { label: string; description?: string }[];
    expect(items.map((i) => i.label)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(items[0].description).toBe('No extended thinking');
  });

  it('shows "off" alone for a model without reasoning support', async () => {
    const controller = makeController((cmd) => ok(cmd.type, { levels: ['off'] }));
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    const items = pick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(['off']);
  });

  it('never offers the non-existent "none" level', async () => {
    const controller = makeController((cmd) => ok(cmd.type, { levels: FALLBACK_LEVELS }));
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    const items = pick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).not.toContain('none');
  });

  it('falls back to the canonical list when pi answers with an error', async () => {
    const controller = makeController((cmd) => (
      cmd.type === 'get_available_thinking_levels'
        ? { type: 'response', success: false, command: cmd.type, error: 'nope' }
        : ok(cmd.type)));
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    const items = pick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual([...FALLBACK_LEVELS]);
  });

  it('falls back to the canonical list when the fetch throws', async () => {
    const controller = makeController((cmd) => {
      if (cmd.type === 'get_available_thinking_levels') throw new Error('transport down');
      return ok(cmd.type);
    });
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    const items = pick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual([...FALLBACK_LEVELS]);
  });

  it('falls back when pi returns a payload with no usable levels', async () => {
    const controller = makeController((cmd) => ok(cmd.type, { levels: [] }));
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

    await setThinkingLevel(controller as never);

    const items = pick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual([...FALLBACK_LEVELS]);
  });
});

describe('normalizeLevels', () => {
  it('accepts the contractual { levels: [...] } shape', () => {
    expect(normalizeLevels({ levels: ['off', 'high'] })).toEqual(['off', 'high']);
  });

  it('accepts a bare array and a { data: [...] } variant', () => {
    expect(normalizeLevels(['off', 'high'])).toEqual(['off', 'high']);
    expect(normalizeLevels({ data: ['off', 'high'] })).toEqual(['off', 'high']);
  });

  it('drops non-strings, blanks and duplicates, preserving pi order', () => {
    expect(normalizeLevels({ levels: ['off', 7, null, '  ', ' high ', 'off', 'low'] }))
      .toEqual(['off', 'high', 'low']);
  });

  it('returns an empty array for unrecognized shapes', () => {
    expect(normalizeLevels(undefined)).toEqual([]);
    expect(normalizeLevels({ nope: 1 })).toEqual([]);
  });
});

describe('buildLevelItems', () => {
  it('carries the level token through for set_thinking_level', () => {
    expect(buildLevelItems(['xhigh', 'max'])).toEqual([
      { label: 'xhigh', description: 'Very large thinking budget', level: 'xhigh' },
      { label: 'max', description: 'Maximum thinking budget', level: 'max' },
    ]);
  });

  it('still offers an unknown future level, just without a description', () => {
    const [item] = buildLevelItems(['ultra']);
    expect(item.label).toBe('ultra');
    expect(item.level).toBe('ultra');
    expect(item.description).toBeUndefined();
  });
});

describe('cycleThinkingLevel — memory', () => {
  it('records the new level from the response', async () => {
    const controller = makeController(() => ok('cycle_thinking_level', { level: 'max' }));

    await cycleThinkingLevel(controller as never);

    expect(controller.rememberThinkingLevel).toHaveBeenCalledWith('max');
  });

  it('remembers nothing when the response carries no level', async () => {
    const controller = makeController(() => ok('cycle_thinking_level', {}));

    await cycleThinkingLevel(controller as never);

    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });

  it('remembers nothing when the command fails', async () => {
    const controller = makeController(() => ({
      type: 'response', success: false, command: 'cycle_thinking_level', error: 'x',
    }));

    await cycleThinkingLevel(controller as never);

    expect(controller.rememberThinkingLevel).not.toHaveBeenCalled();
  });
});
