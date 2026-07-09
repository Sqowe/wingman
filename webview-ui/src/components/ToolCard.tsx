/**
 * ToolCard — renders one tool execution item (start → live output → end).
 *
 * - Collapsed by default when complete; expanded while running.
 * - Copy button copies the clean output source string.
 * - For completed `edit` tool cards with a patch: "View Diff" opens VS Code's
 *   diff editor (read-only before↔after preview). pi has already written the
 *   change to disk, so there is no Apply button.
 */
import React from 'react';
import type { ToolRunItem } from '../store';
import { useChatStore } from '../store';
import { CopyButton } from './CopyButton';
import { vscode } from '../vscodeApi';

interface Props {
  item: ToolRunItem;
}

/** Human-readable label for well-known tool names. */
const TOOL_LABELS: Record<string, string> = {
  bash: '$ bash',
  read: '📄 read',
  write: '✏️ write',
  edit: '✏️ edit',
  search: '🔍 search',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `⚙ ${name}`;
}

/** Summarise the args for the card header (single-line, trimmed). */
function argsSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const cmd = String(args.command ?? '');
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const p = String(args.path ?? args.file_path ?? args.filePath ?? '');
    return p.length > 80 ? '…' + p.slice(-79) : p;
  }
  // Generic: first string value
  const first = Object.values(args).find((v) => typeof v === 'string');
  if (typeof first === 'string') {
    return first.length > 80 ? first.slice(0, 80) + '…' : first;
  }
  return '';
}

/** Extract a patch string from `details` if one is present. */
function extractPatch(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const p = details['patch'];
  return typeof p === 'string' && p.trim().length > 0 ? p : null;
}

export function ToolCard({ item }: Props) {
  const setDiffError = useChatStore((s) => s.setDiffError);
  const showViewDiffButton = useChatStore((s) => s.showViewDiffButton);
  // `undefined` = follow the default (expanded while running, collapsed once
  // done); a boolean = the user's explicit toggle, which then sticks. Deriving
  // the displayed state this way auto-collapses a card the instant it completes
  // — keeping the transcript tidy — with no post-completion effect or flash.
  //
  // The override lives in the store (keyed by toolCallId), not local state, so
  // it survives the unmount/remount react-window does as cards scroll out of
  // the viewport during streaming. With local state, auto-scroll would wipe a
  // manual toggle on the next remount.
  const userToggled = useChatStore((s) => s.toolCardExpanded[item.toolCallId]);
  const setToolCardExpanded = useChatStore((s) => s.setToolCardExpanded);
  const displayExpanded = userToggled ?? !item.isComplete;

  const output = item.isComplete ? (item.finalOutput ?? '') : item.partialOutput;
  const summary = argsSummary(item.toolName, item.args);
  const label = toolLabel(item.toolName);
  const patch = item.isComplete && item.toolName === 'edit' ? extractPatch(item.details) : null;

  const statusClass = item.isComplete
    ? item.isError
      ? 'tool-card--error'
      : 'tool-card--done'
    : 'tool-card--running';

  // Only completed cards are collapsible; while running the output stays open.
  const toggleExpanded = () => {
    if (item.isComplete) setToolCardExpanded(item.toolCallId, !displayExpanded);
  };

  const handleViewDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!patch) return;
    // Clear any previous diff error before retrying.
    if (item.diffError) setDiffError(item.toolCallId, '');
    vscode.postMessage({ type: 'openDiff', patch, toolCallId: item.toolCallId });
  };

  return (
    <div
      className={`tool-card ${statusClass}`}
      aria-label={`Tool: ${item.toolName}`}
    >
      {/* ── Header ── */}
      <div
        className="tool-card__header"
        onClick={toggleExpanded}
        role={item.isComplete ? 'button' : undefined}
        tabIndex={item.isComplete ? 0 : undefined}
        onKeyDown={
          item.isComplete
            ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(); } }
            : undefined
        }
        aria-expanded={displayExpanded}
      >
        <span className="tool-card__status-dot" aria-hidden="true" />

        <span className="tool-card__label">{label}</span>

        {summary && (
          <span className="tool-card__summary" title={summary}>
            {summary}
          </span>
        )}

        <span className="tool-card__spacer" />

        {item.isComplete && output.length > 0 && (
          <CopyButton
            text={output}
            label={`Copy ${item.toolName} output`}
            className="tool-card__copy"
          />
        )}

        {item.isComplete && (
          <span
            className={`tool-card__chevron${displayExpanded ? ' tool-card__chevron--open' : ''}`}
            aria-hidden="true"
          >
            ▶
          </span>
        )}
      </div>

      {/* ── Body: output ── */}
      {displayExpanded && output.length > 0 && (
        <pre className="tool-card__output" aria-live="polite">
          {output}
        </pre>
      )}

      {/* ── Diff action (edit tool only) ── */}
      {patch !== null && showViewDiffButton && (
        <div className="tool-card__diff-actions">
          <button
            type="button"
            className="tool-card__diff-btn"
            onClick={handleViewDiff}
            title="Open VS Code diff editor (read-only preview)"
          >
            View Diff
          </button>
        </div>
      )}

      {/* ── Diff error (inline feedback when View Diff failed) ──
          Truthy guard (not `!== null`) so a cleared error ('') hides the
          banner instead of leaving a lone ⚠️ icon. */}
      {item.diffError && (
        <div className="tool-card__diff-error" role="alert">
          <span className="tool-card__diff-error-icon" aria-hidden="true">⚠️</span>
          {item.diffError}
        </div>
      )}

      {/* ── Error badge ── */}
      {item.isComplete && item.isError && (
        <div className="tool-card__error-badge" role="alert">
          Tool returned an error
        </div>
      )}
    </div>
  );
}
