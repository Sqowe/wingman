/**
 * Scroll behaviour of the transcript list.
 *
 * jsdom has no layout, so the geometry is faked: `getBoundingClientRect`
 * reports a height per row kind, and a stub ResizeObserver lets a test fire
 * the "the row grew" callback on demand. That is enough to pin the scroll
 * arithmetic react-window does — the list's `scrollTop` is the offset the
 * rows are positioned against.
 *
 * What these tests defend: the auto-scroll to the bottom is driven by the
 * *content*, not by every render. A question card's answer field keeps its
 * text in the store, so typing in it re-renders the list on every keystroke;
 * scrolling on each of those renders snapped the transcript to a position
 * computed from stale row heights, and the view jumped away from the card
 * being typed into.
 *
 * And one more property, pinned at the end: a re-render must update the rows
 * on screen, never remount them. react-window 1.x renders `children` as a
 * component type, so an inline row renderer is a new type on every render and
 * React replaced every visible row — including the answer field the user was
 * typing in, which lost the caret on each keystroke.
 */
import { render, act, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VariableSizeList } from 'react-window';
import { MessageList } from './MessageList';
import type { ChatItem } from '../store';

// The card pulls in the shared markdown renderer, whose copy buttons reach for
// the VS Code bridge. Delivery is covered elsewhere; here a stub is enough.
vi.mock('../vscodeApi', () => ({ vscode: { postMessage: vi.fn() } }));

// ── Faked layout ─────────────────────────────────────────────────────────────

/** Row heights by content marker. The first match wins, so longer markers go first. */
const HEIGHTS: Array<[string, number]> = [
  ['TALLASSISTANT', 900],
  ['TALLUSER', 400],
  ['USER', 100],
  ['ASSISTANT', 400],
  ['QUESTION', 300],
];

/** Overrides the height of the rows whose text contains the marker. */
const heightOverrides = new Map<string, number>();

/** Live observers, so a test can deliver a layout change to them. */
const observers: FakeResizeObserver[] = [];

/** The global the stub replaces, restored after each test. */
const realResizeObserver = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;

/**
 * Delivers a callback only for an element whose height changed since the last
 * delivery — what a browser does. An observer that fired for every element on
 * every "resize" would re-measure rows whose size never changed and hide a list
 * that forgets their heights.
 */
class FakeResizeObserver implements ResizeObserver {
  private readonly heights = new Map<Element, number>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element): void {
    // A browser reports once on observe; the row measures itself on mount, so
    // this only records the size it starts from.
    this.heights.set(target, target.getBoundingClientRect().height);
  }
  unobserve(target: Element): void {
    this.heights.delete(target);
  }
  disconnect(): void {
    // A row that unmounts must not keep firing: a later fireResize() would
    // otherwise call a callback for an element that is no longer on screen.
    this.heights.clear();
    const at = observers.indexOf(this);
    if (at >= 0) observers.splice(at, 1);
  }
  /** Report the elements whose height changed. */
  deliver(): void {
    const changed: Element[] = [];
    for (const [target, last] of this.heights) {
      const now = target.getBoundingClientRect().height;
      if (now !== last) {
        this.heights.set(target, now);
        changed.push(target);
      }
    }
    if (changed.length > 0) {
      this.callback(changed.map((target) => ({ target }) as ResizeObserverEntry), this);
    }
  }
}

/** Deliver a layout change to every observer, as the browser would after reflow. */
function fireResize(): void {
  act(() => {
    for (const observer of [...observers]) observer.deliver();
  });
}

beforeEach(() => {
  heightOverrides.clear();
  observers.length = 0;
  swallowScrollEvents = true;
  document.addEventListener('scroll', swallowScrollEvent, true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const text = this.textContent ?? '';
    const marker = HEIGHTS.find(([m]) => text.includes(m))?.[0] ?? 'USER';
    const height = heightOverrides.get(marker) ?? HEIGHTS.find(([m]) => m === marker)![1];
    return {
      height, width: 300, top: 0, left: 0, bottom: height, right: 300, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  // jsdom has no layout, so the scroll container's geometry is derived from
  // what react-window rendered: the viewport is the outer element's height,
  // the content is the inner element's height.
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    if (!this.classList.contains('message-list')) return 0;
    return parseFloat((this as HTMLElement).style.height) || 0;
  });
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    if (!this.classList.contains('message-list')) return 0;
    const inner = this.firstElementChild as HTMLElement | null;
    return Math.max(parseFloat(inner?.style.height ?? '') || 0, parseFloat((this as HTMLElement).style.height) || 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.removeEventListener('scroll', swallowScrollEvent, true);
  // The stub is a plain assignment, not a spy, so restoreAllMocks leaves it
  // behind — it would leak into every later test file in this process.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realResizeObserver;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VIEWPORT = 300;

function userItem(text = 'USER'): ChatItem {
  return { itemKind: 'user', id: `u-${text}`, text, timestamp: 1 } as unknown as ChatItem;
}

function assistantItem(text = 'ASSISTANT'): ChatItem {
  return {
    itemKind: 'assistant', id: `a-${text}`, blocks: [{ kind: 'text', text }],
    isComplete: true, timestamp: 2,
  } as unknown as ChatItem;
}

/** The end-of-turn footer; its id is fixed, so it is replaced rather than added. */
function summaryItem(): ChatItem {
  return {
    itemKind: 'summary', id: 'summary-final',
    stats: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    timestamp: 4,
  } as unknown as ChatItem;
}

function questionItem(draft?: string): ChatItem {
  return {
    itemKind: 'question', id: 'q1', kind: 'text', question: 'QUESTION',
    options: [], instructions: 'Type your answer:', status: 'open', selected: [],
    expanded: false, timestamp: 3, ...(draft !== undefined ? { draft } : {}),
  } as unknown as ChatItem;
}

/** The offset the list is scrolled to. */
function offsetOf(container: HTMLElement): number {
  return (container.querySelector('.message-list') as HTMLElement).scrollTop;
}

/**
 * Whether scroll events are still being swallowed.
 *
 * jsdom fires a scroll event when react-window writes the initial scroll
 * position, even though the value did not change. A browser does not, and
 * the event would tell the list that the reader had already scrolled away —
 * before it has scrolled to the bottom even once. The events are swallowed
 * until a test simulates a reader.
 */
let swallowScrollEvents = true;

/** The capture-phase listener that swallows the events jsdom invents. */
function swallowScrollEvent(event: Event): void {
  if (swallowScrollEvents) event.stopImmediatePropagation();
}

/** Simulate the reader scrolling: the list has to hear about it. */
function userScrollsTo(container: HTMLElement, offset: number): void {
  swallowScrollEvents = false;
  const list = container.querySelector('.message-list') as HTMLElement;
  act(() => {
    list.scrollTop = offset;
    list.dispatchEvent(new Event('scroll'));
  });
}

/** Simulate the reader being at the bottom. */
function pinToBottom(container: HTMLElement): void {
  userScrollsTo(container, offsetOf(container));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MessageList — auto-scroll', () => {
  it('lands on the bottom when the transcript is shown', () => {
    const { container } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    // 100 + 400 + 300 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(500);
  });

  it('does not scroll when a row re-renders without changing the content', () => {
    // The card's answer field lives in the store: every keystroke re-renders
    // the list with a new item object. The list must not scroll — its scroll
    // target is computed from cached row heights, and re-applying a stale one
    // is what yanked the transcript away from the card being typed into.
    const scrollSpy = vi.spyOn(VariableSizeList.prototype, 'scrollToItem');
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    pinToBottom(container);
    const calls = scrollSpy.mock.calls.length;
    const before = offsetOf(container);

    rerender(
      <MessageList items={[userItem(), assistantItem(), questionItem('h')]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    expect(scrollSpy.mock.calls.length).toBe(calls);
    expect(offsetOf(container)).toBe(before);
  });

  it('does not move on a keystroke even when the cached row height went stale', () => {
    // The reported symptom: typing in the card's field sent the transcript
    // jumping up to the beginning of the last model output. The scroll target
    // is computed from the cached row heights; when one of them is stale the
    // target sits a viewport-height above the content, and re-applying it on
    // every keystroke yanked the view away from the card being typed into.
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(500);

    // The panel was hidden for a moment: the row reports a zero height.
    heightOverrides.set('QUESTION', 0);
    fireResize();

    rerender(
      <MessageList items={[userItem(), assistantItem(), questionItem('h')]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    expect(offsetOf(container)).toBe(500);
  });

  it('follows the bottom when a new item arrives', () => {
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(200);

    rerender(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    // The new row is measured after the first paint, and the re-scroll follows.
    fireResize();
    expect(offsetOf(container)).toBe(500);
  });

  it('follows the bottom when the last row grows', () => {
    // Streaming: the assistant message grows, and the view stays pinned.
    const { container } = render(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(200);

    heightOverrides.set('ASSISTANT', 700);
    fireResize();

    expect(offsetOf(container)).toBe(500);
  });

  it('follows the bottom when a row above it grows', () => {
    // An expanded tool card pushes the last messages below the fold; the view
    // has to follow them down.
    const { container } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(500);

    heightOverrides.set('ASSISTANT', 900);
    fireResize();

    // 100 + 900 + 300 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(1000);
  });

  it('ignores a zero measurement instead of collapsing the row', () => {
    // A hidden panel reports zero for every row. That is not a size: storing
    // it would collapse the row and poison the offsets of the rows below it.
    const { container } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(500);

    heightOverrides.set('QUESTION', 0);
    fireResize();

    expect(offsetOf(container)).toBe(500);
    // The row keeps the height it had.
    const rows = container.querySelectorAll('.message-row');
    const lastRow = rows[rows.length - 1].parentElement as HTMLElement;
    expect(lastRow.style.height).toBe('300px');
  });

  it('re-measures the last row when it is replaced in place', () => {
    // A regenerated turn at the same index: the measured height belongs to the
    // row that was there before, so it must not be kept.
    heightOverrides.set('TALLASSISTANT', 900);
    const { container, rerender } = render(
      <MessageList
        items={[userItem(), assistantItem()]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    expect(offsetOf(container)).toBe(200);

    rerender(
      <MessageList
        items={[userItem(), assistantItem('TALLASSISTANT')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();

    // 100 + 900 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(700);
  });

  it('does not follow the bottom when the reader has scrolled away from it', () => {
    // The other half of the contract: a list the reader has left must stay
    // where they left it — no new item, no resize, no resized viewport pulls
    // it back.
    const scrollSpy = vi.spyOn(VariableSizeList.prototype, 'scrollToItem');
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    userScrollsTo(container, 0);
    const before = offsetOf(container);
    const calls = scrollSpy.mock.calls.length;

    // A row above grows.
    heightOverrides.set('ASSISTANT', 900);
    fireResize();
    expect(offsetOf(container)).toBe(before);

    // A new item arrives.
    rerender(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(before);

    // The composer grows, shrinking the viewport.
    rerender(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT - 100} width={300} />,
    );
    expect(offsetOf(container)).toBe(before);

    expect(scrollSpy.mock.calls.length).toBe(calls);
  });

  it('opens a new transcript at the bottom even when the reader had scrolled away', () => {
    // Switching sessions replaces the transcript. The new one starts at its
    // bottom, whatever the reader did in the old one.
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    userScrollsTo(container, 0);

    rerender(
      <MessageList
        items={[userItem('OTHERUSER'), assistantItem('OTHERASSISTANT')]}
        transcriptEpoch={1}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();

    // 100 + 400 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(200);
  });

  it('forgets the row heights of a transcript it no longer shows', () => {
    // A restored session replaces the items wholesale. The heights of the old
    // rows, cached by index, would otherwise be read as the offsets of
    // unrelated rows — the new transcript's first row is a tall one, so the
    // stale 100px would put the bottom 300px too high.
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    expect(offsetOf(container)).toBe(200);

    rerender(
      <MessageList
        items={[userItem('TALLUSER'), assistantItem('ASSISTANT')]}
        transcriptEpoch={1}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();

    // 400 + 400 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(500);
  });
});

/** The scroll position the bottom of the content sits at. */
function bottomOf(container: HTMLElement): number {
  const list = container.querySelector('.message-list') as HTMLElement;
  return list.scrollHeight - list.clientHeight;
}

describe('MessageList — landing on the bottom (from a live trace)', () => {
  it('is not pulled back by the echo of its own previous scroll', () => {
    // Recorded live: a new card arrived at the 80px estimate, and the list
    // scrolled to the bottom for it. In the same moment the card measured
    // 273px and the list asked react-window for the new bottom — but the
    // browser's scroll event for the *previous* position was handled after
    // that request and overrode it. The view stayed 273 - 80 = 193px above
    // the bottom, and the event made the list believe the reader had scrolled
    // away, so it stopped following for every later message.
    heightOverrides.set('TALLASSISTANT', 80);
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    rerender(
      <MessageList
        items={[userItem(), assistantItem(), questionItem(), assistantItem('TALLASSISTANT')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    // 100 + 400 + 300 + 80 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(580);

    // The card lays out at its real height, and the browser reports the
    // position the list scrolled to a moment ago — both in one frame.
    heightOverrides.set('TALLASSISTANT', 900);
    const list = container.querySelector('.message-list') as HTMLElement;
    act(() => {
      for (const observer of [...observers]) observer.deliver();
      swallowScrollEvents = false;
      list.dispatchEvent(new Event('scroll'));
      swallowScrollEvents = true;
    });

    // 100 + 400 + 300 + 900.
    expect(offsetOf(container)).toBe(1400);

    // And it still follows the bottom.
    rerender(
      <MessageList
        items={[userItem(), assistantItem(), questionItem(), assistantItem('TALLASSISTANT'), userItem('USER2')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();
    expect(offsetOf(container)).toBe(1500);
  });

  it('judges "at the bottom" by the content, not by height estimates', () => {
    // The list keeps its own sum of row heights, with an 80px estimate for
    // every row it has not measured. When that sum disagrees with the content
    // the browser laid out, a reader at the true end must still be taken as
    // "at the bottom" — otherwise the next message is not followed. Here a
    // row reports a height the list then ignores (zero, as while the panel is
    // hidden), so its cached size stays above what is on screen.
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    // The list's cache still says 400 for the answer; the content is 200 shorter.
    heightOverrides.set('ASSISTANT', 200);
    const list = container.querySelector('.message-list') as HTMLElement;
    const inner = list.firstElementChild as HTMLElement;
    inner.style.height = `${parseFloat(inner.style.height) - 200}px`;

    // The reader scrolls to the real end of the content.
    userScrollsTo(container, bottomOf(container));

    rerender(
      <MessageList
        items={[userItem(), assistantItem(), questionItem(), userItem('USER2')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();

    // 100 + 200 + 300 + 100 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(400);
  });
});

describe('MessageList — row identity across re-renders', () => {
  it('does not jump up when the summary gives way to a new message', () => {
    // Recorded live: sending a message after a finished turn replaced the
    // summary footer, and the list dropped the heights of *every* row. The
    // re-scroll that followed was computed from 80px estimates — hundreds of
    // pixels above the bottom — and the browser's scroll event for that
    // position arrived before the rows had measured again, so the list took
    // it for the reader scrolling away and stopped following.
    const { container, rerender } = render(
      <MessageList
        items={[userItem(), assistantItem('TALLASSISTANT'), questionItem(), summaryItem()]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    // 100 + 900 + 300 + 100 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(1100);

    const list = container.querySelector('.message-list') as HTMLElement;
    const writes: number[] = [];
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    vi.spyOn(list, 'scrollTop', 'set').mockImplementation(function (this: Element, v: number) {
      writes.push(v);
      desc.set!.call(this, v);
    });
    vi.spyOn(list, 'scrollTop', 'get').mockImplementation(function (this: Element) {
      return desc.get!.call(this) as number;
    });

    const sent = [userItem(), assistantItem('TALLASSISTANT'), questionItem(), userItem('NEXTUSER')];
    rerender(<MessageList items={sent} transcriptEpoch={0} height={VIEWPORT} width={300} />);
    // The browser reports the position the list just scrolled to, before
    // anything has measured again.
    act(() => {
      swallowScrollEvents = false;
      list.dispatchEvent(new Event('scroll'));
      swallowScrollEvents = true;
    });
    fireResize();

    // The bottom never moved: 100 + 900 + 300 + 100.
    expect(Math.min(...writes)).toBeGreaterThanOrEqual(1100);
    expect(offsetOf(container)).toBe(1100);

    // And it still follows the bottom.
    rerender(
      <MessageList items={[...sent, assistantItem('ASSISTANT2')]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    fireResize();
    expect(offsetOf(container)).toBe(1500);
  });

  it('ignores a scroll event while rows re-measure after the cache was dropped', () => {
    // Removing a row from the middle still drops the heights below it. Until
    // those rows report again, the layout is built from estimates, and a
    // scroll event in that window — here one that reads as far from the bottom
    // — describes the estimate, not the reader.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const { container, rerender } = render(
      <MessageList
        items={[userItem(), assistantItem(), questionItem(), userItem('USER2')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    const list = container.querySelector('.message-list') as HTMLElement;

    // The question card is withdrawn from the middle of the transcript.
    rerender(
      <MessageList items={[userItem(), assistantItem(), userItem('USER2')]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    act(() => {
      swallowScrollEvents = false;
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      swallowScrollEvents = true;
    });
    fireResize();
    raf.mockRestore();

    // Still following: a new message lands at the bottom.
    rerender(
      <MessageList
        items={[userItem(), assistantItem(), userItem('USER2'), assistantItem('ASSISTANT2')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();
    // 100 + 400 + 100 + 400 rows in a 300px viewport.
    expect(offsetOf(container)).toBe(700);
  });

  it('keeps rows from overlapping when the summary gives way to a new message', () => {
    // Sending a message after a finished turn removes the summary footer and
    // appends the user's message: same length, a different last row, so the
    // list drops its height cache. The rows still on screen stay mounted and
    // their size never changes, so a browser does not report them again — if
    // the list waited for that, they would be laid out at the 80px estimate
    // and the rows below would be drawn over them.
    const { container, rerender } = render(
      <MessageList items={[userItem(), assistantItem(), summaryItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    rerender(
      <MessageList
        items={[userItem(), assistantItem(), userItem('NEXTUSER')]}
        transcriptEpoch={0}
        height={VIEWPORT}
        width={300}
      />,
    );
    fireResize();

    // USER 100 + ASSISTANT 400: the new message starts below the answer.
    const rows = [...container.querySelectorAll('.message-row')].map((r) => r.parentElement as HTMLElement);
    expect(rows.map((r) => r.style.top)).toEqual(['0px', '100px', '500px']);
  });
  it('keeps the answer field, and its focus, while the user types', () => {
    const { rerender } = render(
      <MessageList items={[userItem(), questionItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    const field = screen.getByRole('textbox', { name: 'Your answer' });
    field.focus();
    expect(field).toHaveFocus();

    // One keystroke: the card writes the draft to the store, which hands the
    // list a new item object and re-renders it.
    fireEvent.change(field, { target: { value: 'a' } });
    rerender(
      <MessageList items={[userItem(), questionItem('a')]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    const after = screen.getByRole('textbox', { name: 'Your answer' });
    expect(after).toBe(field);
    expect(after).toHaveFocus();
    expect(after).toHaveValue('a');
  });

  it('does not remount a row when another item arrives', () => {
    const { rerender } = render(
      <MessageList items={[userItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );
    const bubble = screen.getByLabelText('Your message');

    rerender(
      <MessageList items={[userItem(), assistantItem()]} transcriptEpoch={0} height={VIEWPORT} width={300} />,
    );

    expect(screen.getByLabelText('Your message')).toBe(bubble);
  });
});















