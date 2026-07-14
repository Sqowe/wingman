/**
 * Unit tests for the model-label formatters used by the model status bar.
 */
import { describe, it, expect } from 'vitest';
import {
  formatModelLabel,
  formatModelStatus,
  formatTokens,
  formatCost,
  formatMessages,
  formatPercent,
  formatContextFraction,
  formatContextText,
  formatContextTooltipBody,
} from './stats-format';
import type { ModelState, SessionStats } from './messages';

const state = (over: Partial<ModelState> = {}): ModelState => ({
  modelId: null,
  modelName: null,
  provider: null,
  thinkingLevel: null,
  supportsImages: false,
  ...over,
});

describe('formatModelLabel', () => {
  it('prefers the human name', () => {
    expect(formatModelLabel(state({ modelName: 'HY3 Preview', modelId: 'tencent/hy3-preview' }))).toBe('HY3 Preview');
  });

  it('falls back to the last path segment of the id', () => {
    expect(formatModelLabel(state({ modelId: 'tencent/hy3-preview' }))).toBe('hy3-preview');
    expect(formatModelLabel(state({ modelId: 'claude-sonnet-4.6' }))).toBe('claude-sonnet-4.6');
  });

  it('returns a dash when nothing is known', () => {
    expect(formatModelLabel(null)).toBe('—');
    expect(formatModelLabel(state())).toBe('—');
  });
});

describe('formatModelStatus', () => {
  it('appends the thinking level', () => {
    expect(formatModelStatus(state({ modelName: 'HY3 Preview', thinkingLevel: 'high' }))).toBe('HY3 Preview · high');
  });

  it('omits the thinking level when none/off/absent', () => {
    expect(formatModelStatus(state({ modelName: 'M', thinkingLevel: 'none' }))).toBe('M');
    expect(formatModelStatus(state({ modelName: 'M', thinkingLevel: 'off' }))).toBe('M');
    expect(formatModelStatus(state({ modelName: 'M' }))).toBe('M');
  });

  it('combines the id fallback with the thinking level', () => {
    expect(formatModelStatus(state({ modelId: 'a/b/deepseek-v4-pro', thinkingLevel: 'medium' }))).toBe('deepseek-v4-pro · medium');
  });
});

// ─── null / missing handling (regression: Number(null) === 0 trap) ──────────

describe('formatTokens — missing-value handling', () => {
  it('returns — for null', () => {
    expect(formatTokens(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatTokens(undefined)).toBe('—');
  });
  it('returns — for empty string', () => {
    expect(formatTokens('')).toBe('—');
  });
  it('returns — for non-finite numbers', () => {
    expect(formatTokens(NaN)).toBe('—');
    expect(formatTokens(Infinity)).toBe('—');
  });
  it('returns — for unparseable strings', () => {
    expect(formatTokens('N/A')).toBe('—');
  });
  it('formats numbers in k / M ranges', () => {
    expect(formatTokens(0)).toBe('0 tok');
    expect(formatTokens(950)).toBe('950 tok');
    expect(formatTokens(1234)).toBe('1.2k tok');
    expect(formatTokens(1_500_000)).toBe('1.5M tok');
  });
});

describe('formatCost — missing-value handling', () => {
  it('returns — for null', () => {
    expect(formatCost(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatCost(undefined)).toBe('—');
  });
  it('returns — for empty string', () => {
    expect(formatCost('')).toBe('—');
  });
  it('returns — for non-finite numbers', () => {
    expect(formatCost(NaN)).toBe('—');
  });
  it('formats finite costs as $X.YYYY', () => {
    expect(formatCost(0)).toBe('$0.0000');
    expect(formatCost(0.00123)).toBe('$0.0012');
    expect(formatCost(1.5)).toBe('$1.5000');
  });
});

describe('formatMessages — missing-value handling', () => {
  it('returns — for null', () => {
    expect(formatMessages(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatMessages(undefined)).toBe('—');
  });
  it('returns — for empty string', () => {
    expect(formatMessages('')).toBe('—');
  });
  it('returns — for non-finite numbers', () => {
    expect(formatMessages(NaN)).toBe('—');
  });
  it('rounds finite counts to integers', () => {
    expect(formatMessages(0)).toBe('0');
    expect(formatMessages(85)).toBe('85');
    expect(formatMessages(85.6)).toBe('86');
  });
});

// ─── formatPercent ────────────────────────────────────────────────────────

describe('formatPercent', () => {
  it('returns — for missing values', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent('')).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
  });
  it('returns — for out-of-range values', () => {
    expect(formatPercent(-1)).toBe('—');
    expect(formatPercent(101)).toBe('—');
  });
  it('rounds to integers', () => {
    expect(formatPercent(0)).toBe('0');
    expect(formatPercent(6)).toBe('6');
    expect(formatPercent(6.4)).toBe('6');
    expect(formatPercent(6.6)).toBe('7');
    expect(formatPercent(100)).toBe('100');
  });
});

// ─── formatContextFraction / formatContextText / formatContextTooltipBody ────

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({
  totalTokens: null,
  totalCost: null,
  totalMessages: null,
  ...over,
});

describe('formatContextFraction', () => {
  it('returns null when contextUsage is absent', () => {
    expect(formatContextFraction(undefined)).toBeNull();
  });
  it('returns null when numerator is missing', () => {
    expect(formatContextFraction({ tokens: null, contextWindow: 200000, percent: 30 })).toBeNull();
  });
  it('returns null when denominator is missing', () => {
    expect(formatContextFraction({ tokens: 60000, contextWindow: null, percent: 30 })).toBeNull();
  });
  it('formats a known fraction', () => {
    expect(formatContextFraction({ tokens: 12400, contextWindow: 200000, percent: 6 }))
      .toBe('12.4k / 200k tok');
  });
});

describe('formatContextText — status bar 1-line text', () => {
  it('shows the fraction + percent + messages when contextUsage is known', () => {
    expect(formatContextText(stats({
      totalMessages: 85,
      contextUsage: { tokens: 12400, contextWindow: 200000, percent: 6 },
    }))).toBe('12.4k / 200k tok · 6% · 85 msg');
  });

  it('shows the denominator with em-dash numerator during the post-compaction transient', () => {
    // tokens === null but contextWindow is known — render "— / 200k · — · 85 msg"
    // so the user still sees the model window size.
    expect(formatContextText(stats({
      totalMessages: 85,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    }))).toBe('— / 200k tok · — · 85 msg');
  });

  it('falls back to session totals when contextUsage is absent', () => {
    expect(formatContextText(stats({ totalTokens: 105000, totalMessages: 22 })))
      .toBe('105k tok · 22 msg');
  });

  it('renders dashes when nothing is reported yet', () => {
    expect(formatContextText(stats({}))).toBe('— · — msg');
  });

  it('does NOT include a cost slot (cost is intentionally dropped)', () => {
    const text = formatContextText(stats({
      totalMessages: 1,
      contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
    }));
    expect(text).not.toContain('$');
    expect(text).not.toMatch(/cost/i);
  });
});

describe('formatContextTooltipBody', () => {
  it('shows two lines (context + messages) when contextUsage is known', () => {
    const body = formatContextTooltipBody(stats({
      totalMessages: 85,
      contextUsage: { tokens: 12400, contextWindow: 200000, percent: 6 },
    }));
    expect(body).toBe('Context: 12.4k / 200k tok (6 %)\nMessages: 85');
  });

  it('mentions the post-compaction transient with the known window', () => {
    const body = formatContextTooltipBody(stats({
      totalMessages: 85,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    }));
    expect(body).toBe('Context: compacting — awaiting next response · 200k tok window\nMessages: 85');
  });

  it('falls back to a single messages line when contextUsage is absent', () => {
    expect(formatContextTooltipBody(stats({ totalMessages: 85 }))).toBe('Messages: 85');
  });

  it('does NOT mention the model (it lives on the adjacent Model status bar item)', () => {
    const body = formatContextTooltipBody(stats({
      totalMessages: 1,
      contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
    }));
    expect(body).not.toMatch(/model/i);
    expect(body).not.toMatch(/thinking/i);
  });
});
