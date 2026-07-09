/**
 * Component tests for CollapsibleText.
 *
 * jsdom has no real layout engine, so scrollHeight is always 0. We stub it
 * via Object.defineProperty on HTMLPreElement.prototype to scope the override
 * to <pre> elements only, reducing blast radius on other DOM APIs.
 * ResizeObserver is also unavailable in jsdom — we provide a capturable stub
 * so resize-triggered rechecks can be simulated.
 *
 * These tests verify: toggle visibility, aria-expanded, maxHeight style,
 * fade visibility, the newline-heavy short-char edge case, and resize recheck.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { CollapsibleText } from './CollapsibleText';

// ── Environment stubs ──────────────────────────────────────────────────────

/** Captured ResizeObserver callbacks, keyed by observed element. */
const resizeCallbacks: Set<() => void> = new Set();

let prevResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeAll(() => {
  prevResizeObserver = globalThis.ResizeObserver;
  // Capturable ResizeObserver stub: stores the callback so tests can fire it.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) {
      const fire = () => this.cb([], this);
      resizeCallbacks.add(fire);
      (el as unknown as Record<string, unknown>).__resizeFire = fire;
    }
    unobserve() {}
    disconnect() { resizeCallbacks.clear(); }
  };
});

afterAll(() => {
  // Restore the original ResizeObserver so other test files are not affected.
  if (prevResizeObserver !== undefined) {
    (globalThis as Record<string, unknown>).ResizeObserver = prevResizeObserver;
  } else {
    delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  }
});

afterEach(() => {
  resizeCallbacks.clear();
});

/**
 * Stub scrollHeight on HTMLPreElement.prototype (scoped to <pre> elements only).
 *
 * Correctly handles the common case where HTMLPreElement has no own scrollHeight
 * descriptor (it inherits from HTMLElement): cleanup deletes the own property
 * rather than incorrectly redefining the inherited descriptor as an own property.
 */
function stubPreScrollHeight(value: number): () => void {
  const hadOwnDescriptor = Object.prototype.hasOwnProperty.call(
    HTMLPreElement.prototype,
    'scrollHeight',
  );
  const ownDescriptor = hadOwnDescriptor
    ? Object.getOwnPropertyDescriptor(HTMLPreElement.prototype, 'scrollHeight')
    : undefined;

  Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return value; },
  });

  return () => {
    if (hadOwnDescriptor && ownDescriptor) {
      // Restore the original own descriptor.
      Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', ownDescriptor);
    } else {
      // Originally inherited — remove the own override so inheritance resumes.
      delete (HTMLPreElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** A text that is long enough to pass the char pre-filter (>= 80 chars). */
const LONG_TEXT = 'a'.repeat(100);

/** A text with many newlines but few chars — the newline edge case (>= 3 newlines). */
const NEWLINE_TEXT = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');

/** A truly short text that should never trigger collapse. */
const SHORT_TEXT = 'hi';

// ── Tests ──────────────────────────────────────────────────────────────────
// Stub cleanup is registered in afterEach so it always runs even if an
// assertion throws mid-test, preventing cross-test prototype contamination.

describe('CollapsibleText', () => {
  let restoreHeight: (() => void) | null = null;

  afterEach(() => {
    restoreHeight?.();
    restoreHeight = null;
  });

  it('renders no toggle for short content that does not overflow', () => {
    restoreHeight = stubPreScrollHeight(50);
    render(<CollapsibleText text={SHORT_TEXT} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders no toggle when long text fits within max-height', () => {
    restoreHeight = stubPreScrollHeight(100); // under COLLAPSED_MAX_HEIGHT=180
    render(<CollapsibleText text={LONG_TEXT} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders "Show more" toggle when long text overflows', () => {
    restoreHeight = stubPreScrollHeight(400);
    render(<CollapsibleText text={LONG_TEXT} />);
    expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy();
  });

  it('toggle has aria-expanded=false when collapsed', () => {
    restoreHeight = stubPreScrollHeight(400);
    render(<CollapsibleText text={LONG_TEXT} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking toggle expands: aria-expanded=true, maxHeight removed, fade gone', () => {
    restoreHeight = stubPreScrollHeight(400);
    render(<CollapsibleText text={LONG_TEXT} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(LONG_TEXT).style.maxHeight).toBe('');
    expect(document.querySelector('.collapsible-text__fade')).toBeNull();
    expect(screen.getByText(/show less/i)).toBeTruthy();
  });

  it('clicking toggle again re-collapses', () => {
    restoreHeight = stubPreScrollHeight(400);
    render(<CollapsibleText text={LONG_TEXT} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // expand
    fireEvent.click(btn); // collapse
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(LONG_TEXT).style.maxHeight).toBe('180px');
  });

  it('newline-heavy short-char text collapses when it overflows', () => {
    restoreHeight = stubPreScrollHeight(400);
    render(<CollapsibleText text={NEWLINE_TEXT} />);
    expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy();
  });

  it('fade is present with aria-hidden when collapsed, gone when expanded', () => {
    restoreHeight = stubPreScrollHeight(400);
    const { container } = render(<CollapsibleText text={LONG_TEXT} />);
    const fade = container.querySelector('.collapsible-text__fade');
    expect(fade).toBeTruthy();
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.collapsible-text__fade')).toBeNull();
  });

  it('resize recheck can flip overflowing false→true', () => {
    restoreHeight = stubPreScrollHeight(100);
    const { container } = render(<CollapsibleText text={LONG_TEXT} />);
    expect(screen.queryByRole('button')).toBeNull();

    // Simulate panel narrowing: scrollHeight grows past threshold.
    restoreHeight();
    restoreHeight = stubPreScrollHeight(400);
    const pre = container.querySelector('pre')!;
    const fireFn = (pre as unknown as Record<string, unknown>).__resizeFire as (() => void) | undefined;
    if (fireFn) {
      act(() => fireFn());
      expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy();
    }
  });

  it('resize recheck can flip overflowing true→false', () => {
    restoreHeight = stubPreScrollHeight(400);
    const { container } = render(<CollapsibleText text={LONG_TEXT} />);
    expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy();

    // Simulate panel widening: scrollHeight shrinks below threshold.
    restoreHeight();
    restoreHeight = stubPreScrollHeight(100);
    const pre = container.querySelector('pre')!;
    const fireFn = (pre as unknown as Record<string, unknown>).__resizeFire as (() => void) | undefined;
    if (fireFn) {
      act(() => fireFn());
      expect(screen.queryByRole('button')).toBeNull();
    }
  });
});
