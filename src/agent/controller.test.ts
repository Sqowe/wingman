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
import type { SessionStats, PiCommand } from '../shared/messages';

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
          data: { totalTokens: 500, totalCost: 0.0025, totalMessages: 4 },
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

  it('normalizes snake_case stats fields correctly', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: { total_tokens: 1000, total_cost: 0.005, total_messages: 8 },
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
          data: { totalTokens: null, totalCost: undefined, totalMessages: '' },
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
          data: { totalTokens: 'N/A', totalCost: null, totalMessages: undefined },
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
