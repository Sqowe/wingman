/**
 * Smoke tests for the WingmanStatusBar — the always-visible session-stats status bar item.
 *
 * Verifies that `update(stats)` sets the 1-line text via formatContextText and the tooltip
 * via formatContextTooltipBody. Model info is intentionally NOT shown here (it lives on the
 * adjacent ModelStatusBar) — the regression assertion enforces that.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WingmanStatusBar, ModelStatusBar } from './status-bar';
import type { SessionStats, ModelState } from './shared/messages';
import { MarkdownString, StatusBarItem } from './__mocks__/vscode';

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({
  totalTokens: null,
  totalCost: null,
  totalMessages: null,
  ...over,
});

describe('WingmanStatusBar', () => {
  let bar: WingmanStatusBar;
  let item: StatusBarItem;

  beforeEach(() => {
    bar = new WingmanStatusBar();
    // The constructor calls createStatusBarItem; the mock returns a fresh
    // StatusBarItem each time, so we read it via the exposed text/tooltip.
    item = (bar as unknown as { _item: StatusBarItem })._item;
  });

  it('starts with the idle label', () => {
    expect(item.text).toBe('$(hubot) Wingman');
  });

  it('update() sets the 1-line text to the context fraction + percent + messages', () => {
    bar.update(stats({
      totalMessages: 85,
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6 },
    }));
    // 12.4k / 200k · 6 · 85 msg — exact format from formatContextText.
    expect(item.text).toBe('$(hubot) 12.4k tok / 200k tok · 6 · 85 msg');
  });

  it('update() sets the tooltip body to the context + messages two-liner', () => {
    bar.update(stats({
      totalMessages: 85,
      contextUsage: { tokens: 12_400, contextWindow: 200_000, percent: 6 },
    }));
    const tip = item.tooltip;
    expect(tip).toBeInstanceOf(MarkdownString);
    const value = (tip as MarkdownString).value;
    expect(value).toBe(
      '**Sqowe Wingman**\n\n' +
      'Context: 12.4k tok / 200k tok (6 %)\n' +
      'Messages: 85',
    );
  });

  it('update() does NOT mention model / thinking in either text or tooltip', () => {
    bar.update(stats({
      totalMessages: 5,
      contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 1 },
    }));
    // Both surfaces must stay model-free — the adjacent ModelStatusBar covers that.
    expect(item.text).not.toMatch(/model/i);
    expect(item.text).not.toMatch(/thinking/i);
    const tip = item.tooltip as MarkdownString;
    expect(tip.value).not.toMatch(/model/i);
    expect(tip.value).not.toMatch(/thinking/i);
  });

  it('update() does NOT include a cost slot', () => {
    bar.update(stats({
      totalMessages: 5,
      contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 1 },
    }));
    // Strip the VS Code icon prefix `$(hubot) ` before checking — it contains `$`
    // as part of the codicon syntax, which is not what we're testing.
    const textBody = item.text.replace(/^\$\([^)]+\)\s*/, '');
    expect(textBody).not.toMatch(/\$/);
    expect(textBody).not.toMatch(/cost/i);
  });

  it('update() handles the post-compaction transient with the known window', () => {
    bar.update(stats({
      totalMessages: 5,
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    }));
    // The bar text must keep the denominator visible (so the user understands the window size).
    expect(item.text).toBe('$(hubot) — / 200k tok · — · 5 msg');
    const tip = item.tooltip as MarkdownString;
    expect(tip.value).toContain('compacting');
    expect(tip.value).toContain('200k tok window');
  });

  it('update() falls back to session totals when contextUsage is absent', () => {
    bar.update(stats({ totalTokens: 105_000, totalMessages: 22 }));
    expect(item.text).toBe('$(hubot) 105k tok · 22 msg');
    const tip = item.tooltip as MarkdownString;
    // Tooltip collapses to a single messages line when contextUsage is absent.
    expect(tip.value).toBe('**Sqowe Wingman**\n\nMessages: 22');
  });

  it('reset() restores the idle label and tooltip', () => {
    bar.update(stats({ totalMessages: 5 }));
    bar.reset();
    expect(item.text).toBe('$(hubot) Wingman');
    expect(item.tooltip).toBe('Sqowe Wingman — session statistics');
  });

  it('dispose() is safe to call and disposes the underlying item', () => {
    expect(() => bar.dispose()).not.toThrow();
  });
});

describe('ModelStatusBar (regression: not affected by context-window refactor)', () => {
  // The ModelStatusBar is unchanged in this feature, but we keep a minimal
  // smoke test so that any accidental refactor that touches the shared
  // stats-format module is caught here too.

  let bar: ModelStatusBar;
  let item: StatusBarItem;

  const modelState = (over: Partial<ModelState> = {}): ModelState => ({
    modelId: null,
    modelName: null,
    provider: null,
    thinkingLevel: null,
    supportsImages: false,
    ...over,
  });

  beforeEach(() => {
    bar = new ModelStatusBar();
    item = (bar as unknown as { _item: StatusBarItem })._item;
  });

  it('starts with the idle label', () => {
    expect(item.text).toBe('$(sparkle) Model');
  });

  it('update() renders model · thinking when both are known', () => {
    bar.update(modelState({ modelName: 'HY3', thinkingLevel: 'high' }));
    expect(item.text).toBe('$(sparkle) HY3 · high');
  });
});