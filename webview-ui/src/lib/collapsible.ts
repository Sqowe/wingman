/**
 * Pure helpers for collapsible text logic.
 * Kept separate so they can be unit-tested in the node environment
 * without a DOM / component harness.
 */

/** Collapsed max-height in px. ~8 lines at line-height 1.5 and VS Code's default font. */
export const COLLAPSED_MAX_HEIGHT = 180;

/**
 * Cheap pre-filter thresholds. A message is measured unless BOTH conditions hold:
 *   - charCount < MIN_CHARS_TO_SKIP, AND
 *   - newlineCount < MIN_NEWLINES_TO_SKIP
 *
 * Conservative values so narrow panels, large fonts, and wide-glyph languages
 * don't cause missed collapses.
 */
export const MIN_CHARS_TO_SKIP = 80;
export const MIN_NEWLINES_TO_SKIP = 3;

/**
 * Returns true when text is long enough that it *might* overflow the clamp.
 * Passes through to DOM measurement; only truly tiny messages are skipped.
 */
export function mightOverflow(text: string): boolean {
  if (text.length >= MIN_CHARS_TO_SKIP) return true;
  let nl = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      nl++;
      if (nl >= MIN_NEWLINES_TO_SKIP) return true;
    }
  }
  return false;
}

/**
 * Returns true when a text segment should be clamped, given the element's
 * scrollHeight.
 *
 * scrollHeight reports the full content height regardless of CSS max-height or
 * overflow — so it is stable across collapsed/expanded states and safe to read
 * directly from the clamped element without temporarily removing styles.
 */
export function shouldCollapse(scrollHeight: number): boolean {
  return scrollHeight > COLLAPSED_MAX_HEIGHT;
}
