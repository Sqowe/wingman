/**
 * SessionSummaryCard — one-line end-of-turn footer for the chat transcript.
 *
 * Mirrors the Kiro "Est. Credits Used / Elapsed time" footer: a compact,
 * non-interactive summary built from the latest `SessionStats` snapshot.
 * Pushed to the store by the host on `agent_settled` (not `agent_end`)
 * so multi-iteration tool loops don't flash a fresh footer between
 * iterations.
 *
 * The line is formatted by `formatChatFooterLine` (shared with status-
 * bar formatters) and quietly omitted when the snapshot has nothing
 * meaningful — earlier in a session, or before any model response has
 * produced usage data.
 */
import React from 'react';
import type { SummaryItem } from '../store';
import { formatChatFooterLine } from '@shared/stats-format';

export function SessionSummaryCard({ item }: { item: SummaryItem }) {
  const line = formatChatFooterLine(item.stats);
  if (!line) return null;
  return (
    <div
      className="session-summary-card"
      role="status"
      aria-live="polite"
      aria-label="Session summary"
    >
      {line}
    </div>
  );
}
