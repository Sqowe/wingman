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
 * How far from the bottom, in pixels, still counts as "at the bottom".
 *
 * Not tight: a browser snaps `scrollTop` to its pixel grid, so the list never
 * lands on a fractional target exactly, and a reader who scrolls to the end of
 * a long answer is rarely within a pixel of it.
 */
const AT_BOTTOM_SLACK_PX = 60;

/**
 * A stable identity for one transcript row.
 *
 * react-window keys its rows by this, and the list compares the keys of two
 * renders to find the first row that changed (see the row-height cache in
 * `MessageList`).
 */
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
  /** The scrolling element itself, so the bottom can be read from the DOM. */
  const outerRef = useRef<HTMLDivElement | null>(null);
  const rowHeights = useRef<Record<number, number>>({});
  const isAtBottom = useRef(true);
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;
  const heightRef = useRef(height);
  heightRef.current = height;
  // Bumped whenever the height cache is dropped. Rows stay mounted across
  // re-renders (see `itemData`), and a ResizeObserver reports a size *change*,
  // never a size the list merely forgot — so a row that is still on screen,
  // unchanged, would never report again and be laid out at the estimate, with
  // the rows below drawn over it. Rows re-measure when this changes.
  const [measureEpoch, setMeasureEpoch] = useState(0);
  /**
   * True from the moment the height cache is dropped until the rows have
   * reported again. Scroll events in that window describe a layout built from
   * estimates — the scroll position the list itself moved to while it did not
   * know the sizes — so they say nothing about where the reader is, and must
   * not be taken for the reader scrolling away. Cleared one frame after the
   * commit in which the rows re-measured. A reader who really scrolls in that
   * frame is followed to the bottom once more, which is the lesser fault.
   */
  const remeasuring = useRef(false);
  const forgetHeightsFrom = useCallback((index: number) => {
    for (const key of Object.keys(rowHeights.current)) {
      if (Number(key) >= index) delete rowHeights.current[Number(key)];
    }
    listRef.current?.resetAfterIndex(index, true);
    remeasuring.current = true;
    // The rows on screen must report their sizes again — see `measureEpoch`.
    setMeasureEpoch((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!remeasuring.current) return;
    // The rows' measuring effects ran in this commit, before this one.
    const frame = requestAnimationFrame(() => {
      remeasuring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [measureEpoch]);

  /**
   * Bring the last row into view at the bottom.
   *
   * The scroll is written to the DOM straight away rather than left to
   * react-window's next update. react-window applies a requested offset in its
   * componentDidUpdate, and a scroll event already queued for the *previous*
   * position — the echo of the last scroll, or the browser snapping a
   * fractional offset to its pixel grid — is handled first and overrides the
   * request: the view then stops short of the bottom by however much the rows
   * grew in between, and that event also reads as the reader scrolling away.
   * Writing `scrollTop` now makes the queued event report the new position.
   *
   * The offset is computed here, from the row heights this list measured,
   * not read back from react-window: its `scrollToItem` only queues a state
   * update, so inside a batch the resolved offset is still the old one. The
   * `scrollToItem` call stays so react-window's own state agrees with the DOM
   * once that update lands.
   */
  const scrollToBottom = useCallback(() => {
    const count = itemCountRef.current;
    if (count === 0) return;
    listRef.current?.scrollToItem(count - 1, 'end');
    const outer = outerRef.current;
    if (!outer) return;
    let content = 0;
    for (let i = 0; i < count; i++) content += rowHeights.current[i] ?? DEFAULT_ROW_HEIGHT;
    outer.scrollTop = Math.max(0, content - heightRef.current);
  }, []);

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
      scrollToBottom();
    }
  }, [scrollToBottom]);

  // A new transcript: the rows the heights were measured for are gone, and the
  // reader starts at the bottom of the new one even if they had scrolled up
  // in the old one. Not on mount: nothing has been measured yet, and the mount
  // itself is handled by the first-render scroll below.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    isAtBottom.current = true;
    // Drop react-window's own size cache too: it is keyed by index as well.
    forgetHeightsFrom(0);
    // Bring the last row into the window. Every height is an estimate at
    // this point, so the landing is approximate; the measurements that follow
    // correct it.
    if (items.length > 0) scrollToBottom();
  }, [transcriptEpoch]);

  // The row heights are cached by index, so they describe the rows that were
  // there when they were measured. Appending keeps them valid; anything else —
  // a row removed from the middle, a row replaced in place — shifts the rows
  // after it, and their heights then belong to the wrong rows. Only those are
  // dropped: the rows above the first change are the same rows, and forgetting
  // them would lay the whole transcript out at the 80px estimate — the
  // re-scroll then lands hundreds of pixels above the bottom. That is what
  // sending a message after a finished turn did: it replaces the summary
  // footer, the last row, and every height above it went with it.
  const previous = useRef({ keys: items.map(keyOf) });
  useLayoutEffect(() => {
    const before = previous.current.keys;
    const keys = items.map(keyOf);
    previous.current = { keys };

    // The first index whose row is not the row that was measured there.
    let firstChanged = 0;
    const shared = Math.min(before.length, keys.length);
    while (firstChanged < shared && before[firstChanged] === keys[firstChanged]) firstChanged++;

    const grewByOne = keys.length === before.length + 1;
    // A pure append: every row that was there is still at its index.
    const appended = grewByOne && firstChanged === before.length;
    // The last row was updated in place — the same row, new content.
    const updatedInPlace = keys.length === before.length && firstChanged === keys.length;
    if (appended || updatedInPlace) return;

    forgetHeightsFrom(firstChanged);
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
    scrollToBottom();
  }, [items.length, height]);

  const itemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return index;
      return keyOf(item);
    },
    [items],
  );

  // Row inputs travel through `itemData`, not a closure: react-window renders
  // `children` as a component type, so an inline `(props) => <Row …/>` would be
  // a new type on every render and remount every visible row. A remount throws
  // away a focused text field (the question card's typed answer) on each
  // keystroke, along with any other row-local state. `measureEpoch` rides
  // along so a dropped height cache reaches the rows that stayed mounted.
  const itemData = useMemo<RowData>(
    () => ({ items, setRowHeight, measureEpoch }),
    [items, setRowHeight, measureEpoch],
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
      outerRef={outerRef}
      className="message-list"
      aria-label="Chat messages"
      height={height}
      width={width}
      itemCount={items.length}
      itemSize={getItemSize}
      itemKey={itemKey}
      itemData={itemData}
      overscanCount={4}
      onScroll={({ scrollOffset, scrollUpdateWasRequested }) => {
        if (scrollUpdateWasRequested) return;
        // A layout built from estimates says nothing about the reader.
        if (remeasuring.current) return;
        // Where the bottom is, by the content's actual size. The cached row
        // heights are estimates for every row that was never on screen, so a
        // sum of them can put the bottom anywhere — and a wrong "not at the
        // bottom" stops the list from following new messages.
        const outer = outerRef.current;
        const contentHeight = outer && outer.scrollHeight > 0
          ? outer.scrollHeight
          : items.reduce((sum, _, i) => sum + (rowHeights.current[i] ?? DEFAULT_ROW_HEIGHT), 0);
        isAtBottom.current = contentHeight - scrollOffset - height < AT_BOTTOM_SLACK_PX;
      }}
    >
      {Row}
    </VariableSizeList>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

/** What every row needs from the list, handed over as react-window's `itemData`. */
interface RowData {
  items: ChatItem[];
  setRowHeight: (index: number, size: number) => void;
  /** Changes when the list drops its height cache; rows then measure again. */
  measureEpoch: number;
}

/**
 * Declared at module scope so its identity never changes — see `itemData` in
 * MessageList. `React.memo` only skips work; it is the stable type that keeps a
 * row mounted.
 */
const Row = React.memo(function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const { items, setRowHeight, measureEpoch } = data;
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
    // Measure immediately — on mount, on a new index, and whenever the list
    // has forgotten the heights (`measureEpoch`): the observer only reports
    // changes, and this row's size did not change.
    update();
    return () => ro.disconnect();
  }, [index, setRowHeight, measureEpoch]);

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
