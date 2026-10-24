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
import { AgentController, parseTokenBuckets, diffSettledStats } from './controller';
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
    postSessionStatsSettled: vi.fn(),
    clearSessionStatsSettled: vi.fn(),
    postAgentEvent: vi.fn(),
    postAgentStatus: vi.fn(),
    postSessionReset: vi.fn(),
    postInstructionFiles: vi.fn(),
    postClaudeMemory: vi.fn(),
    postCodexMemory: vi.fn(),
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
    // Let the fire-and-forget _fetchSessionStats microtasks settle — and
    // the settled-tail path's extra hops (chain .then, RPC timeout race,
    // .finally) on top of them.
    for (let i = 0; i < 12; i++) await Promise.resolve();
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

  it('on agent_settled: fetches stats, stamps elapsed synchronously, pushes the footer', async () => {
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        return {
          type: 'response', success: true, command: 'get_session_stats',
          data: {
            tokens: {
              total: 210000,
              input: 100_000,
              output: 25_000,
              cacheRead: 80_000,
              cacheWrite: 5_000,
            },
            cost: 0.45,
            totalMessages: 12,
          },
        };
      }
      return { type: 'response', success: true, command: cmd.type };
    });

    // Queue the unsettled run to mimic sendPrompt's stamp. `_sessionStartedAt`
    // is deliberately older to prove the formatter uses the TURN origin,
    // not session age, when both are present.
    const turnStart = Date.now() - 690_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrl as any)._pendingRuns.push({ turnId: (ctrl as any)._currentTurnId, startedAt: turnStart });
    ctrl._sessionStartedAt = turnStart - 60_000;
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();

    // agent_settled fires ONLY the footer path — the status bar's
    // postSessionStats runs from agent_end / turn_end / compaction_end,
    // not from settled (which intentionally does its own fetch to avoid
    // sharing the seq-guard).
    expect(provider.postSessionStats).not.toHaveBeenCalled();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const settledStats: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    expect(settledStats.tokens).toEqual({
      input: 100_000,
      output: 25_000,
      cacheRead: 80_000,
      cacheWrite: 5_000,
    });
    expect(settledStats.totalCost).toBe(0.45);
    expect(settledStats.startedAt).toBe(turnStart - 60_000);
    // elapsedMs is frozen at settle time and reflects the TURN duration
    // (~11m 30s since turn start), not the session age (~12m 30s). Allow
    // jitter — the synchronous capture can run a few ms later than the
    // exact turn boundary.
    expect(settledStats.elapsedMs).toBeGreaterThanOrEqual(690_000);
    expect(settledStats.elapsedMs).toBeLessThan(700_000);
    // After settled, the queue entry must be consumed so the next user
    // turn gets a fresh stamp.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctrl as any)._pendingRuns).toHaveLength(0);
  });

  it('agent_start is a pure streaming toggle — it does NOT bump turn id or stamp turn origin', () => {
    // Turn identity is stamped host-side at `sendPrompt` time, NOT on
    // agent_start. Multi-iteration tool loops re-fire agent_start and
    // those must NOT bump the turn id (which would invalidate an in-
    // flight settled fetch without a real new user prompt).
    const { ctrl } = makeControllerForStats(() => ({ type: 'response', success: true, command: 'get_session_stats' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seqRef = ctrl as unknown as { _settledFetchSeq: number; _currentTurnId: number };
    const turnIdBefore = seqRef._currentTurnId;
    const seqBefore = seqRef._settledFetchSeq;

    // Iterate freely — agent_start, agent_end, agent_start — none of
    // these should touch turn identity or settled seq.
    ctrl._trackStreaming({ type: 'agent_start' });
    ctrl._trackStreaming({ type: 'agent_end' });
    ctrl._trackStreaming({ type: 'agent_start' });
    ctrl._trackStreaming({ type: 'agent_end' });
    ctrl._trackStreaming({ type: 'agent_start' });

    expect(seqRef._currentTurnId).toBe(turnIdBefore);
    expect(seqRef._settledFetchSeq).toBe(seqBefore);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctrl as any)._pendingRuns).toHaveLength(0); // stamping happens at sendPrompt, not here
  });

  it('sendPrompt queues the unsettled run and bumps turn id (host-side user-prompt boundary)', async () => {
    // sendPrompt is the turn-boundary marker. It MUST:
    //  - push a pending run stamped with Date.now() and the POST-bump
    //    turn id (so this run's settled fetch passes the live-id guard
    //    while older runs' fetches fail it)
    //  - bump _currentTurnId
    //  - bump _settledFetchSeq (to invalidate any stale in-flight settled
    //    fetch from the previous turn)
    //  - clear the provider's replay cache via clearSessionStatsSettled()
    const { ctrl, provider } = makeControllerForStats(() => ({ type: 'response', success: true, command: 'get_session_stats' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async () => ({ type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } })),
    };
    const turnIdBefore = state._currentTurnId;
    const seqBefore = state._settledFetchSeq;
    await ctrl.sendPrompt('hello');
    expect(state._pendingRuns).toHaveLength(1);
    expect(typeof state._pendingRuns[0].startedAt).toBe('number');
    expect(state._pendingRuns[0].turnId).toBe(turnIdBefore + 1);
    expect(state._currentTurnId).toBe(turnIdBefore + 1);
    expect(state._settledFetchSeq).toBe(seqBefore + 1);
    expect(provider.clearSessionStatsSettled).toHaveBeenCalledTimes(1);
  });

  it('a rejected prompt leaves zero trace: no queue entry, no id/seq bumps, no cache wipe', async () => {
    // pi rejecting the prompt (success:false) must roll everything back:
    // the next agent_settled must not dequeue a phantom run and attribute
    // elapsed time to a prompt that never ran, and an in-flight settled
    // footer from the PREVIOUS turn must not be dropped by id/seq bumps.
    const { ctrl, provider } = makeControllerForStats(() => ({ type: 'response', success: true, command: 'get_session_stats' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async () => ({ type: 'response', success: false, command: 'prompt', error: 'busy' })),
    };
    const turnIdBefore = state._currentTurnId;
    const seqBefore = state._settledFetchSeq;
    await expect(ctrl.sendPrompt('hello')).rejects.toThrow(/prompt rejected/);
    expect(state._pendingRuns).toHaveLength(0);
    expect(state._currentTurnId).toBe(turnIdBefore);
    expect(state._settledFetchSeq).toBe(seqBefore);
    expect(provider.clearSessionStatsSettled).not.toHaveBeenCalled();
  });

  it('a thrown send (transport died mid-RPC) also leaves zero trace', async () => {
    const { ctrl, provider } = makeControllerForStats(() => ({ type: 'response', success: true, command: 'get_session_stats' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async () => { throw new Error('transport closed'); }),
    };
    const turnIdBefore = state._currentTurnId;
    const seqBefore = state._settledFetchSeq;
    await expect(ctrl.sendPrompt('hello')).rejects.toThrow(/transport closed/);
    expect(state._pendingRuns).toHaveLength(0);
    expect(state._currentTurnId).toBe(turnIdBefore);
    expect(state._settledFetchSeq).toBe(seqBefore);
    expect(provider.clearSessionStatsSettled).not.toHaveBeenCalled();
  });

  it('session-generation reset clears a stale settled baseline (non-resume restart / onNewSession must not reuse it)', () => {
    // Both `onNewSession` and `_doStart` delegate to
    // `_resetSessionGenerationState`. A non-resume restart (pi crash,
    // fresh session) that kept the previous session's cumulative
    // baseline would diff the new session against it — bogus first
    // footer — and a leftover baseline would block `_seedBaseline` from
    // writing the pre-disconnect state on resume.
    const { ctrl } = makeControllerForStats(() => ({ type: 'response', success: true, command: 'get_session_stats' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._lastSettledStats = {
      totalTokens: 999, totalCost: 9.99, totalMessages: 99,
      tokens: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
    };
    state._pendingRuns.push({ turnId: state._currentTurnId, startedAt: Date.now() - 1000 });
    state._pendingBaselineReset = state._sessionGen;
    state._seedBaselinePromise = Promise.resolve();
    const seqBefore = state._settledFetchSeq;
    const genBefore = state._sessionGen;

    state._resetSessionGenerationState();

    expect(state._lastSettledStats).toBeNull();
    expect(state._pendingRuns).toHaveLength(0);
    expect(state._pendingBaselineReset).toBeNull();
    expect(state._seedBaselinePromise).toBeUndefined();
    expect(state._settledFetchSeq).toBeGreaterThan(seqBefore);
    expect(state._sessionGen).toBe(genBefore + 1);
  });

  it('on agent_settled when the RPC fails, the webview footer push is skipped (no spurious empty snapshot)', async () => {
    const { ctrl, provider } = makeControllerForStats(() => ({
      type: 'response', success: false, command: 'get_session_stats', error: 'nope',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrl as any)._pendingRuns.push({ turnId: (ctrl as any)._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    // The failed turn's usage window is lost — the baseline-reset flag
    // must be raised so the NEXT footer posts honestly (as-is cumulative)
    // instead of silently merging this turn into itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctrl as any)._pendingBaselineReset).toBe((ctrl as any)._sessionGen);
  });

  it('agent_settled fetch uses an INDEPENDENT seq-guard so a concurrent status-bar fetch cannot skip the footer', async () => {
    // Reproduces the review's original bug: a status-bar refresh was
    // seq-guarding the settled fetch out. With the dedicated
    // _settledFetchSeq counter, the footer fires regardless.
    //
    // We simulate concurrency by hooking an RPC factory that returns a
    // never-resolving promise for the FIRST call (the status-bar fetch)
    // and an immediate response for the SECOND (the settled fetch). After
    // both, the settled fetch must have posted.
    let calls = 0;
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      calls += 1;
      if (calls === 1) {
        // Never resolves in this test — the in-flight status-bar fetch.
        return new Promise(() => {}) as never;
      }
      return {
        type: 'response', success: true, command: 'get_session_stats',
        data: { tokens: { total: 1 }, cost: 0, totalMessages: 1 },
      };
    });

    // Fire a status-bar refresh that gets stuck on the never-resolving RPC.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (ctrl as any)._fetchSessionStats();
    // Let the in-flight call bump _statsFetchSeq.
    await Promise.resolve();

    // Now fire agent_settled. Despite the status-bar fetch being stuck
    // (it bumped _statsFetchSeq but never resolves), the settled path
    // uses its OWN counter and posts the footer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrl as any)._pendingRuns.push({ turnId: (ctrl as any)._currentTurnId, startedAt: Date.now() - 60_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();

    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    expect(provider.postSessionStatsSettled.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(60_000);
  });

  it('onNewSession clears the cached footer so a webview reload does not replay the previous turn', async () => {
    // Drive the path through the public controller method, not via a
    // direct mock call — the mock only proves the mock was called,
    // not that the controller actually fires it.
    const { controller, provider } = makeController(() => ({
      type: 'response', success: true, command: 'get_commands', data: { commands: [] },
    }));
    controller.onNewSession({ clearTranscript: false });
    expect(provider.clearSessionStatsSettled).toHaveBeenCalledTimes(1);
  });

  it('onNewSession bumps _settledFetchSeq so an in-flight settled fetch from the old session cannot push', async () => {
    // Hang the FIRST RPC (simulating an in-flight _fetchSettledStats
    // already started before onNewSession was called). The seq counter
    // must advance by ≥1 inside onNewSession so the hanging RPC fails
    // its seq-guard when it eventually resolves.
    let firstCallStarted = false;
    let resolveFirst: () => void = () => {};
    const { controller } = makeController((cmd) => {
      if (cmd.type === 'get_commands' && !firstCallStarted) {
        firstCallStarted = true;
        return new Promise<unknown>((res) => { resolveFirst = () => res({ type: 'response', success: true, command: 'get_commands', data: { commands: [] } }); }) as never;
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = controller as any;
    const seqBefore = ctrl._settledFetchSeq;
    controller.onNewSession({ clearTranscript: false });
    expect(ctrl._settledFetchSeq).toBeGreaterThan(seqBefore);
    // Cleanup: resolve the hanging promise.
    resolveFirst();
  });

  it('two consecutive settled fires post per-turn deltas, not cumulative snapshots', async () => {
    // Mock returns progressively-growing cumulative numbers across two
    // get_session_stats calls in pi's wire shape (cost at top level,
    // tokens.* nested). First call's response seeds the baseline
    // (no prior); the second diffs against the first, so the posted
    // snapshot shows the delta (one turn's worth).
    let callIdx = 0;
    const cumulativeAt = (turn: number) => ({
      tokens: {
        total: 100_000 * turn,
        input: 1000 * turn,
        output: 200 * turn,
        cacheRead: 800 * turn,
        cacheWrite: 50 * turn,
      },
      cost: 0.10 * turn,
      totalMessages: 2,
    });
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      callIdx += 1;
      return {
        type: 'response', success: true, command: 'get_session_stats',
        data: cumulativeAt(callIdx),
      };
    });

    // Turn 1: no baseline → first settled posts as-is.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrl as any)._pendingRuns.push({ turnId: (ctrl as any)._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_start' });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const turn1 = provider.postSessionStatsSettled.mock.calls[0][0];
    expect(turn1.tokens).toEqual({
      input: 1000, output: 200, cacheRead: 800, cacheWrite: 50,
    });
    expect(turn1.totalCost).toBeCloseTo(0.10, 10);

    // Turn 2: cumulative grew by exactly "one turn" worth. The posted
    // delta must show the per-turn numbers (1000/200/800/50, $0.10),
    // NOT the cumulative totals (2000/400/1600/100, $0.20).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrl as any)._pendingRuns.push({ turnId: (ctrl as any)._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(2);
    const turn2 = provider.postSessionStatsSettled.mock.calls[1][0];
    expect(turn2.tokens).toEqual({
      input: 1000, output: 200, cacheRead: 800, cacheWrite: 50,
    });
    expect(turn2.totalCost).toBeCloseTo(0.10, 10);
  });

  it('overlapping settled tails are serialized: the older miss cannot poison a newer written baseline', async () => {
    // The poisoning order the chain prevents: A's fetch in flight → B
    // settles and its fetch completes FIRST, writing a valid baseline →
    // A's fetch resolves superseded → A's miss raises the reset flag →
    // the NEXT turn diffs against null (whole session as one footer).
    // With serialized tails B's fetch cannot even be issued before A's
    // tail finished, so "B completes first" is unreachable by design;
    // this test pins the visible contract: A's miss raises the flag,
    // B's tail consumes it, exactly one honest footer, flag ends null.
    const pending: Array<(v: unknown) => void> = [];
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return new Promise<unknown>((res) => { pending.push(res); }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async (cmd: { type: string }) => {
        if (cmd.type === 'get_session_stats') {
          return new Promise<unknown>((res) => { pending.push(res); });
        }
        return { type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } };
      }),
    };
    const snapshot = (input: number) => ({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: input, input, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0.05, totalMessages: 2 },
    });

    await ctrl.sendPrompt('turn A');
    ctrl._trackStreaming({ type: 'agent_settled' });   // A tail: fetch hangs (pending[0])
    await flush();
    await ctrl.sendPrompt('turn B');                   // bumps seq/id → A's fetch will be superseded
    ctrl._trackStreaming({ type: 'agent_settled' });   // B tail: queued BEHIND A's tail
    await flush();
    // Only A's fetch is in flight — the chain holds B's back.
    expect(pending.length).toBe(1);
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();

    pending[0](snapshot(100));                         // A resolves → superseded miss
    await flush();
    await flush();   // extra pump: chain hop into B's tail + B's fetch registration
    // A's miss raised the recovery flag…
    expect(state._pendingBaselineReset).toBe(state._sessionGen);
    // …and only NOW did B's fetch get issued (serialized behind A's tail).
    expect(pending.length).toBe(2);

    pending[1](snapshot(200));                         // B's snapshot (cumulative incl. A)
    await flush();
    // Exactly one footer — B's — posted as honest cumulative (flag consumed).
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const footer: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    expect(footer.tokens?.input).toBe(200);
    expect(state._lastSettledStats?.tokens?.input).toBe(200);
    expect(state._pendingBaselineReset).toBeNull();
    expect(state._pendingRuns).toHaveLength(0);
  });

  it('an unmatched agent_settled (empty queue) is a no-op — it must not invent a footer', async () => {
    // e.g. a stale settle delivered after a session/transport reset and
    // before any new prompt (reset → orphan → sendPrompt B). It must not
    // post, not write the baseline, not raise the recovery flag, not
    // touch pi with a fetch — and the next real turn must work normally.
    let statCalls = 0;
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') statCalls += 1;
      return { type: 'response', success: true, command: cmd.type };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;

    ctrl._trackStreaming({ type: 'agent_settled' });   // queue empty → no-op
    await flush();
    expect(statCalls).toBe(0);
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    expect(state._lastSettledStats).toBeNull();
    expect(state._pendingBaselineReset).toBeNull();

    // A later real turn is unaffected: prompt → settle → footer.
    state._transport = {
      isRunning: true,
      send: vi.fn(async () => ({ type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } })),
    };
    await ctrl.sendPrompt('real turn');
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
  });

  it('a settled tail queued across a generation change is voided (no seed wait, no fetch, no flag)', async () => {
    // A's tail sits on the chain when onNewSession bumps the generation.
    // The tail must not run at all: in particular it must NOT await the
    // NEW generation's resume seed (the test never resolves it — if the
    // tail awaited it, this test would hang), not fetch, not raise
    // `_pendingBaselineReset` for the new generation (which would
    // discard a successful resume seed), not post.
    const pending: Array<(v: unknown) => void> = [];
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return new Promise<unknown>((res) => { pending.push(res); }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async (cmd: { type: string }) => {
        if (cmd.type === 'get_session_stats') {
          return new Promise<unknown>((res) => { pending.push(res); });
        }
        return { type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } };
      }),
    };

    await ctrl.sendPrompt('turn A');
    ctrl._trackStreaming({ type: 'agent_settled' });   // A tail queued; fetch hangs
    await flush();
    expect(pending.length).toBe(1);

    ctrl.onNewSession({ clearTranscript: false });     // generation bump
    // Simulate a resume seeding the NEW generation while A's tail sits queued.
    state._seedBaselinePromise = new Promise<void>(() => {}); // never resolves
    const seedValue = {
      totalTokens: 5, totalCost: 0.01, totalMessages: 1,
      tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    state._lastSettledStats = seedValue;

    pending[0]({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: 999, input: 999, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 9, totalMessages: 9 },
    });
    await flush();
    await flush();

    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    expect(state._pendingBaselineReset).toBeNull();
    expect(state._lastSettledStats).toBe(seedValue);
    expect(state._pendingRuns).toHaveLength(0);
  });

  it('a generation reset un-wedges the footer chain (a hung tail cannot block future footers)', async () => {
    // The production wedge: a tail's get_session_stats RPC never resolves
    // (pi respawned mid-request). Here we simulate the wedge directly —
    // the chain is stuck — and verify _resetSessionGenerationState gives
    // the new generation a fresh chain so later settles still post.
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return {
        type: 'response', success: true, command: 'get_session_stats',
        data: { tokens: { total: 50, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.02, totalMessages: 1 },
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async (cmd: { type: string }) => {
        if (cmd.type === 'get_session_stats') {
          return { type: 'response', success: true, command: 'get_session_stats', data: { tokens: { total: 50, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.02, totalMessages: 1 } };
        }
        return { type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } };
      }),
    };

    // Wedge: a dead tail sits on the chain forever.
    state._settledFooterChain = new Promise<void>(() => {});
    await ctrl.sendPrompt('turn A');
    ctrl._trackStreaming({ type: 'agent_settled' });   // queues behind the wedge
    await flush();
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();

    // Transport restart / session switch: generation reset must hand the
    // next settle a FRESH chain.
    state._resetSessionGenerationState();
    state._pendingRuns.push({ turnId: state._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    await flush();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
  });

  it('a hung settled fetch times out: miss + recovery flag, and the next footer is honest-cumulative', async () => {
    // RPC lost to a pi respawn: the fetch neither resolves nor rejects.
    // The tail must give up after _settleRpcTimeoutMs, raise the recovery
    // flag, and keep the chain alive for the next settle.
    let responded = false;
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      // get_session_stats is served by the transport mock below; the
      // factory only sees the other commands (get_commands, …).
      if (cmd.type === 'get_session_stats') {
        return responded
          ? { type: 'response', success: true, command: 'get_session_stats', data: { tokens: { total: 70, input: 70, output: 7, cacheRead: 0, cacheWrite: 0 }, cost: 0.03, totalMessages: 2 } }
          : new Promise<unknown>(() => {}) as never;
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._settleRpcTimeoutMs = 10;
    state._transport = {
      isRunning: true,
      send: vi.fn(async (cmd: { type: string }) => {
        if (cmd.type === 'get_session_stats') {
          if (!responded) return new Promise<unknown>(() => {}); // hangs forever
          return { type: 'response', success: true, command: 'get_session_stats', data: { tokens: { total: 70, input: 70, output: 7, cacheRead: 0, cacheWrite: 0 }, cost: 0.03, totalMessages: 2 } };
        }
        return { type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } };
      }),
    };

    await ctrl.sendPrompt('turn A');
    ctrl._trackStreaming({ type: 'agent_settled' });
    await new Promise((r) => setTimeout(r, 40)); // let the 10 ms timeout win
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    expect(state._pendingBaselineReset).toBe(state._sessionGen);

    // Next turn: the fetch responds. The flag must make it post as-is
    // (honest cumulative) instead of silently merging the lost turn.
    responded = true;
    await ctrl.sendPrompt('turn B');
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    await flush();
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const footer: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    expect(footer.tokens?.input).toBe(70); // as-is, not diffed
    expect(state._pendingBaselineReset).toBeNull();
  });

  it('a hung resume seed times out and the footer still posts', async () => {
    // The seed's RPC was lost (never resolves). The settle must not hang
    // on it forever: after the timeout it proceeds with whatever baseline
    // exists and posts.
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return {
        type: 'response', success: true, command: 'get_session_stats',
        data: { tokens: { total: 42, input: 42, output: 4, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, totalMessages: 1 },
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._settleRpcTimeoutMs = 10;
    state._seedBaselinePromise = new Promise<void>(() => {}); // hangs forever

    state._pendingRuns.push({ turnId: state._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await new Promise((r) => setTimeout(r, 40));
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const footer: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    // No baseline available (seed never wrote) → honest cumulative as-is.
    expect(footer.tokens?.input).toBe(42);
  });

  it('a prompt accepted during the agent_end → agent_settled window cannot steal the finished run footer', async () => {
    // Sequence (the review's blocking race):
    //   1. sendPrompt A — queue: A (old origin, ~11.5 min ago).
    //   2. A settles; its stats fetch HANGS on a deferred RPC.
    //   3. sendPrompt B — new turn id, queue: B (fresh origin).
    //   4. A's fetch resolves. It must NOT post, must NOT write the
    //      baseline, and must leave B's queue entry (origin) intact.
    //   5. B settles. The footer must use B's origin for elapsed and be
    //      posted as an honest cumulative (baseline-reset semantics).
    const pending: Array<(v: unknown) => void> = [];
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return new Promise<unknown>((res) => { pending.push(res); }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._transport = {
      isRunning: true,
      send: vi.fn(async (cmd: { type: string }) => {
        if (cmd.type === 'get_session_stats') {
          return new Promise<unknown>((res) => { pending.push(res); });
        }
        return { type: 'response', success: true, command: 'prompt', data: { disposition: 'started' } };
      }),
    };
    const snapshot = (input: number) => ({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: input, input, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0.05, totalMessages: 2 },
    });

    await ctrl.sendPrompt('turn A');
    state._pendingRuns[0].startedAt = Date.now() - 690_000; // A ran ~11.5 min
    ctrl._trackStreaming({ type: 'agent_settled' });        // dequeues A; fetch hangs
    await flush();
    expect(pending.length).toBe(1);

    // User submits the next prompt while A's settle fetch is in flight.
    await ctrl.sendPrompt('turn B');
    state._pendingRuns[0].startedAt = Date.now() - 5_000;   // B just started

    pending[0](snapshot(100));
    await flush();
    // A's post is dropped (turn id rolled) …
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    // … no baseline was written from it …
    expect(state._lastSettledStats).toBeNull();
    // … the lost attribution window is flagged for B's footer …
    expect(state._pendingBaselineReset).toBe(state._sessionGen);
    // … and B's queue entry — its origin — is untouched.
    expect(state._pendingRuns).toHaveLength(1);

    ctrl._trackStreaming({ type: 'agent_settled' });        // dequeues B
    await flush();
    expect(pending.length).toBe(2);
    pending[1](snapshot(200));                              // cumulative grew
    await flush();

    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const footer: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    // Elapsed from B's origin (~5 s), not A's (~11.5 min) and not ~0.
    expect(footer.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(footer.elapsedMs).toBeLessThan(60_000);
    // Baseline-reset semantics: posted as-is cumulative, not diffed.
    expect(footer.tokens?.input).toBe(200);
    expect(state._pendingRuns).toHaveLength(0);
    expect(state._pendingBaselineReset).toBeNull();
  });

  it('agent_settled serializes on an in-flight resume seed before fetching (no null-diff footer)', async () => {
    // Resume flow: _doStart stored the seed promise; agent_settled must
    // await it BEFORE issuing its fetch, so the footer diffs against the
    // seeded baseline instead of racing the seed into a null diff (which
    // would render the entire session as one turn).
    let statCalls = 0;
    let resolveSeed!: () => void;
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      statCalls += 1;
      return {
        type: 'response', success: true, command: 'get_session_stats',
        data: { tokens: { total: 2000, input: 2000, output: 400, cacheRead: 0, cacheWrite: 0 }, cost: 0.20, totalMessages: 4 },
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    state._seedBaselinePromise = new Promise<void>((res) => { resolveSeed = res; });
    // What the seed will have written when it resolves: pre-disconnect
    // cumulative (input 1000 / output 200 / cost $0.10).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seedBaseline: SessionStats = {
      totalTokens: 1000, totalCost: 0.10, totalMessages: 2,
      tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    } as unknown as SessionStats;

    state._pendingRuns.push({ turnId: state._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    // While the seed hangs, the settled fetch must not even fire — the
    // settle serializes on the seed instead of racing it.
    expect(statCalls).toBe(0);
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();

    state._lastSettledStats = seedBaseline; // seed resolves & writes
    resolveSeed();
    await flush();

    expect(statCalls).toBe(1);
    expect(provider.postSessionStatsSettled).toHaveBeenCalledTimes(1);
    const footer: SessionStats = provider.postSessionStatsSettled.mock.calls[0][0];
    // Delta against the seeded baseline (2000−1000), not the cumulative.
    expect(footer.tokens?.input).toBe(1000);
    expect(footer.totalCost).toBeCloseTo(0.10, 10);
  });

  it('_seedBaseline drops its write when a settled fetch beat it (turn id locked, but _lastSettledStats already set)', async () => {
    // Sequence:
    //   1. _seedBaseline fires (e.g. on session resume).
    //   2. While the seed RPC is in flight, a settled fetch lands first and
    //      stores a newer snapshot in _lastSettledStats.
    //   3. The seed RPC resolves. It must NOT clobber the newer snapshot.
    let resolveSeed!: (response: unknown) => void;
    let resolveSettled!: (response: unknown) => void;
    const seedPromise = new Promise<unknown>((res) => { resolveSeed = res; });
    const settledPromise = new Promise<unknown>((res) => { resolveSettled = res; });

    let callIdx = 0;
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') {
        callIdx += 1;
        return callIdx === 1 ? seedPromise : settledPromise;
      }
      return { type: 'response', success: true, command: cmd.type };
    });
    void provider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;

    // Kick off the seed (simulates resume: caller invokes _seedBaseline).
    const seedPromise2 = state._seedBaseline();
    await Promise.resolve(); // let the seed's RPC request register

    // While the seed is in flight, fire a settled. The settled fetch
    // races with the seed for the same get_session_stats call slot,
    // so this test uses a stronger guarantee: drop the seed on
    // turn-id mismatch OR when _lastSettledStats already has a value.
    state._pendingRuns.push({ turnId: state._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    // Resolve BOTH: settled first (wins), then seed arrives. The settled
    // fetch completes and stores into _lastSettledStats; the seed's
    // guard refuses to overwrite.
    resolveSettled({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: 5000, input: 5000, output: 1000, cacheRead: 3000, cacheWrite: 200 }, cost: 0.30, totalMessages: 3 },
    });
    await flush();
    expect(state._lastSettledStats).not.toBeNull();

    const baselineBefore = state._lastSettledStats;
    resolveSeed({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: 999 }, cost: 999 },
    });
    await seedPromise2;
    // The seed's write must NOT have happened: _lastSettledStats is
    // unchanged from the settled fetch's snapshot.
    expect(state._lastSettledStats).toBe(baselineBefore);
    expect(state._lastSettledStats.tokens?.input).toBe(5000);
  });

  it('_seedBaseline drops its write when the turn id rolls over before it resolves', async () => {
    // Scenarios: seed started at resume, but the user fired a fresh
    // sendPrompt while the seed RPC was in flight. The seed must NOT
    // overwrite _lastSettledStats — that would set the baseline from
    // the OLD (pre-prompt) session.
    let resolveSeed!: (response: unknown) => void;
    const seedPromise = new Promise<unknown>((res) => { resolveSeed = res; });

    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type === 'get_session_stats') return seedPromise;
      return { type: 'response', success: true, command: cmd.type };
    });
    void provider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ctrl as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state._transport = { ...state._transport, isRunning: true };

    // Kick off the seed.
    const seedPromise2 = state._seedBaseline();
    await Promise.resolve();

    // Bump the turn id (simulating sendPrompt landing while seed in-flight).
    state._currentTurnId += 1;
    const turnIdAfter = state._currentTurnId;

    // Now resolve the seed. The guard must reject.
    resolveSeed({
      type: 'response', success: true, command: 'get_session_stats',
      data: { tokens: { total: 999 }, cost: 999 },
    });
    await seedPromise2;
    expect(state._lastSettledStats).toBeNull();
    expect(state._currentTurnId).toBe(turnIdAfter);
  });

  it('a resolved settled fetch is dropped when the turn id has rolled over', async () => {
    // Wire a settled fetch that hangs forever. The `.then` capture the
    // turn id BEFORE awaiting; rolling the turn id forward (mimicking a
    // fresh user prompt's sendPrompt) must make the eventual resolution
    // a no-op: no post, no _lastSettledStats mutation.
    let resolveStaleFetch!: (response: unknown) => void;
    const staleFetchPromise = new Promise<unknown>((res) => { resolveStaleFetch = res; });
    const { ctrl, provider } = makeControllerForStats((cmd) => {
      if (cmd.type !== 'get_session_stats') {
        return { type: 'response', success: true, command: cmd.type };
      }
      return staleFetchPromise as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrlAny = ctrl as any;

    ctrl._trackStreaming({ type: 'agent_start' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctrlAny as any)._pendingRuns.push({ turnId: ctrlAny._currentTurnId, startedAt: Date.now() - 1_000 });
    ctrl._trackStreaming({ type: 'agent_settled' });
    await flush();
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();

    // Simulate the user sending a new prompt — turn id rolls forward.
    const turnIdBefore = ctrlAny._currentTurnId;
    ctrlAny._currentTurnId = turnIdBefore + 1;

    // Now the hung RPC eventually resolves. The .then's turn-id check
    // must reject: no post, no baseline mutation.
    resolveStaleFetch({
      type: 'response', success: true, command: 'get_session_stats',
      data: {
        tokens: { total: 9999, input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999 },
        cost: 9.99,
        totalMessages: 99,
      },
    });
    await flush();
    expect(provider.postSessionStatsSettled).not.toHaveBeenCalled();
    expect(ctrlAny._lastSettledStats).toBeNull();
  });
});

// ─── diffSettledStats tests (per-turn footer deltas) ──────────────────────────

describe('diffSettledStats', () => {
  it('returns current as-is when there is no previous snapshot (first turn of session)', () => {
    const cur: SessionStats = {
      totalTokens: 100_000,
      totalCost: 0.45,
      totalMessages: 5,
      tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 50 },
      elapsedMs: 60_000,
      startedAt: 1,
    };
    expect(diffSettledStats(cur, null)).toEqual(cur);
  });

  it('diffs cumulative fields into per-turn deltas (the whole point of the helper)', () => {
    const prev: SessionStats = {
      totalTokens: 0, totalMessages: 0,
      totalCost: 0.45,
      tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 50 },
    };
    const cur: SessionStats = {
      totalTokens: 0, totalMessages: 0,
      totalCost: 0.55,
      tokens: { input: 1500, output: 350, cacheRead: 1200, cacheWrite: 80 },
    };
    const out = diffSettledStats(cur, prev);
    expect(out.totalCost).toBeCloseTo(0.10, 10);
    expect(out.tokens).toEqual({
      input: 500, output: 150, cacheRead: 400, cacheWrite: 30,
    });
    // Cumulative non-delta fields are dropped so the footer only carries
    // per-turn semantics.
    expect(out.totalTokens).toBeNull();
    expect(out.totalMessages).toBeNull();
    expect(out.startedAt).toBeUndefined();
  });

  it('clamps non-positive deltas to null (provider counters can reset)', () => {
    const prev: SessionStats = {
      totalTokens: 0, totalMessages: 0,
      totalCost: 0.55,
      tokens: { input: 1500, output: 350, cacheRead: 1200, cacheWrite: 80 },
    };
    const cur: SessionStats = {
      totalTokens: 0, totalMessages: 0,
      totalCost: 0.30, // went DOWN
      tokens: { input: 1500, output: 350, cacheRead: 1100, cacheWrite: 80 }, // cacheRead went DOWN
    };
    const out = diffSettledStats(cur, prev);
    expect(out.totalCost).toBeNull();
    expect(out.tokens).toEqual({
      input: null, output: null, cacheRead: null, cacheWrite: null,
    });
  });

  it('preserves elapsedMs from current (per-turn, frozen at settle)', () => {
    const cur: SessionStats = { totalTokens: 0, totalMessages: 0, elapsedMs: 30_000, totalCost: 0.10 };
    const prev: SessionStats = { totalTokens: 0, totalMessages: 0, elapsedMs: 60_000, totalCost: 0.05 };
    expect(diffSettledStats(cur, prev).elapsedMs).toBe(30_000);
  });

  it('treats missing previous tokens as zeros (a snapshot from old pi diffs cleanly)', () => {
    const prev: SessionStats = { totalTokens: 0, totalMessages: 0, totalCost: 0.10 };
    const cur: SessionStats = {
      totalTokens: 0, totalMessages: 0,
      totalCost: 0.20,
      tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5 },
    };
    expect(diffSettledStats(cur, prev).tokens).toEqual({
      input: 100, output: 20, cacheRead: 50, cacheWrite: 5,
    });
  });
});

// ─── parseTokenBuckets tests ────────────────────────────────────────────────

describe('parseTokenBuckets', () => {
  it('extracts the four per-bucket counts from pi tokens response', () => {
    expect(
      parseTokenBuckets({ input: 100, output: 25, cacheRead: 80, cacheWrite: 5 }),
    ).toEqual({ input: 100, output: 25, cacheRead: 80, cacheWrite: 5 });
  });

  it('preserves null vs 0 distinction (0 is a real measurement, null is unknown)', () => {
    expect(
      parseTokenBuckets({ input: 0, output: null, cacheRead: null, cacheWrite: null }),
    ).toEqual({ input: 0, output: null, cacheRead: null, cacheWrite: null });
  });

  it('coerces numeric strings', () => {
    expect(
      parseTokenBuckets({ input: '1000', output: '500', cacheRead: 0, cacheWrite: 5 }),
    ).toEqual({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 5 });
  });

  it('returns undefined for null/non-object input', () => {
    expect(parseTokenBuckets(null)).toBeUndefined();
    expect(parseTokenBuckets(undefined)).toBeUndefined();
    expect(parseTokenBuckets('garbage')).toBeUndefined();
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

  it('forwards a codexMemory report from the bridge to provider.postCodexMemory', () => {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (controller as any)._uiBridge;
    bridge.handleEvent({
      type: 'extension_ui_request',
      id: 'm3',
      method: 'setStatus',
      statusKey: 'wingman:codexMemory',
      statusText: JSON.stringify({
        dir: '/codex/memories_v2',
        count: 1,
        files: [{ path: '/codex/memories_v2/memory_summary.md', title: 'memory_summary.md' }],
      }),
    });
    expect(provider.postCodexMemory).toHaveBeenCalledTimes(1);
    const info = provider.postCodexMemory.mock.calls[0][0] as { dir: string; files: unknown[] };
    expect(info.dir).toBe('/codex/memories_v2');
    expect(info.files).toHaveLength(1);
    // The claude callback must not have fired for a codex report.
    expect(provider.postClaudeMemory).not.toHaveBeenCalled();
  });

  it('forwards null to provider.postCodexMemory on a malformed report', () => {
    const controller = new AgentController();
    const provider = makeProvider();
    controller.setProvider(provider as unknown as WingmanViewProvider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (controller as any)._uiBridge;
    bridge.handleEvent({
      type: 'extension_ui_request',
      id: 'm4',
      method: 'setStatus',
      statusKey: 'wingman:codexMemory',
      statusText: 'NOT JSON',
    });
    expect(provider.postCodexMemory).toHaveBeenCalledWith(null);
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

// ─── setExtraEnv (WINGMAN_* namespace guard) ──────────────────────────────────

describe('AgentController.setExtraEnv()', () => {
  it('keeps WINGMAN_* keys and drops everything else', () => {
    const { controller } = makeController(() => ({ type: 'response', success: true }));
    controller.setExtraEnv({
      WINGMAN_CURRENT_DATE_TEMPLATE: 'Today is {{date}}.',
      WINGMAN_CURRENT_DATE: 'off',
      PATH: '/evil/bin',
      HOME: '/tmp/evil',
      TZ: 'Europe/Budapest',
      WINGMAN_: 'bare prefix',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((controller as any)._extraEnv).toEqual({
      WINGMAN_CURRENT_DATE_TEMPLATE: 'Today is {{date}}.',
      WINGMAN_CURRENT_DATE: 'off',
    });
  });

  it('logs the rejected keys to the diagnostics channel', () => {
    const { controller } = makeController(() => ({ type: 'response', success: true }));
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._outputChannel = { appendLine: (m: string) => lines.push(m) };

    controller.setExtraEnv({ PATH: '/evil/bin', WINGMAN_CURRENT_DATE: 'off' });

    expect(lines.join('\n')).toContain('ignored non-WINGMAN_* key(s): PATH');
  });

  it('replaces rather than merges on a second call', () => {
    const { controller } = makeController(() => ({ type: 'response', success: true }));
    controller.setExtraEnv({ WINGMAN_CURRENT_DATE: 'off' });
    controller.setExtraEnv({ WINGMAN_CURRENT_DATE_TEMPLATE: 'x' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((controller as any)._extraEnv).toEqual({ WINGMAN_CURRENT_DATE_TEMPLATE: 'x' });
  });
});
