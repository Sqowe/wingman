/**
 * Shared session-stats formatting helpers.
 *
 * Used by both the status bar and the showStats command so formatting
 * logic is never duplicated and numeric coercion is applied in one place.
 *
 * All functions accept `unknown` so callers can pass raw RPC values directly
 * without having to validate types themselves. `null` / `undefined` / `''` are
 * all treated as missing and render as the em-dash placeholder ("—") — they
 * do NOT become "0" via the `Number(null) === 0` JS coercion trap.
 */

import type { ModelState, SessionStats } from './messages';

/** True for values that should render as the em-dash placeholder. */
function isMissing(raw: unknown): raw is null | undefined | '' {
  return raw === null || raw === undefined || raw === '';
}

/** Format a scaled value with an optional trailing `.0` stripped (compact form). */
function formatScaledCore(scaled: number, suffix: 'k' | 'M'): string {
  const fixed = scaled.toFixed(1);
  const trimmed = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  return `${trimmed}${suffix}`;
}

/**
 * Format a token count without the trailing " tok" unit. Returns "—" for
 * missing / non-finite values. Used where the unit is only wanted once
 * (e.g. the numerator of a "12.4k / 200k tok" fraction).
 *
 * Exported so the chat footer line can reuse the same k/M scaling without
 * duplicating the threshold logic.
 */
export function formatTokensCore(raw: unknown): string {
  if (isMissing(raw)) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return formatScaledCore(n / 1_000_000, 'M');
  if (n >= 1_000) return formatScaledCore(n / 1_000, 'k');
  return `${Math.round(n)}`;
}

/** Cache hit rate as a display suffix (" 97%"): the share of prompt
 *  tokens served from the provider's cache, cacheRead /
 *  (cacheRead + input). Rendered whenever the turn read from cache at
 *  all (cacheRead > 0); input = 0 with cache read present is a perfect
 *  100%. Input (fresh prompt tokens) is the denominator's other half —
 *  output/cacheWrite do not participate. */
export function formatCacheHitRate(cacheRead: number, input: number | null | undefined): string {
  if (!(cacheRead > 0) || !Number.isFinite(cacheRead)) return '';
  const fresh = typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0;
  const rate = cacheRead / (cacheRead + fresh);
  return ` ${Math.round(rate * 100)}%`;
}

/**
 * Format a token count. Returns "—" for missing / non-finite values.
 * @example formatTokens(1234)   → "1.2k tok"
 * @example formatTokens(200000) → "200k tok"   (no trailing `.0`)
 * @example formatTokens("bad")  → "—"
 * @example formatTokens(null)   → "—"  (was "0 tok" before the fix)
 */
export function formatTokens(raw: unknown): string {
  const core = formatTokensCore(raw);
  return core === '—' ? core : `${core} tok`;
}

/**
 * Format a cost in USD. Returns "—" for missing / non-finite values.
 * @example formatCost(0.00123)  → "$0.0012"
 * @example formatCost(null)     → "—"  (was "$0.0000" before the fix)
 */
export function formatCost(raw: unknown): string {
  if (isMissing(raw)) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(4)}`;
}

/**
 * Format a message count. Returns "—" for missing / non-finite values.
 */
export function formatMessages(raw: unknown): string {
  if (isMissing(raw)) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n));
}

/**
 * Format an integer percentage 0–100. Returns "—" for missing / out-of-range values.
 * Always rounded (no decimals) so the bar text stays compact.
 * @example formatPercent(6)      → "6"
 * @example formatPercent(6.4)    → "6"
 * @example formatPercent(null)   → "—"
 */
export function formatPercent(raw: unknown): string {
  if (isMissing(raw)) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  if (n < 0 || n > 100) return '—';
  return String(Math.round(n));
}

/**
 * Format the context-usage fraction as `"12.4k / 200k tok"` (unit shown once, on the
 * denominator). Returns `null` when either the numerator or denominator is missing /
 * non-finite — callers are expected to fall back to a placeholder ("—") or to the
 * session-totals reading (see formatContextText).
 */
export function formatContextFraction(usage: SessionStats['contextUsage']): string | null {
  if (!usage) return null;
  const tokens = usage.tokens;
  const window = usage.contextWindow;
  if (isMissing(tokens) || isMissing(window)) return null;
  const t = Number(tokens);
  const w = Number(window);
  if (!Number.isFinite(t) || !Number.isFinite(w)) return null;
  return `${formatTokensCore(t)} / ${formatTokens(w)}`;
}

/**
 * The 1-line status-bar text for the session-stats item. Always three slots
 * (context / cost-fallback / messages), separated by " · ".
 *
 *  - When `contextUsage` is known and not in the post-compaction transient
 *    (both `tokens` and `percent` are numbers): `"9k / 1M tok · 1% · 42 msg"`.
 *  - When `contextUsage.tokens` / `percent` are `null` (post-compaction transient)
 *    but the denominator is known: `"— / 200k tok · — · 85 msg"` so the user still
 *    sees the model window size while waiting for the next assistant response.
 *  - When `contextUsage` is absent entirely (no model set, old pi, etc.):
 *    falls back to the session-totals reading — `"105k tok · 85 msg"` (cost
 *    intentionally dropped — not useful in this surface).
 *  - When nothing has been reported yet: `"Wingman"` (the idle label, set by
 *    `WingmanStatusBar.reset()` — this function is not called in that path).
 */
export function formatContextText(stats: SessionStats): string {
  const messages = formatMessages(stats.totalMessages);

  if (stats.contextUsage) {
    const { tokens, contextWindow, percent } = stats.contextUsage;
    const numerator = formatTokensCore(tokens);
    const denominator = formatTokens(contextWindow);
    const pct = formatPercent(percent);
    const pctText = pct === '—' ? pct : `${pct}%`;
    // Post-compaction transient: numerator may be '—' but the denominator is still known.
    // Show the window size if we have it, so the user understands what "near full" means.
    if (tokens === null && contextWindow != null) {
      return `— / ${denominator} · ${pctText} · ${messages} msg`;
    }
    return `${numerator} / ${denominator} · ${pctText} · ${messages} msg`;
  }

  // No contextUsage yet — fall back to session totals.
  const total = formatTokens(stats.totalTokens);
  return `${total} · ${messages} msg`;
}

/**
 * Tooltip body for the session-stats status-bar item. Always context-only
 * (model / thinking live on the adjacent Model status bar item — intentionally
 * not duplicated here per the design note §5.3.2). The returned string is the
 * Markdown body intended to be wrapped in `new vscode.MarkdownString(...)` by
 * the caller; kept as a plain string here so the helper has no `vscode` import.
 *
 * Shapes:
 *  - With contextUsage: two rows
 *      "Context: 12.4k / 200k tok (6 %)\nMessages: 85"
 *  - Post-compaction transient: first row mentions "compacting"
 *      "Context: compacting — awaiting next response · 200k window\nMessages: 85"
 *  - Without contextUsage: just the message count (the bar text already shows
 *    the `—` placeholder, so duplicating it would be noise)
 *      "Messages: 85"
 */
export function formatContextTooltipBody(stats: SessionStats): string {
  const messages = formatMessages(stats.totalMessages);
  const msgsLine = `Messages: ${messages}`;

  if (!stats.contextUsage) {
    return msgsLine;
  }

  const { tokens, contextWindow, percent } = stats.contextUsage;

  // Post-compaction transient: tokens & percent are null, but contextWindow may
  // still be known. Show a hint that explains the dash in the bar.
  if (tokens === null && percent === null && contextWindow != null) {
    return `Context: compacting — awaiting next response · ${formatTokens(contextWindow)} window\n${msgsLine}`;
  }

  const fraction = formatContextFraction(stats.contextUsage);
  const pct = formatPercent(percent);
  // fraction may be null if one of the values is missing — fall back to a
  // partial fraction or just the percentage.
  const contextLine =
    fraction !== null
      ? `Context: ${fraction} (${pct} %)`
      : `Context: ${pct === '—' ? '—' : `${pct} %`}`;
  return `${contextLine}\n${msgsLine}`;
}

/**
 * A compact model label for the status bar: prefer the human name, else the
 * last path segment of the id (`tencent/hy3-preview` → `hy3-preview`).
 * Returns "—" when nothing usable is known.
 */
export function formatModelLabel(state: ModelState | null): string {
  if (!state) return '—';
  if (state.modelName) return state.modelName;
  if (state.modelId) {
    const seg = state.modelId.split('/').pop();
    if (seg) return seg;
  }
  return '—';
}

/**
 * The status bar text for the model item: `<model> · <thinking>`. The thinking
 * suffix is dropped when the level is absent or "none"/"off".
 * @example "hy3-preview · high"
 */
export function formatModelStatus(state: ModelState | null): string {
  const label = formatModelLabel(state);
  const level = state?.thinkingLevel;
  const showLevel = level && level !== 'none' && level !== 'off';
  return showLevel ? `${label} · ${level}` : label;
}

// ─── Chat footer line (Kiro-style end-of-turn summary) ──────────────────────

/**
 * Format a duration in milliseconds as a compact human string.
 *   < 60 s   → "47s"
 *   < 60 min → "11m 30s"  (or "11m" when seconds round to 0)
 *   else     → "1h 02m"   (or "2h" when minutes round to 0)
 * Never reaches the "days" scale — coding sessions beyond a few hours are
 * outliers and "1d 03h" is harder to scan at a glance than "27h".
 * @example formatElapsed(0)        → "0s"
 * @example formatElapsed(47_000)   → "47s"
 * @example formatElapsed(690_000)  → "11m 30s"
 * @example formatElapsed(3_720_000)→ "1h 02m"
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hr}h ${min.toString().padStart(2, '0')}m` : `${hr}h`;
}

/**
 * One-line end-of-turn footer for the chat transcript. Renders a
 * Kiro-style summary that surfaces elapsed time, the four token buckets
 * (input / output / cache read / cache write), and total cost. Any section
 * whose source data is absent or zero is silently dropped so a still-loading
 * or all-free session doesn't show stray separators.
 *
 * Elapsed time comes from `elapsedMs` when stamped (the host freezes it at
 * `agent_settled`); `startedAt` is a fallback only — computing live here
 * would make the line stale and tests flake. Token buckets and cost hide
 * zero values for consistency: a real zero (e.g. zero cache write) looks
 * the same as "not measured" to the user, so showing it would add noise.
 *
 * Returns `null` when there is nothing meaningful to render (no elapsed,
 * no token buckets, no cost) so the caller can choose not to render the
 * row at all.
 *
 * @example
 *   formatChatFooterLine({
 *     elapsedMs: 690_000,
 *     tokens: { input: 100000, output: 25000, cacheRead: 80000, cacheWrite: 5000 },
 *     totalCost: 0.45,
 *   })
 *   // → "⏱ 11m 30s · ↑100k ↓25k ↻80k 44% ↪5k · ≈$0.45"
 */
export function formatChatFooterLine(stats: SessionStats): string | null {
  const parts: string[] = [];

  // `elapsedMs` is the frozen turn duration (host-stamped at agent_settled).
  // `startedAt` is a deterministic-but-derived fallback used by tests and
  // by the rare no-event snapshot; production paths always pass elapsedMs.
  if (typeof stats.elapsedMs === 'number' && stats.elapsedMs >= 0) {
    parts.push(`⏱ ${formatElapsed(stats.elapsedMs)}`);
  } else if (typeof stats.startedAt === 'number') {
    parts.push(`⏱ ${formatElapsed(Date.now() - stats.startedAt)}`);
  }

  if (stats.tokens) {
    const t = stats.tokens;
    const segs: string[] = [];
    // Hide 0 alongside null: from the user's perspective both mean "no
    // measurements to surface"; showing ↻0k in the middle of the line adds
    // noise without information.
    if (t.input && Number.isFinite(t.input))                 segs.push(`↑${formatTokensCore(t.input)}`);
    if (t.output && Number.isFinite(t.output))               segs.push(`↓${formatTokensCore(t.output)}`);
    if (t.cacheRead && Number.isFinite(t.cacheRead)) {
      segs.push(`↻${formatTokensCore(t.cacheRead)}${formatCacheHitRate(t.cacheRead, t.input)}`);
    }
    if (t.cacheWrite && Number.isFinite(t.cacheWrite))       segs.push(`↪${formatTokensCore(t.cacheWrite)}`);
    if (segs.length) parts.push(segs.join(' '));
  }

  // Cost mirrors the bucket-zero policy for consistency: sub-cent values
  // round to "$0.00" in the display, which would look like a rounding bug
  // ("≈ $0.00" beside non-zero usage). Hide anything that rounds to
  // zero cents so the formatter never prints "$0.00". A positive cent
  // is the rendering threshold.
  if (typeof stats.totalCost === 'number' && Number.isFinite(stats.totalCost) && stats.totalCost >= 0.01) {
    parts.push(`≈ $${stats.totalCost.toFixed(2)}`);
  }

  return parts.length ? parts.join(' · ') : null;
}
