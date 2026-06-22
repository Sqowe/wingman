/**
 * MessageList — virtualized list of all chat items.
 * Uses react-window's VariableSizeList so long sessions don't paint
 * thousands of DOM nodes at once.
 *
 * Scroll-to-bottom on new items (only when already near the bottom).
 */
import React, { useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { VariableSizeList, type ListChildComponentProps } from 'react-window';
import type { ChatItem } from '../store';
import { AssistantBlock } from './AssistantBlock';
import { ToolCard } from './ToolCard';

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
    listRef.current?.resetAfterIndex(index, false);
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
      return (
        <div className="user-message" aria-label="Your message">
          <pre className="user-message__text">{item.text}</pre>
        </div>
      );

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
