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
import { QuestionCard } from './QuestionCard';
import { SessionSummaryCard } from './SessionSummaryCard';
import { splitUserMessage } from '../lib/skill-blocks';
import { CollapsibleText } from './CollapsibleText';

// ─── Default row height estimates ────────────────────────────────────────────
// react-window needs a size estimate up-front; we remeasure after render via a
// ResizeObserver and call resetAfterIndex when an item grows.

const DEFAULT_ROW_HEIGHT = 80;

/**
 * A stable identity for one transcript row.
 *
 * react-window keys its rows by this, and the list uses the first row's key
 * to tell one transcript from another (see the row-height cache in
 * `MessageList`).
 */
/** The key of the last row, or an empty string for an empty transcript. */
function lastKeyOf(items: ChatItem[]): string {
  return items.length > 0 ? keyOf(items[items.length - 1]) : '';
}

function keyOf(item: ChatItem): string {
  if (item.itemKind === 'tool') return `tool-${item.toolCallId}`;
  if (item.itemKind === 'question') return `question-${item.id}`;
  return item.id;
}

interface Props {
  items: ChatItem[];
  /**
   * Counts transcript replacements — a session switch or a reset.
   *
   * The row heights are cached by index, so the list has to know when the
   * rows it measured are not the rows on screen any more. The item ids cannot
   * say that reliably (two sessions may open with the same message), so the
   * store says it.
   */
  transcriptEpoch: number;
  height: number;
  width: number;
}

export function MessageList({ items, transcriptEpoch, height, width }: Props) {
  const listRef = useRef<VariableSizeList>(null);
  const rowHeights = useRef<Record<number, number>>({});
  const isAtBottom = useRef(true);
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;

  const getItemSize = useCallback((index: number) => {
    return rowHeights.current[index] ?? DEFAULT_ROW_HEIGHT;
  }, []);

  const setRowHeight = useCallback((index: number, size: number) => {
    // A zero measurement is not a size: it is what a row reports while the
    // panel is hidden and nothing is laid out. Storing it would collapse the
    // row in react-window and poison the offsets of every row below it, so a
    // non-layout measurement is ignored entirely — the ResizeObserver reports
    // the real height as soon as the row is laid out again.
    if (size <= 0) return;
    if (rowHeights.current[index] === size) return;
    rowHeights.current[index] = size;
    // forceUpdate=true so rows below reflow immediately when a row's height
    // changes (e.g. expanding a tool card while idle). With false, react-window
    // clears cached offsets but doesn't re-render, so the list only repositions
    // on the next scroll. The height-changed guard above keeps this from firing
    // on steady-state streaming ticks where the measured height is unchanged.
    listRef.current?.resetAfterIndex(index, true);
    // The first measurement of a new row (e.g. a question card) replaces the
    // DEFAULT_ROW_HEIGHT guess used by the scroll-to-bottom effect below with
    // its real, often much larger, height. That effect already scrolled using
    // the wrong guess, so without this the view is left stuck wherever that
    // guess put it — typically showing just the card's title with the rest of
    // it below the fold. Re-scroll now that the true size is known.
    //
    // The target is the *last* item, not the measured one: a row growing
    // above the bottom — an expanded tool card, a collapsed message — pushes
    // the last messages below the fold, and the view has to follow them.
    //
    // The target itself is computed from the cached row heights, so it is
    // exact only once the rows around it have been measured. Each measurement
    // re-scrolls, and the position converges as they arrive.
    if (isAtBottom.current && itemCountRef.current > 0) {
      listRef.current?.scrollToItem(itemCountRef.current - 1, 'end');
    }
  }, []);

  // A new transcript: the rows the heights were measured for are gone, and the
  // reader starts at the bottom of the new one even if they had scrolled up
  // in the old one.
  useLayoutEffect(() => {
    rowHeights.current = {};
    isAtBottom.current = true;
    // Drop react-window's own size cache too: it is keyed by index as well.
    listRef.current?.resetAfterIndex(0, true);
    // Bring the last row into the window. Every height is an estimate at
    // this point, so the landing is approximate; the measurements that follow
    // correct it.
    if (items.length > 0) listRef.current?.scrollToItem(items.length - 1, 'end');
  }, [transcriptEpoch]);

  // The row heights are cached by index, so they describe the rows that were
  // there when they were measured. Appending keeps them valid; anything else —
  // a row removed from the middle, a row replaced in place — shifts the rows
  // after it, and their heights then belong to the wrong rows.
  const previous = useRef({ length: items.length, lastKey: lastKeyOf(items) });
  useLayoutEffect(() => {
    const before = previous.current;
    const grewByOne = items.length === before.length + 1;
    // A pure append: the row that was last is now the second to last.
    const appended =
      grewByOne && items.length >= 2 && keyOf(items[items.length - 2]) === before.lastKey;
    // The last row was updated in place — the same row, new content.
    const updatedInPlace = !grewByOne && before.lastKey === lastKeyOf(items);
    if (!appended && !updatedInPlace) {
      rowHeights.current = {};
      listRef.current?.resetAfterIndex(0, true);
    }
    previous.current = { length: items.length, lastKey: lastKeyOf(items) };
  }, [items]);

  // Scroll to the bottom when the bottom of the list moves: a new item
  // arrives, or the viewport changes (the composer grows). The dependencies
  // are deliberate — a re-render that changes neither, the user typing into a
  // question card's field being the case that motivated this, must leave the
  // view where it is. Scrolling on every render re-applies a target computed
  // from react-window's cached row sizes, which snaps the transcript to a
  // stale position on every keystroke.
  //
  // The target is computed from the cached row heights, so it is exact only
  // once the rows have been measured; each measurement scrolls again, and the
  // position converges as they arrive.
  //
  // The first render is the exception: the reader has not scrolled anywhere
  // yet, so the list opens at the bottom even when the estimates of the
  // unmeasured rows make it look as though they had.
  const firstRender = useRef(true);
  useLayoutEffect(() => {
    const initial = firstRender.current;
    firstRender.current = false;
    if (items.length === 0) return;
    if (!initial && !isAtBottom.current) return;
    listRef.current?.scrollToItem(items.length - 1, 'end');
  }, [items.length, height]);

  const itemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return index;
      return keyOf(item);
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

    case 'question':
      return <QuestionCard item={item} />;

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

    case 'summary':
      return <SessionSummaryCard item={item} />;

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
            <CollapsibleText key={i} text={seg.text} />
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
