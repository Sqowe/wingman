/**
 * Unit tests for AgentController Phase 5 features:
 *  - getCommands(): RPC payload validation, normalization, inert filtering.
 *  - _fetchSessionStats(): camelCase/snake_case coercion, non-finite guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const mod = await import('../__mocks__/vscode');
  return mod;
});

import * as vscode from 'vscode';
import { AgentController } from './controller';
import type { WingmanViewProvider } from '../webview/provider';
import type { SessionStats, PiCommand, ModelState } from '../shared/messages';

// ─── Stub transport ───────────────────────────────────────────────────────────

function makeTransport(sendImpl: (cmd: { type: string; [k: string]: unknown }) => unknown) {
  return {
    isRunning: true,
    start: vi.fn(async () => {}),
    send: vi.fn(async (cmd: { type: string; [k: string]: unknown }) => sendImpl(cmd)),
    onEvent: vi.fn(() => new vscode.Disposable(() => {})),
    onClose: vi.fn(() => new vscode.Disposable(() => {})),
    dispose: vi.fn(),
  };
}

// ─── Stub provider ────────────────────────────────────────────────────────────

function makeProvider() {
  return {
    postCommandsList: vi.fn(),
    postSessionStats: vi.fn(),
    postAgentEvent: vi.fn(),
    postAgentStatus: vi.fn(),
    postSessionReset: vi.fn(),
    postInstructionFiles: vi.fn(),
    postClaudeMemory: vi.fn(),
  };
}

// ─── Helpers: inject a running transport ─────────────────────────────────────

/**
 * Creates a controller with a pre-injected stub transport so we can test
 * sendCommand/getCommands/_fetchSessionStats without spawning a real process.
 */
function makeController(
  sendImpl: (cmd: { type: string; [k: string]: unknown }) => unknown,
) {
  const controller = new AgentController();
  const provider = makeProvider();
  controller.setProvider(provider as unknown as WingmanViewProvider);

  // Inject the stub transport through the private field (test-only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrl = controller as any;
  ctrl._transport = makeTransport(sendImpl);
  ctrl._isRunning = true;

  return { controller, provider };
}

// ─── getCommands tests ────────────────────────────────────────────────────────

describe('AgentController.getCommands() — normalization', () => {
  it('adds a leading slash to command names that are missing one', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: { commands: [{ name: 'hello', description: 'Say hello' }] },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds[0].name).toBe('/hello');
  });

  it('preserves a leading slash that is already present', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: { commands: [{ name: '/world', description: '' }] },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds[0].name).toBe('/world');
  });

  it('filters out inert built-in commands (with and without slash)', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: {
        commands: [
          { name: '/model',  description: 'Set model' },    // inert
          { name: 'compact', description: 'Compact' },      // inert (no slash)
          { name: '/custom', description: 'User command' }, // keep
        ],
      },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('/custom');
  });

  it('skips entries with missing or non-string name', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: {
        commands: [
          null,
          { description: 'no name' },
          { name: 42, description: 'numeric name' },
          { name: '/valid', description: 'ok' },
        ],
      },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('/valid');
  });

  it('defaults description to empty string when missing or non-string', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: {
        commands: [
          { name: '/foo' },           // no description
          { name: '/bar', description: 42 }, // non-string description
        ],
      },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds[0].description).toBe('');
    expect(cmds[1].description).toBe('');
  });

  it('handles a non-array commands field gracefully', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: true,
      command: 'get_commands',
      data: { commands: 'not-an-array' },
    }));
    await controller.getCommands();
    const cmds: PiCommand[] = provider.postCommandsList.mock.calls[0][0];
    expect(cmds).toHaveLength(0);
  });

  it('does not call postCommandsList when the response is unsuccessful', async () => {
    const { controller, provider } = makeController(() => ({
      type: 'response',
      success: false,
      command: 'get_commands',
      error: 'not supported',
    }));
    await controller.getCommands();
    expect(provider.postCommandsList).not.toHaveBeenCalled();
  });
});

// ─── _fetchSessionStats tests (via _trackStreaming) ─────────────────────────

describe('AgentController stats normalization', () => {
  function makeControllerForStats(
    sendImpl: (cmd: { type: string; [k: string]: unknown }) => unknown,
  ) {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = controller as any;
    ctrl._transport = makeTransport(sendImpl);
    ctrl._isRunning = true;
    return { controller, ctrl, provider };
  }

  async function flush() {
    // Let the fire-and-forget _fetchSessionStats microtasks settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('normalizes camelCase stats fields correctly', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          // pi's actual response shape: totals live under `tokens.total`, cost is top-level `cost`.
          data: { tokens: { total: 500 }, cost: 0.0025, totalMessages: 4 },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.totalTokens).toBe(500);
    expect(stats.totalCost).toBe(0.0025);
    expect(stats.totalMessages).toBe(4);
  });

  it('normalizes snake_case totalMessages fallback', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          // Defensive parity: tolerate snake_case `total_messages` even though
          // the upstream pi RPC uses camelCase `totalMessages`.
          data: { tokens: { total: 1000 }, cost: 0.005, total_messages: 8 },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.totalTokens).toBe(1000);
    expect(stats.totalCost).toBe(0.005);
    expect(stats.totalMessages).toBe(8);
  });

  it('sets fields to null when values are null, undefined, or empty string', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          // null, undefined, and '' must all remain null — not become 0.
          data: { tokens: { total: null }, cost: undefined, totalMessages: '' },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.totalTokens).toBeNull();
    expect(stats.totalCost).toBeNull();
    expect(stats.totalMessages).toBeNull();
  });

  it('sets fields to null when values are non-numeric strings', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: { tokens: { total: 'N/A' }, cost: null, totalMessages: undefined },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.totalTokens).toBeNull();
    expect(stats.totalCost).toBeNull();
    expect(stats.totalMessages).toBeNull();
  });

  it('does not call postSessionStats when the RPC call fails', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return { type: 'response', success: false, command: 'get_session_stats', error: 'err' };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    expect(provider.postSessionStats).not.toHaveBeenCalled();
  });

  // ── contextUsage parsing (see docs/design/context-window-indicator.md §7.1) ──

  it('parses contextUsage (camelCase) when present', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: { total: 500 },
            cost: 0.001,
            totalMessages: 4,
            contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
  });

  it('leaves contextUsage undefined when absent (no model / no context window)', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: { tokens: { total: 100 }, cost: 0.001, totalMessages: 2 },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage).toBeUndefined();
  });

  it('preserves contextWindow through the post-compaction transient (tokens & percent null)', async () => {
    // Documented in rpc.md: contextUsage.tokens and .percent are null immediately
    // after compaction; .contextWindow (the denominator) survives.
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: { total: 50000 },
            cost: 0.05,
            totalMessages: 20,
            contextUsage: { tokens: null, contextWindow: 200000, percent: null },
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage).toEqual({ tokens: null, contextWindow: 200000, percent: null });
  });

  it('tolerates snake_case sub-field names in contextUsage', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: { total: 500 },
            cost: 0.001,
            totalMessages: 4,
            contextUsage: { tokens_used: 5000, context_window: 200000, percent_used: 2 },
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._trackStreaming({ type: 'agent_end' });
    await flush();
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage).toEqual({ tokens: 5000, contextWindow: 200000, percent: 2 });
  });

  it('triggers _fetchSessionStats on compaction_end (clears the post-compaction transient)', async () => {
    const sendCalls: string[] = [];
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      sendCalls.push(cmd.type as string);
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: { total: 100 },
            cost: 0,
            totalMessages: 5,
            contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 },
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    // compaction_end must trigger a stats fetch without waiting for agent_end.
    ctrl._trackStreaming({
      type: 'compaction_end',
      reason: 'manual',
      result: null,
      aborted: false,
      willRetry: false,
    });
    await flush();
    expect(sendCalls).toContain('get_session_stats');
    expect(provider.postSessionStats).toHaveBeenCalledTimes(1);
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage?.tokens).toBe(1000);
  });

  it('triggers _fetchSessionStats on turn_end (live update during a multi-iteration turn)', async () => {
    const sendCalls: string[] = [];
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      sendCalls.push(cmd.type as string);
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: { total: 42 },
            cost: 0,
            totalMessages: 3,
            contextUsage: { tokens: 500, contextWindow: 1_000_000, percent: 0.05 },
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    // A per-iteration turn_end must refresh stats without waiting for agent_end.
    ctrl._trackStreaming({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });
    await flush();
    expect(sendCalls).toContain('get_session_stats');
    expect(provider.postSessionStats).toHaveBeenCalledTimes(1);
    const stats: SessionStats = provider.postSessionStats.mock.calls[0][0];
    expect(stats.contextUsage?.tokens).toBe(500);
  });
});

// ─── onNewSession tests ─────────────────────────────────────────────────────

describe('AgentController.onNewSession()', () => {
  it('clears the webview transcript only when clearTranscript is set (new_session)', () => {
    const { controller, provider } = makeController(() => ({
      type: 'response', success: true, command: 'get_commands', data: { commands: [] },
    }));
    controller.onNewSession({ clearTranscript: true });
    expect(provider.postSessionReset).toHaveBeenCalledTimes(1);
    expect(provider.postCommandsList).toHaveBeenCalledWith([]);
    expect(provider.postSessionStats).toHaveBeenCalledWith(null);
  });

  it('does NOT clear the transcript for fork / clone (history is preserved)', () => {
    const { controller, provider } = makeController(() => ({
      type: 'response', success: true, command: 'get_commands', data: { commands: [] },
    }));
    controller.onNewSession();
    expect(provider.postSessionReset).not.toHaveBeenCalled();
    // Stats / commands are still reset for the new session id.
    expect(provider.postSessionStats).toHaveBeenCalledWith(null);
  });

  it('fires onSessionsChanged so the sessions view can refresh', () => {
    const { controller } = makeController(() => ({
      type: 'response', success: true, command: 'get_commands', data: { commands: [] },
    }));
    const listener = vi.fn();
    controller.onSessionsChanged(listener);
    controller.onNewSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ─── getCommands coalescing ─────────────────────────────────────────────────

describe('AgentController.getCommands() — coalescing', () => {
  it('coalesces concurrent calls into a single RPC round-trip', async () => {
    let calls = 0;
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_commands') calls++;
      return {
        type: 'response', success: true, command: 'get_commands',
        data: { commands: [{ name: '/x', description: '' }] },
      };
    });
    await Promise.all([controller.getCommands(), controller.getCommands(), controller.getCommands()]);
    expect(calls).toBe(1);
    // A later call after the in-flight one settles fetches again.
    await controller.getCommands();
    expect(calls).toBe(2);
  });
});

// ─── model-state refresh tests (via sendCommand) ─────────────────────────────

describe('AgentController model state', () => {
  async function flush() {
    // Let the fire-and-forget _refreshModelState microtasks settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('refreshes and emits model + thinking level after a model-affecting command', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: { id: 'tencent/hy3-preview', name: 'HY3 Preview', provider: 'openrouter' },
            thinkingLevel: 'high',
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'set_model', provider: 'openrouter', modelId: 'tencent/hy3-preview' });
    await flush();

    expect(states.at(-1)).toEqual({
      modelId: 'tencent/hy3-preview',
      modelName: 'HY3 Preview',
      provider: 'openrouter',
      thinkingLevel: 'high',
      supportsImages: false,
    });
  });

  it('does not refresh after a non-affecting command', async () => {
    const getState = vi.fn();
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') getState();
      return { type: 'response', success: true, command: cmd.type, data: {} };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'get_messages' });
    await flush();

    expect(getState).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('emits null model fields when pi reports no active model', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: 'medium' },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.at(-1)).toEqual({
      modelId: null, modelName: null, provider: null, thinkingLevel: 'medium',
      supportsImages: false,
    });
  });
});

// ─── _refreshModelState: supportsImages ──────────────────────────────────────

describe('AgentController._refreshModelState — supportsImages', () => {
  async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  it('sets supportsImages true when model.input includes "image"', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: { id: 'm1', name: 'Vision', provider: 'anthropic', input: ['text', 'image'] },
            thinkingLevel: null,
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.at(-1)?.supportsImages).toBe(true);
  });

  it('sets supportsImages false when model.input is text-only', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: { id: 'm2', name: 'Text', provider: 'openai', input: ['text'] },
            thinkingLevel: null,
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.at(-1)?.supportsImages).toBe(false);
  });

  it('sets supportsImages false when model.input is absent', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'm3', name: 'Old', provider: 'openai' }, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.at(-1)?.supportsImages).toBe(false);
  });

  it('sets supportsImages false when model is null', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.at(-1)?.supportsImages).toBe(false);
  });
});

// ─── sendPrompt: images forwarded to transport ───────────────────────────────

describe('AgentController.sendPrompt — images', () => {
  it('omits images field when no images are passed', async () => {
    let captured: Record<string, unknown> | undefined;
    const { controller } = makeController((cmd) => {
      captured = cmd as Record<string, unknown>;
      return { type: 'response', success: true, command: cmd.type };
    });
    await controller.sendPrompt('hello');
    expect(captured?.['images']).toBeUndefined();
  });

  it('omits images field when an empty array is passed', async () => {
    let captured: Record<string, unknown> | undefined;
    const { controller } = makeController((cmd) => {
      captured = cmd as Record<string, unknown>;
      return { type: 'response', success: true, command: cmd.type };
    });
    await controller.sendPrompt('hello', []);
    expect(captured?.['images']).toBeUndefined();
  });

  it('maps AttachedImage[] to RPC images with type:"image"', async () => {
    let captured: Record<string, unknown> | undefined;
    const { controller } = makeController((cmd) => {
      captured = cmd as Record<string, unknown>;
      return { type: 'response', success: true, command: cmd.type };
    });
    await controller.sendPrompt('describe this', [
      { data: 'abc123', mimeType: 'image/png', size: 3 },
    ]);
    expect(captured?.['images']).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });

  it('strips fileName and size from RPC payload', async () => {
    let captured: Record<string, unknown> | undefined;
    const { controller } = makeController((cmd) => {
      captured = cmd as Record<string, unknown>;
      return { type: 'response', success: true, command: cmd.type };
    });
    await controller.sendPrompt('look', [
      { data: 'xyz', mimeType: 'image/jpeg', fileName: 'photo.jpg', size: 1024 },
    ]);
    const rpcImgs = captured?.['images'] as Array<Record<string, unknown>>;
    expect(rpcImgs[0]['fileName']).toBeUndefined();
    expect(rpcImgs[0]['size']).toBeUndefined();
    expect(rpcImgs[0]['type']).toBe('image');
  });
});

// ─── _reportInstructionFiles tests ────────────────────────────────────────────────

describe('AgentController._reportInstructionFiles()', () => {
  function makeControllerForReport(
    getCommandsResponse: unknown,
  ) {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = controller as any;
    ctrl._transport = makeTransport((cmd: { type: string }) => {
      if (cmd.type === 'get_commands') return getCommandsResponse;
      // prompt (fire-and-forget report command) — acknowledge
      return { type: 'response', success: true, command: cmd.type };
    });
    ctrl._isRunning = true;
    return { controller, provider, ctrl };
  }

  async function flush(n = 10) {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  it('fires null and calls postInstructionFiles(null) when command is absent from get_commands', async () => {
    const { controller, provider } = makeControllerForReport({
      type: 'response', success: true, command: 'get_commands',
      data: { commands: [{ name: '/custom', description: 'user cmd' }] },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = controller as any;
    const fired: Array<unknown> = [];
    controller.onInstructionFiles((info) => fired.push(info));
    await ctrl._reportInstructionFiles();
    await flush();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeNull();
    expect(provider.postInstructionFiles).toHaveBeenCalledWith(null);
  });

  it('never appends internal command to postCommandsList', async () => {
    const { controller, provider } = makeControllerForReport({
      type: 'response', success: true, command: 'get_commands',
      data: { commands: [
        { name: 'wingman-instruction-report', description: 'internal' },
        { name: '/custom', description: 'user cmd' },
      ] },
    });
    await controller.getCommands();
    const cmds = provider.postCommandsList.mock.calls[0][0] as Array<{ name: string }>;
    expect(cmds.every((c) => c.name !== '/wingman-instruction-report')).toBe(true);
    expect(cmds.every((c) => c.name !== 'wingman-instruction-report')).toBe(true);
    expect(cmds.some((c) => c.name === '/custom')).toBe(true);
  });

  it('detects slash-prefixed command name in get_commands as present', async () => {
    const { controller, provider, ctrl } = makeControllerForReport({
      type: 'response', success: true, command: 'get_commands',
      data: { commands: [{ name: '/wingman-instruction-report', description: 'internal' }] },
    });
    const reportPromise = ctrl._reportInstructionFiles();
    await flush(5);
    // Deliver the callback so the promise settles.
    ctrl._instructionFilesWaiter?.resolve({ files: [] });
    ctrl._instructionFilesWaiter = undefined;
    await reportPromise;
    // Should have been called with real data (not null), proving the command was detected.
    expect(provider.postInstructionFiles).toHaveBeenCalledWith({ files: [] });
  });

  it('resolves with the info payload when bridge callback fires', async () => {
    const { controller, provider, ctrl } = makeControllerForReport({
      type: 'response', success: true, command: 'get_commands',
      data: { commands: [{ name: 'wingman-instruction-report', description: 'internal' }] },
    });
    const reportPromise = ctrl._reportInstructionFiles();
    // Simulate the bridge callback arriving with a valid payload.
    await flush(5);
    ctrl._instructionFilesWaiter?.resolve({ files: [
      { path: '/home/.pi/agent/AGENTS.md', scope: 'global', role: 'context' },
    ] });
    ctrl._instructionFilesWaiter = undefined;
    await reportPromise;
    expect(provider.postInstructionFiles).toHaveBeenCalledWith({
      files: [{ path: '/home/.pi/agent/AGENTS.md', scope: 'global', role: 'context' }],
    });
  });

  it('fires null on transport not running', async () => {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = controller as any;
    // No transport injected — isRunning will be false.
    await ctrl._reportInstructionFiles();
    await flush();
    expect(provider.postInstructionFiles).toHaveBeenCalledWith(null);
  });

  it('second call supersedes first: stale callback does not resolve second waiter', async () => {
    const { controller, provider, ctrl } = makeControllerForReport({
      type: 'response', success: true, command: 'get_commands',
      data: { commands: [{ name: 'wingman-instruction-report', description: 'internal' }] },
    });

    // Start first report — let it reach the waiter stage.
    const firstPromise = ctrl._reportInstructionFiles();
    await flush(5);

    // Capture first waiter before starting second call.
    const firstWaiter = ctrl._instructionFilesWaiter;

    // Start second report — it should cancel the first.
    const secondPromise = ctrl._reportInstructionFiles();
    await flush(5);

    // Deliver first call's callback (stale — nonce won't match second).
    if (firstWaiter) {
      firstWaiter.resolve({ files: [
        { path: '/stale/AGENTS.md', scope: 'global', role: 'context' },
      ] });
    }

    // Deliver second call's callback with correct data.
    ctrl._instructionFilesWaiter?.resolve({ files: [
      { path: '/current/CLAUDE.md', scope: 'project', role: 'context' },
    ] });
    ctrl._instructionFilesWaiter = undefined;

    await firstPromise;
    await secondPromise;
    await flush();

    // Only the second result should have been posted (not the stale first).
    const calls = provider.postInstructionFiles.mock.calls as Array<[unknown]>;
    // The last call must be the second (current) result.
    const lastCall = calls[calls.length - 1][0] as { files: Array<{ path: string }> } | null;
    expect(lastCall?.files?.[0]?.path).toBe('/current/CLAUDE.md');
    // The stale path must never appear.
    expect(calls.every((c) => {
      const info = c[0] as { files?: Array<{ path: string }> } | null;
      return !info?.files?.some((f) => f.path === '/stale/AGENTS.md');
    })).toBe(true);
  });
});

describe('AgentController — bundled extension paths', () => {
  it('is constructed cleanly with no args', () => {
    expect(() => new AgentController()).not.toThrow();
  });

  it('is constructed cleanly with a list of extension paths', () => {
    expect(() => new AgentController(['/ext/a/index.js', '/ext/b/index.js'])).not.toThrow();
  });

  it('accepts a replacement extension-path set via setBundledExtensionPaths (backs the memory toggle)', () => {
    const controller = new AgentController(['/ext/a/index.js']);
    // Re-applying the gate (e.g. sqoweWingman.shareClaudeMemory toggled off) swaps
    // the -e set for the next spawn; de-duplicates like the constructor.
    expect(() => controller.setBundledExtensionPaths([])).not.toThrow();
    expect(() =>
      controller.setBundledExtensionPaths(['/ext/a/index.js', '/ext/a/index.js', '/ext/b/index.js']),
    ).not.toThrow();
  });
});

describe('AgentController — claudeMemory bridge report', () => {
  it('forwards a claudeMemory report from the bridge to provider.postClaudeMemory', () => {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);

    // The controller wires the bridge's claudeMemory callback to
    // provider.postClaudeMemory. Drive it by feeding a reserved-key setStatus
    // event through the (private) bridge the controller constructed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (controller as any)._uiBridge;
    bridge.handleEvent({
      type: 'extension_ui_request',
      id: 'm1',
      method: 'setStatus',
      statusKey: 'wingman:claudeMemory',
      statusText: JSON.stringify({
        dir: '/mem',
        count: 1,
        files: [{ path: '/mem/a.md', title: 'Alpha' }],
      }),
    });

    expect(provider.postClaudeMemory).toHaveBeenCalledTimes(1);
    const info = provider.postClaudeMemory.mock.calls[0][0] as { dir: string; files: unknown[] };
    expect(info.dir).toBe('/mem');
    expect(info.files).toHaveLength(1);
  });

  it('forwards null to provider.postClaudeMemory on a malformed report', () => {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (controller as any)._uiBridge;
    bridge.handleEvent({
      type: 'extension_ui_request',
      id: 'm2',
      method: 'setStatus',
      statusKey: 'wingman:claudeMemory',
      statusText: 'NOT JSON',
    });
    expect(provider.postClaudeMemory).toHaveBeenCalledWith(null);
  });
});
