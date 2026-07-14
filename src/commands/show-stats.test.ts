/**
 * Unit tests for the showStats command handler.
 *
 * Covers the three output shapes per docs/design/context-window-indicator.md §7.3:
 *  - no stats yet (controller.lastSessionStats === null) → idle message
 *  - stats with contextUsage → popup includes the context line
 *  - stats without contextUsage → popup omits the context line, falls back to tokens
 *
 * Cost is intentionally NOT shown — enforced as a regression assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => import('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { showStats } from './show-stats';
import type { SessionStats } from '../shared/messages';

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({
  totalTokens: null,
  totalCost: null,
  totalMessages: null,
  ...over,
});

function makeController(statsValue: SessionStats | null) {
  return {
    lastSessionStats: statsValue,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('showStats — idle state', () => {
  it('shows an idle message when no stats have been reported yet', async () => {
    const controller = makeController(null);
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    await showStats(controller as never);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toBe('Sqowe Wingman: no session stats yet.');
  });
});

describe('showStats — stats with contextUsage', () => {
  it('renders context + tokens + messages and omits cost', async () => {
    const controller = makeController(stats({
      totalTokens: 105_000,
      totalMessages: 85,
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6 },
    }));
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    await showStats(controller as never);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const message = infoSpy.mock.calls[0][0] as string;
    expect(message).toContain('Context: 12.4k / 200k tok (6%)');
    expect(message).toContain('Tokens: 105k tok');
    expect(message).toContain('Messages: 85');
    // Cost must be dropped — enforced regression.
    expect(message).not.toMatch(/cost/i);
    expect(message).not.toMatch(/\$\d/);
  });

  it('uses em-dashes for missing contextUsage fields (partial / post-compaction)', async () => {
    // Post-compaction transient: tokens and percent are null but the window is known.
    const controller = makeController(stats({
      totalTokens: 50_000,
      totalMessages: 20,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    }));
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    await showStats(controller as never);
    const message = infoSpy.mock.calls[0][0] as string;
    // fraction is null (tokens is null) → no Context: line is emitted
    expect(message).not.toMatch(/Context:/);
    // Fallback to tokens + messages
    expect(message).toContain('Tokens: 50k tok');
    expect(message).toContain('Messages: 20');
  });
});

describe('showStats — stats without contextUsage (fallback)', () => {
  it('renders tokens + messages and omits the context line', async () => {
    const controller = makeController(stats({
      totalTokens: 5000,
      totalMessages: 4,
    }));
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    await showStats(controller as never);
    const message = infoSpy.mock.calls[0][0] as string;
    expect(message).not.toMatch(/Context:/);
    expect(message).toContain('Tokens: 5k tok');
    expect(message).toContain('Messages: 4');
  });
});