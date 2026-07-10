/**
 * CollapsibleText — wraps a single plain-text user segment.
 *
 * Short messages render as a bare <pre> (no measuring cost, no toggle).
 * Long ones collapse to COLLAPSED_MAX_HEIGHT with a gradient fade and a
 * "Show more / Show less" pill below — mirroring the SkillBlock chevron idiom.
 *
 * The row's existing ResizeObserver + resetAfterIndex reflow is sufficient:
 * toggling changes the <pre> DOM height, which the row observer picks up and
 * forwards to react-window automatically. No new size-reporting channel needed.
 *
 * Measurement invariant: scrollHeight is always read on the <pre> with collapsed
 * styles stripped (no maxHeight). scrollHeight reports the full content height
 * regardless of the CSS max-height clamp, so it stays stable across toggles.
 */
import { useState, useRef, useLayoutEffect, useCallback } from 'react';
import { mightOverflow, shouldCollapse, COLLAPSED_MAX_HEIGHT } from '../lib/collapsible';

interface Props {
  text: string;
}

export function CollapsibleText({ text }: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Reset to collapsed whenever the text changes (row reuse / edited turn).
  // useLayoutEffect so the reset happens before paint — prevents a flash of
  // the previous message's expanded state when react-window reuses a row.
  useLayoutEffect(() => {
    setExpanded(false);
  }, [text]);

  // Measure overflow after layout. useLayoutEffect so the clamp is applied
  // before the first paint (avoids a one-frame flash of the full bubble).
  //
  // Fast-path: truly tiny messages skip all DOM reads and observer setup.
  // All other messages are measured — conservative threshold avoids missed
  // collapses on narrow panels, large fonts, or wide-glyph languages.
  //
  // KEY: we read el.scrollHeight WITHOUT any collapsed-only styles on the <pre>
  // itself. The collapsed padding-bottom lives on .collapsible-text__bubble
  // (the wrapper div), so the <pre>'s scrollHeight is always the natural content
  // height — stable across resize rechecks even in the collapsed state.
  useLayoutEffect(() => {
    if (!mightOverflow(text)) {
      setOverflowing(false);
      return;
    }

    const el = ref.current;
    if (!el) return;

    const check = () => {
      // scrollHeight reflects the full content height regardless of the
      // CSS max-height clamp — no need to temporarily remove inline styles.
      // Mutating styles inside a ResizeObserver callback can trigger loop
      // warnings; reading scrollHeight directly is both correct and safe.
      setOverflowing(shouldCollapse(el.scrollHeight));
    };

    check();

    // Re-check if the container is resized (e.g. panel width change).
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(check);
      ro.observe(el);
      return () => ro.disconnect();
    }

    // Fallback for environments without ResizeObserver.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', check);
      return () => window.removeEventListener('resize', check);
    }

    // No observer available (SSR / non-browser) — one-time check is enough.
  }, [text]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const collapsed = overflowing && !expanded;

  return (
    <div className="collapsible-text">
      {/* Bubble wrapper: position:relative so the fade anchors to the <pre>,
          not to the outer flex column that also contains the toggle button. */}
      <div className="collapsible-text__bubble">
        <pre
          ref={ref}
          className={`user-message__text${collapsed ? ' user-message__text--collapsed' : ''}`}
          style={collapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
        >
          {text}
        </pre>
        {collapsed && <div className="collapsible-text__fade" aria-hidden="true" />}
      </div>
      {overflowing && (
        <button
          type="button"
          className="collapsible-text__toggle"
          onClick={toggle}
          aria-expanded={expanded}
        >
          <span
            className={`collapsible-text__chevron${expanded ? ' collapsible-text__chevron--open' : ''}`}
          >
            ▾
          </span>
          <span>{expanded ? 'Show less' : 'Show more'}</span>
        </button>
      )}
    </div>
  );
}
