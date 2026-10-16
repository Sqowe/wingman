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
  formatElapsed,
  formatChatFooterLine,
  formatCacheHitRate,
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

// ─── formatElapsed (chat footer card) ──────────────────────────────────────
describe('formatElapsed', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(47_000)).toBe('47s');
  });

  it('formats sub-hour durations as "Xm Ys" or "Xm"', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(690_000)).toBe('11m 30s');
    expect(formatElapsed(900_000)).toBe('15m');
  });

  it('formats multi-hour durations as "Xh YYm" or "Xh"', () => {
    expect(formatElapsed(3_600_000)).toBe('1h');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
    expect(formatElapsed(2 * 3_600_000)).toBe('2h');
  });

  it('clamps negative durations to 0s (a clock skew would otherwise render "-1s")', () => {
    expect(formatElapsed(-500)).toBe('0s');
  });
});

// ─── formatChatFooterLine (Kiro-style footer) ──────────────────────────────
describe('formatChatFooterLine', () => {
  it('returns null when the snapshot has nothing to render', () => {
    expect(formatChatFooterLine(stats())).toBeNull();
    expect(
      formatChatFooterLine(stats({
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      })),
    ).toBeNull();
  });

  it('prefers the frozen elapsedMs (host-stamped at agent_settled, deterministic)', () => {
    expect(formatChatFooterLine(stats({ elapsedMs: 690_000 }))).toBe('⏱ 11m 30s');
    expect(formatChatFooterLine(stats({ elapsedMs: 0 }))).toBe('⏱ 0s');
  });

  it('falls back to startedAt (rare: only when elapsedMs was not stamped)', () => {
    // startedAt-driven path computes live, so tolerate ±1s jitter on slow
    // CI rather than asserting an exact string.
    const out = formatChatFooterLine(stats({ startedAt: Date.now() - 690_000 }));
    expect(out).toMatch(/^⏱ 11m (29|30|31)s$/);
  });

  it('renders all four token buckets with arrow glyphs and k-scaling', () => {
    const out = formatChatFooterLine(stats({
      tokens: {
        input: 100_000,
        output: 25_000,
        cacheRead: 80_000,
        cacheWrite: 5_000,
      },
    }));
    expect(out).toBe('↑100k ↓25k ↻80k 44% ↪5k');
  });

  it('appends the cache hit-rate percentage to the ↻ segment', () => {
    // 315.3k read / (315.3k + 8.3k fresh) ≈ 97.4% → 97%.
    const out = formatChatFooterLine(stats({
      tokens: { input: 8_300, output: null, cacheRead: 315_300, cacheWrite: null },
    }));
    expect(out).toBe('↑8.3k ↻315.3k 97%');
  });

  it('hit rate is 100% when the whole prompt came from cache', () => {
    const out = formatChatFooterLine(stats({
      tokens: { input: 0, output: null, cacheRead: 12_000, cacheWrite: null },
    }));
    expect(out).toBe('↻12k 100%');
  });

  it('no percentage when nothing was read from cache', () => {
    const out = formatChatFooterLine(stats({
      tokens: { input: 5_000, output: null, cacheRead: 0, cacheWrite: null },
    }));
    expect(out).toBe('↑5k');
  });

  it('omits zero-valued buckets (no stray separators)', () => {
    const out = formatChatFooterLine(stats({
      tokens: {
        input: 100_000,
        output: 25_000,
        cacheRead: 0,
        cacheWrite: null,
      },
    }));
    // 0 cacheRead is dropped (treated as not-visible, not a real measurement),
    // null cacheWrite is dropped entirely.
    expect(out).toBe('↑100k ↓25k');
  });

  it('appends cost as ≈ $X.XX (two decimal places, Kiro-style)', () => {
    const out = formatChatFooterLine(stats({ elapsedMs: 1000, totalCost: 0.4567 }));
    expect(out).toBe('⏱ 1s · ≈ $0.46');
  });

  it('drops zero cost (consistent with zero bucket policy)', () => {
    const out = formatChatFooterLine(stats({ elapsedMs: 1000, totalCost: 0 }));
    expect(out).toBe('⏱ 1s');
  });

  it('joins elapsed + tokens + cost with the " · " separator', () => {
    const out = formatChatFooterLine(stats({
      elapsedMs: 690_000,
      tokens: {
        input: 100_000,
        output: 25_000,
        cacheRead: 80_000,
        cacheWrite: 5_000,
      },
      totalCost: 0.45,
    }));
    expect(out).toBe('⏱ 11m 30s · ↑100k ↓25k ↻80k 44% ↪5k · ≈ $0.45');
  });

  it('renders M-scaled buckets beyond 1M tokens', () => {
    const out = formatChatFooterLine(stats({
      tokens: {
        input: 1_500_000,
        output: 250_000,
        cacheRead: 800_000,
        cacheWrite: 12_000,
      },
    }));
    expect(out).toBe('↑1.5M ↓250k ↻800k 35% ↪12k');
  });

  it('formatCacheHitRate: rounding and edge cases', () => {
    expect(formatCacheHitRate(315_300, 8_300)).toBe(' 97%');
    expect(formatCacheHitRate(2, 1)).toBe(' 67%');          // 66.67 → 67
    expect(formatCacheHitRate(12_000, 0)).toBe(' 100%');
    expect(formatCacheHitRate(12_000, null)).toBe(' 100%');
    expect(formatCacheHitRate(0, 5_000)).toBe('');           // no cache activity → no suffix
    expect(formatCacheHitRate(-5, 100)).toBe('');            // nonsense input → no suffix
    expect(formatCacheHitRate(Number.NaN, 100)).toBe('');
  });

  it('drops cost when null/non-finite instead of printing "$NaN"', () => {
    expect(
      formatChatFooterLine(stats({
        elapsedMs: 1000,
        tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null },
      })),
    ).toBe('⏱ 1s · ↑100');
    expect(
      formatChatFooterLine(stats({
        elapsedMs: 1000,
        tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null },
        totalCost: Number.NaN,
      })),
    ).toBe('⏱ 1s · ↑100');
  });
});
