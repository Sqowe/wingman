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
import { newSession } from '../commands/new-session';

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

// ─── Model / thinking memory (new_session restore) ───────────────────────────
//
// pi's new_session rebuilds the runtime and re-resolves model + thinking from
// its global settings, and its RPC exposes no way to persist a selection. These
// tests pin the Wingman-side memory that compensates for that.

describe('AgentController model memory', () => {
  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  function makeMemento() {
    const store: Record<string, unknown> = {};
    return {
      store,
      get: <T,>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    };
  }

  /** Records every command type sent, so we can assert the exact RPC sequence. */
  function recorder(state: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }) {
    const sent: string[] = [];
    const send = (cmd: { type: string; [k: string]: unknown }) => {
      sent.push(cmd.type);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: state.modelId
              ? { id: state.modelId, name: state.modelId, provider: state.provider ?? 'p', input: ['text'] }
              : null,
            thinkingLevel: state.thinkingLevel ?? null,
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    };
    return { sent, send };
  }

  // ── Seeding ───────────────────────────────────────────────────────────────

  it('seeds the memory from the first get_state so a first-run new_session keeps the model', async () => {
    const { controller } = makeController(recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'high' }).send);
    controller.setStateStorage(makeMemento());

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(controller.modelMemory).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });

  it('does not let a later get_state overwrite a recorded choice', async () => {
    // Mutable so we can simulate switching onto a session whose own model
    // differs — the case that must not become "the" remembered choice.
    const state = { provider: 'p', modelId: 'm', thinkingLevel: 'high' };
    const { controller } = makeController(recorder(state).send);
    controller.setStateStorage(makeMemento());
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    expect(controller.modelMemory).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });

    // The user switches to another session that recorded a different model.
    state.provider = 'other';
    state.modelId = 'other-m';
    state.thinkingLevel = 'low';
    await controller.sendCommand({ type: 'switch_session' });
    await flush();

    expect(controller.modelMemory).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });

  it('does not adopt the default that new_session just resolved to', async () => {
    const state = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const { controller } = makeController(recorder(state).send);
    controller.setStateStorage(makeMemento());
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    controller.rememberModelChoice('anthropic', 'claude');
    await flush();

    // pi rebuilds the runtime and hands back its global default instead.
    state.provider = 'openrouter';
    state.modelId = 'some-default';
    state.thinkingLevel = 'medium';
    await controller.sendCommand({ type: 'new_session' });
    await flush();

    expect(controller.modelMemory).toEqual({
      provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high',
    });
  });

  it('reads a pre-existing memory out of the injected memento', () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'saved', modelId: 'saved-m' };
    const { controller } = makeController(recorder({}).send);
    controller.setStateStorage(memento);
    expect(controller.modelMemory).toEqual({ provider: 'saved', modelId: 'saved-m' });
  });

  it('ignores a corrupted stored value', () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = 'nonsense';
    const { controller } = makeController(recorder({}).send);
    controller.setStateStorage(memento);
    expect(controller.modelMemory).toBeUndefined();
  });

  it('works with no memento injected (no persistence, no throw)', async () => {
    const { controller } = makeController(recorder({ provider: 'p', modelId: 'm' }).send);
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    expect(controller.modelMemory).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: undefined });
  });

  // ── rememberModelChoice / rememberThinkingLevel ───────────────────────────

  it('persists a model pick to workspace state', async () => {
    const memento = makeMemento();
    const { controller } = makeController(recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'high' }).send);
    controller.setStateStorage(memento);
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    controller.rememberModelChoice('anthropic', 'claude');
    await flush();

    expect(memento.store['sqoweWingman.modelMemory']).toEqual({
      provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high',
    });
  });

  it('backfills the thinking level from the live session on a model pick', async () => {
    const memento = makeMemento();
    const { controller } = makeController(recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'max' }).send);
    controller.setStateStorage(memento);
    // Start with a model but no recorded level (a model-only write path).
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._modelMemory = { provider: 'p', modelId: 'm' };

    controller.rememberModelChoice('anthropic', 'claude');
    await flush();

    expect(memento.store['sqoweWingman.modelMemory']).toEqual({
      provider: 'anthropic', modelId: 'claude', thinkingLevel: 'max',
    });
  });

  it('a thinking-only write keeps the model half intact', async () => {
    const memento = makeMemento();
    const { controller } = makeController(recorder({}).send);
    controller.setStateStorage(memento);
    controller.rememberModelChoice('p', 'm');

    controller.rememberThinkingLevel('low');
    await flush();

    expect(memento.store['sqoweWingman.modelMemory']).toEqual({
      provider: 'p', modelId: 'm', thinkingLevel: 'low',
    });
  });

  it('ignores empty provider / modelId / level arguments', () => {
    const { controller } = makeController(recorder({}).send);
    controller.setStateStorage(makeMemento());
    controller.rememberModelChoice('', 'm');
    controller.rememberModelChoice('p', '');
    controller.rememberThinkingLevel('');
    expect(controller.modelMemory).toBeUndefined();
  });

  // ── restoreModelChoice ────────────────────────────────────────────────────

  it('re-applies both halves after new_session', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'low' });
    const { controller } = makeController(send);
    controller.setStateStorage(memento);

    await controller.restoreModelChoice();

    expect(sent).toContain('set_model');
    expect(sent).toContain('set_thinking_level');
  });

  it('sends the remembered provider/modelId pair, not the current one', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const params: unknown[] = [];
    const { controller } = makeController((cmd) => {
      params.push(cmd);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'm', name: 'm', provider: 'p', input: ['text'] }, thinkingLevel: 'low' },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    await controller.restoreModelChoice();

    const setModel = params.find((c) => (c as { type: string }).type === 'set_model');
    expect(setModel).toMatchObject({ provider: 'anthropic', modelId: 'claude' });
    const setLevel = params.find((c) => (c as { type: string }).type === 'set_thinking_level');
    expect(setLevel).toMatchObject({ level: 'high' });
  });

  it('re-applies even when the pre-new_session cache already matches (the primary path)', async () => {
    // This is the bug the reviewer caught: new_session runs with the refresh
    // suppressed, so _lastModelState is still the PREVIOUS session's value. The
    // user is on their remembered model, presses New Session, the cache looks
    // like a match — and a skip-if-matches check then re-applies nothing, so the
    // trailing get_state publishes pi's default and the feature no-ops on the
    // exact case it exists for.
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const { sent, send } = recorder({ provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' });
    const { controller } = makeController(send);
    controller.setStateStorage(memento);
    // Last state == memory.
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    sent.length = 0;

    // The exact sequence newSession() drives.
    await controller.runSuppressingModelRefresh(async () => {
      await controller.sendCommand({ type: 'new_session' });
      await controller.restoreModelChoice();
    });

    expect(sent).toContain('set_model');
    expect(sent).toContain('set_thinking_level');
  });

  it('sends the remembered pair, not whatever the cache holds, when they differ', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    // pi resolved a *different* default after new_session.
    const { sent, send } = recorder({ provider: 'openrouter', modelId: 'some-default', thinkingLevel: 'medium' });
    const { controller } = makeController(send);
    controller.setStateStorage(memento);
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    sent.length = 0;

    await controller.runSuppressingModelRefresh(async () => {
      await controller.sendCommand({ type: 'new_session' });
      await controller.restoreModelChoice();
    });

    expect(sent).toContain('set_model');
    expect(sent).toContain('set_thinking_level');
  });

  it('re-applies nothing when nothing is remembered, but still owes one refresh', async () => {
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
    const { controller } = makeController(send);
    // Never let a get_state seed the memory for this case.
    await controller.sendCommand({ type: 'get_state' });
    await flush();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._modelMemory = undefined;
    sent.length = 0;

    await controller.restoreModelChoice();

    // No re-apply, but the caller suppressed new_session's automatic refresh,
    // so the single get_state here is what keeps onModelState from going stale.
    expect(sent).not.toContain('set_model');
    expect(sent).not.toContain('set_thinking_level');
    expect(sent.filter((t) => t === 'get_state')).toHaveLength(1);
  });

  it('skips the model half when only a thinking level is remembered', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { thinkingLevel: 'max' };
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'low' });
    const { controller } = makeController(send);
    controller.setStateStorage(memento);

    await controller.restoreModelChoice();

    expect(sent).not.toContain('set_model');
    expect(sent).toContain('set_thinking_level');
  });

  it('ends on exactly one get_state refresh (no default-value flicker)', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'low' });
    const { controller } = makeController(send);
    controller.setStateStorage(memento);

    await controller.restoreModelChoice();

    expect(sent.filter((t) => t === 'get_state')).toHaveLength(1);
  });

  it('refreshes even when the re-apply is rejected, so the bar shows the truth', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude' };
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'low' });
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'set_model') {
        return { type: 'response', success: false, command: 'set_model', error: 'Model not found' };
      }
      return send(cmd);
    });
    controller.setStateStorage(memento);

    await expect(controller.restoreModelChoice()).rejects.toThrow('Model not found');

    expect(sent).toContain('get_state');
  });

  // ── rejected re-apply ───────────────────────────────────────────────────

  it('skips the thinking level when the model was rejected, and throws', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'gone', thinkingLevel: 'high' };
    const { sent, send } = recorder({ provider: 'p', modelId: 'm', thinkingLevel: 'low' });
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'set_model') {
        return { type: 'response', success: false, command: 'set_model', error: 'Model not found: anthropic/gone' };
      }
      return send(cmd);
    });
    controller.setStateStorage(memento);

    await expect(controller.restoreModelChoice()).rejects.toThrow(/Model not found/);

    // pi clamps the level to the active model, so sending it after a rejected
    // model would report a success that does not describe the chosen pair.
    expect(sent).not.toContain('set_thinking_level');
  });

  it('throws and reports the level when only set_thinking_level is rejected', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'p', modelId: 'm', thinkingLevel: 'max' };
    const send = (cmd: { type: string; [k: string]: unknown }) => {
      if (cmd.type === 'set_thinking_level') {
        return { type: 'response', success: false, command: 'set_thinking_level', error: 'not supported' };
      }
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'm', name: 'm', provider: 'p', input: ['text'] }, thinkingLevel: 'low' },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    };
    const { controller } = makeController(send);
    controller.setStateStorage(memento);

    await expect(controller.restoreModelChoice()).rejects.toThrow(/not supported/);
  });

  it('keeps the memory after a rejected re-apply (a transient failure is not a lost choice)', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude' };
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'set_model') {
        return { type: 'response', success: false, command: 'set_model', error: 'no auth' };
      }
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    await expect(controller.restoreModelChoice()).rejects.toThrow();
    await flush();

    expect(controller.modelMemory).toEqual({ provider: 'anthropic', modelId: 'claude' });
    expect(memento.store['sqoweWingman.modelMemory']).toEqual({
      provider: 'anthropic', modelId: 'claude',
    });
  });

  it('clears the suppression flag even when a re-apply throws', async () => {
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: null },
        };
      }
      if (cmd.type === 'set_model') throw new Error('pi died');
      return { type: 'response', success: true, command: cmd.type };
    });
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude' };
    controller.setStateStorage(memento);

    await expect(controller.restoreModelChoice()).rejects.toThrow('pi died');

    // The flag must be back to false, so ordinary commands refresh again.
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();
    expect(states.length).toBeGreaterThan(0);
  });
});

// ─── runSuppressingModelRefresh ──────────────────────────────────────────────

describe('AgentController.runSuppressingModelRefresh', () => {
  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  it('suppresses the automatic refresh inside the callback', async () => {
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

    const result = await controller.runSuppressingModelRefresh(async () => {
      await controller.sendCommand({ type: 'new_session' });
      return 'done';
    });
    await flush();

    expect(result).toBe('done');
    expect(states).toHaveLength(0);
  });

  it('restores the previous flag value afterwards', async () => {
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

    await controller.runSuppressingModelRefresh(async () => {
      await controller.sendCommand({ type: 'new_session' });
    });
    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.length).toBeGreaterThan(0);
  });

  it('does not leak suppression out of a nested call', async () => {
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

    await controller.runSuppressingModelRefresh(async () => {
      await controller.runSuppressingModelRefresh(async () => {
        await controller.sendCommand({ type: 'new_session' });
      });
      // Inner scope exited — the outer suppression must still hold.
      await controller.sendCommand({ type: 'new_session' });
    });
    await flush();

    expect(states).toHaveLength(0);
  });
});

// ─── newSession integration (real controller, real restore) ─────────────────
//
// These drive the actual `newSession()` command against a real AgentController
// so the interaction between the suppress window, the restore, and the
// compensating refresh is exercised end to end. The command-level tests stub
// restoreModelChoice, which hides exactly this interaction.

describe('newSession() — end-to-end refresh guarantee', () => {
  async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  function makeMemento() {
    const store: Record<string, unknown> = {};
    return {
      store,
      get: <T,>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    };
  }

  it('still refreshes the model state when nothing is remembered', async () => {
    // Nothing in the memento: restoreModelChoice has no re-apply to do, but the
    // refresh it owes the caller is what keeps onModelState from going stale —
    // it also drives the webview's supportsImages gate.
    const sent: string[] = [];
    const { controller, provider } = makeController((cmd) => {
      sent.push(cmd.type);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: { id: 'new-default', name: 'New Default', provider: 'openrouter', input: ['text'] },
            thinkingLevel: 'medium',
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(makeMemento());
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await newSession(controller as never);
    await flush();

    // The suppressed automatic refresh was replaced, not lost.
    expect(sent).toContain('get_state');
    expect(states.at(-1)?.modelId).toBe('new-default');
    expect(provider.postSessionReset).toHaveBeenCalled();
  });

  it('refreshes the model state when a memento exists but is corrupted', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = 'not-a-memory';
    const sent: string[] = [];
    const { controller } = makeController((cmd) => {
      sent.push(cmd.type);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'd', name: 'D', provider: 'p', input: ['text'] }, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await newSession(controller as never);
    await flush();

    expect(sent).toContain('get_state');
    expect(states.at(-1)?.modelId).toBe('d');
  });

  it('re-applies the remembered pair and ends on exactly one refresh', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude', thinkingLevel: 'high' };
    const sent: string[] = [];
    const { controller, provider } = makeController((cmd) => {
      sent.push(cmd.type);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: {
            model: { id: 'claude', name: 'Claude', provider: 'anthropic', input: ['text'] },
            thinkingLevel: 'high',
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);
    const states: (ModelState | null)[] = [];
    controller.onModelState((s) => states.push(s));

    await newSession(controller as never);
    await flush();

    expect(sent).toContain('set_model');
    expect(sent).toContain('set_thinking_level');
    expect(sent.filter((t) => t === 'get_state')).toHaveLength(1);
    expect(states.at(-1)?.modelId).toBe('claude');
    expect(provider.postSessionReset).toHaveBeenCalled();
  });

  it('resets the view even when the re-apply is rejected', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'gone' };
    const { controller, provider } = makeController((cmd) => {
      if (cmd.type === 'set_model') {
        return { type: 'response', success: false, command: 'set_model', error: 'Model not found' };
      }
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'd', name: 'D', provider: 'p', input: ['text'] }, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    await newSession(controller as never);
    await flush();

    // The session exists, so the view must be reset despite the rejection.
    expect(provider.postSessionReset).toHaveBeenCalled();
  });

  it('still refreshes when the re-apply throws, then resets the view', async () => {
    const memento = makeMemento();
    memento.store['sqoweWingman.modelMemory'] = { provider: 'anthropic', modelId: 'claude' };
    const sent: string[] = [];
    const { controller, provider } = makeController((cmd) => {
      sent.push(cmd.type);
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: { id: 'd', name: 'D', provider: 'p', input: ['text'] }, thinkingLevel: null },
        };
      }
      if (cmd.type === 'set_model') throw new Error('pi died');
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    await newSession(controller as never);
    await flush();

    // The finally block must publish the truth even on the throw path.
    expect(sent).toContain('get_state');
    expect(provider.postSessionReset).toHaveBeenCalled();
  });

  it('does not restore or reset the view when new_session itself fails', async () => {
    const { controller, provider } = makeController((cmd) => (
      cmd.type === 'new_session'
        ? { type: 'response', success: false, command: 'new_session', error: 'cancelled' }
        : { type: 'response', success: true, command: cmd.type }
    ));
    controller.setStateStorage(makeMemento());

    await newSession(controller as never);
    await flush();

    expect(provider.postSessionReset).not.toHaveBeenCalled();
  });
});

// ─── memory write ordering ───────────────────────────────────────────────────

describe('AgentController model memory — write ordering', () => {
  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('serializes two back-to-back commits so the last one wins on disk', async () => {
    // cycleModel records the model and the level with two commits. Each
    // memento.update is held on a manually resolved promise, so the ordering is
    // proven by which writes are *issued* — no wall-clock timing, no flake.
    const store: Record<string, unknown> = {};
    const issued: unknown[] = [];
    const gates: Array<() => void> = [];
    const memento = {
      get: <T,>(key: string) => store[key] as T | undefined,
      update: (key: string, value: unknown) => new Promise<void>((resolve) => {
        issued.push(value);
        gates.push(() => { store[key] = value; resolve(); });
      }),
    };
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    controller.rememberModelChoice('p', 'm');
    controller.rememberThinkingLevel('max');
    // The chain starts from an already-resolved promise, so the first write is
    // issued on a microtask rather than synchronously.
    await flush();

    // Only the first write may be in flight; the second is not even issued
    // until the first settles. Unserialized, both would appear here.
    expect(issued).toHaveLength(1);
    expect(issued[0]).toEqual({ provider: 'p', modelId: 'm' });

    gates[0]();
    await flush();
    expect(issued).toHaveLength(2);
    expect(issued[1]).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'max' });

    gates[1]();
    await flush();

    // The complete pair is what persisted, not the model-only snapshot.
    expect(store['sqoweWingman.modelMemory']).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'max' });
  });

  it('overlapping (non-nested) calls cannot latch suppression on', async () => {
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

    // A enters, then B overlaps it. A finishes FIRST, so B's finally runs last
    // and restores the value it read at entry (true) — which latches the flag on
    // with the boolean save/restore.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = controller.runSuppressingModelRefresh(async () => {
      await new Promise<void>((r) => { releaseA = r; });
    });
    await flush();
    const b = controller.runSuppressingModelRefresh(async () => {
      await new Promise<void>((r) => { releaseB = r; });
    });
    await flush();

    releaseA();
    await a;
    releaseB();
    await b;
    states.length = 0;

    await controller.sendCommand({ type: 'cycle_model' });
    await flush();

    expect(states.length).toBeGreaterThan(0);
  });
});

// ─── memory normalization on write ───────────────────────────────────────────

describe('AgentController model memory — normalize on commit', () => {
  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('trims and drops empties from the in-memory cache, not just on read', async () => {
    const store: Record<string, unknown> = {};
    const memento = {
      get: <T,>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    };
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_state') {
        return {
          type: 'response', success: true, command: 'get_state',
          data: { model: null, thinkingLevel: null },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    controller.setStateStorage(memento);

    // A padded ref must never reach set_model / set_thinking_level verbatim.
    controller.rememberModelChoice('  anthropic  ', ' claude-opus-4.8 ');
    controller.rememberThinkingLevel(' high ');
    await flush();

    expect(controller.modelMemory).toEqual({
      provider: 'anthropic', modelId: 'claude-opus-4.8', thinkingLevel: 'high',
    });
    expect(store['sqoweWingman.modelMemory']).toEqual({
      provider: 'anthropic', modelId: 'claude-opus-4.8', thinkingLevel: 'high',
    });
  });

  it('drops a whitespace-only argument entirely', async () => {
    const store: Record<string, unknown> = {};
    const memento = {
      get: <T,>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    };
    const { controller } = makeController((cmd) => ({
      type: 'response', success: true, command: cmd.type,
    }));
    controller.setStateStorage(memento);

    controller.rememberThinkingLevel('   ');
    await flush();

    expect(controller.modelMemory).toBeUndefined();
    expect(store['sqoweWingman.modelMemory']).toBeUndefined();
  });
});
