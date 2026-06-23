/**
 * Shared session-stats formatting helpers.
 *
 * Used by both the status bar and the showStats command so formatting
 * logic is never duplicated and numeric coercion is applied in one place.
 *
 * All functions accept `unknown` so callers can pass raw RPC values directly
 * without having to validate types themselves.
 */

/**
 * Format a token count. Returns "—" for non-finite / missing values.
 * @example formatTokens(1234)   → "1.2k tok"
 * @example formatTokens("bad")  → "—"
 */
export function formatTokens(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${Math.round(n)} tok`;
}

/**
 * Format a cost in USD. Returns "—" for non-finite / missing values.
 * @example formatCost(0.00123)  → "$0.0012"
 * @example formatCost(null)     → "—"
 */
export function formatCost(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(4)}`;
}

/**
 * Format a message count. Returns "—" for non-finite / missing values.
 */
export function formatMessages(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n));
}
