/**
 * MessageList — virtualized list of all chat items.
 * Uses react-window's VariableSizeList so long sessions don't paint
 * thousands of DOM nodes at once.
 *
 * Scroll-to-bottom on new items (only when already near the bottom).
 */
import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { VariableSizeList, type ListChildComponentProps } from 'react-window';
import type { ChatItem, UserItem } from '../store';
import { AssistantBlock } from './AssistantBlock';
import { ToolCard } from './ToolCard';
import { splitUserMessage } from '../lib/skill-blocks';

// ─── Default row height estimates ────────────────────────────────────────────
// react-window needs a size estimate up-front; we remeasure after render via a
// ResizeObserver and call resetAfterIndex when an item grows.

const DEFAULT_ROW_HEIGHT = 80;

interface Props {
  items: ChatItem[];
  height: number;
  width: number;
}

export function MessageList({ items, height, width }: Props) {
  const listRef = useRef<VariableSizeList>(null);
  const rowHeights = useRef<Record<number, number>>({});
  const isAtBottom = useRef(true);

  const getItemSize = useCallback((index: number) => {
    return rowHeights.current[index] ?? DEFAULT_ROW_HEIGHT;
  }, []);

  const setRowHeight = useCallback((index: number, size: number) => {
    if (rowHeights.current[index] === size) return;
    rowHeights.current[index] = size;
    // forceUpdate=true so rows below reflow immediately when a row's height
    // changes (e.g. expanding a tool card while idle). With false, react-window
    // clears cached offsets but doesn't re-render, so the list only repositions
    // on the next scroll. The height-changed guard above keeps this from firing
    // on steady-state streaming ticks where the measured height is unchanged.
    listRef.current?.resetAfterIndex(index, true);
  }, []);

  // Scroll to bottom when new items arrive (only when already pinned to bottom).
  useEffect(() => {
    if (isAtBottom.current && items.length > 0) {
      listRef.current?.scrollToItem(items.length - 1, 'end');
    }
  }, [items.length]);

  // Also scroll to bottom when the last item's content grows (streaming).
  useLayoutEffect(() => {
    if (isAtBottom.current && items.length > 0) {
      listRef.current?.scrollToItem(items.length - 1, 'end');
    }
  });

  const itemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return index;
      if (item.itemKind === 'tool') return `tool-${item.toolCallId}`;
      if (item.itemKind === 'assistant' || item.itemKind === 'user') return item.id;
      return item.id;
    },
    [items],
  );

  if (items.length === 0) {
    return (
      <div className="message-list message-list--empty" aria-label="Chat messages">
        <p className="message-list__empty-text">
          Send a prompt to start a conversation.
        </p>
      </div>
    );
  }

  return (
    <VariableSizeList
      ref={listRef}
      className="message-list"
      aria-label="Chat messages"
      height={height}
      width={width}
      itemCount={items.length}
      itemSize={getItemSize}
      itemKey={itemKey}
      overscanCount={4}
      onScroll={({ scrollOffset, scrollUpdateWasRequested }) => {
        if (scrollUpdateWasRequested) return;
        // Estimate total content height to detect "near bottom".
        const totalHeight = items.reduce(
          (sum, _, i) => sum + (rowHeights.current[i] ?? DEFAULT_ROW_HEIGHT),
          0,
        );
        isAtBottom.current = totalHeight - scrollOffset - height < 60;
      }}
    >
      {(props) => (
        <Row
          {...props}
          items={items}
          setRowHeight={setRowHeight}
        />
      )}
    </VariableSizeList>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface RowProps extends ListChildComponentProps {
  items: ChatItem[];
  setRowHeight: (index: number, size: number) => void;
}

const Row = React.memo(function Row({ index, style, items, setRowHeight }: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const item = items[index];

  useEffect(() => {
    if (!rowRef.current) return;
    const el = rowRef.current;

    const update = () => {
      setRowHeight(index, el.getBoundingClientRect().height);
    };

    const ro = new ResizeObserver(update);
    ro.observe(el);
    update(); // measure immediately
    return () => ro.disconnect();
  }, [index, setRowHeight]);

  return (
    <div style={style}>
      <div ref={rowRef} className="message-row">
        <ItemRenderer item={item} />
      </div>
    </div>
  );
});

function ItemRenderer({ item }: { item: ChatItem }) {
  switch (item.itemKind) {
    case 'user':
      return <UserMessage item={item} />;

    case 'assistant':
      return <AssistantBlock item={item} />;

    case 'tool':
      return <ToolCard item={item} />;

    case 'system':
      return (
        <div
          className={`system-message system-message--${item.level}`}
          role="status"
          aria-live="polite"
        >
          {item.text}
        </div>
      );

    default:
      return null;
  }
}

// ─── User message ──────────────────────────────────────────────────────────────
// pi expands slash-command skills inline into the user turn as
// `<skill name="…">…</skill>` blocks. Render plain text as the normal bubble and
// each skill block as a collapsed-by-default disclosure so the chat isn't
// flooded with the whole SKILL.md. Collapse state is local: it defaults to
// collapsed, which is also where react-window leaves it after a row remounts.

function UserMessage({ item }: { item: UserItem }) {
  const segments = useMemo(() => splitUserMessage(item.text), [item.text]);
  // An image-only prompt has empty text; skip the bubble and show only the badge.
  const hasText = item.text.trim().length > 0;
  const imageCount = item.imageCount ?? 0;

  return (
    <div className="user-message" aria-label="Your message">
      {hasText &&
        segments.map((seg, i) =>
          seg.kind === 'text' ? (
            <pre key={i} className="user-message__text">{seg.text}</pre>
          ) : (
            <SkillBlock key={i} name={seg.name} body={seg.body} />
          ),
        )}
      {imageCount > 0 && (
        <div
          className="user-message__attachments"
          aria-label={`${imageCount} image${imageCount > 1 ? 's' : ''} attached`}
        >
          <span aria-hidden="true">🖼</span> {imageCount} image{imageCount > 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

function SkillBlock({ name, body }: { name: string; body: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="skill-block">
      <button
        className="skill-block__toggle"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`skill-block__chevron${expanded ? ' skill-block__chevron--open' : ''}`}>
          ▶
        </span>
        <span className="skill-block__icon" aria-hidden="true">🧩</span>
        <span className="skill-block__label">{name}</span>
        <span className="skill-block__tag">skill</span>
      </button>

      {expanded && <pre className="skill-block__body">{body}</pre>}
    </div>
  );
}
