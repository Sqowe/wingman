/**
 * AssistantBlock — renders one assistant chat item.
 * Text blocks use react-markdown; thinking blocks are collapsible.
 * A copy button on each block copies the clean source string (not rendered HTML).
 *
 * Markdown rendering (including link interception and the raw-HTML block) lives
 * in ./Markdown, shared with the question card so both apply the same rules.
 *
 * Performance: each text block's markdown output is memoized by content
 * so it is not re-parsed on every render during streaming of other blocks.
 */
import { useMemo } from 'react';
import type { AssistantItem } from '../store';
import { useChatStore } from '../store';
import { CopyButton } from './CopyButton';
import { MemoMarkdown } from './Markdown';

interface Props {
  item: AssistantItem;
}

export function AssistantBlock({ item }: Props) {
  const toggleThinking = useChatStore((s) => s.toggleThinking);

  // Build a single plain-text string for the top-level copy button
  // (copies all text blocks concatenated, not thinking).
  const fullText = useMemo(
    () =>
      item.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n\n'),
    [item.blocks],
  );

  return (
    <div className="assistant-block" aria-label="Assistant message">
      {/* Per-message copy button (top-right) */}
      {fullText.length > 0 && (
        <div className="assistant-block__actions">
          <CopyButton text={fullText} label="Copy response" />
        </div>
      )}

      {item.blocks.map((block, i) => {
        if (block.kind === 'text') {
          return (
            <div key={i} className="assistant-block__text">
              <MemoMarkdown text={block.text} />
            </div>
          );
        }

        // Thinking block
        const expanded = !block.collapsed;
        return (
          <div key={i} className="thinking-block">
            <button
              className="thinking-block__toggle"
              type="button"
              onClick={() => toggleThinking(item.id, i)}
              aria-expanded={expanded}
              aria-controls={`thinking-${item.id}-${i}`}
            >
              <span className={`thinking-block__chevron${expanded ? ' thinking-block__chevron--open' : ''}`}>
                ▶
              </span>
              Thinking
              {!expanded && block.text.length > 0 && (
                <span className="thinking-block__preview">
                  {block.text.slice(0, 80).replace(/\n/g, ' ')}
                  {block.text.length > 80 ? '…' : ''}
                </span>
              )}
            </button>

            {expanded && (
              <div
                id={`thinking-${item.id}-${i}`}
                className="thinking-block__body"
              >
                <CopyButton text={block.text} label="Copy thinking" className="thinking-block__copy" />
                <pre className="thinking-block__text">{block.text}</pre>
              </div>
            )}
          </div>
        );
      })}

      {!item.isComplete && (
        <span className="assistant-block__cursor" aria-hidden="true" />
      )}
    </div>
  );
}
