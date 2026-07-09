import { describe, it, expect } from 'vitest';
import {
  mightOverflow,
  shouldCollapse,
  COLLAPSED_MAX_HEIGHT,
  MIN_CHARS_TO_SKIP,
  MIN_NEWLINES_TO_SKIP,
} from './collapsible';

// ── mightOverflow ──────────────────────────────────────────────────────────

describe('mightOverflow', () => {
  it('returns false for empty text', () => {
    expect(mightOverflow('')).toBe(false);
  });

  it('returns false when charCount and newlines are both below thresholds', () => {
    expect(mightOverflow('hello')).toBe(false);
  });

  it('returns true when charCount reaches MIN_CHARS_TO_SKIP', () => {
    expect(mightOverflow('a'.repeat(MIN_CHARS_TO_SKIP))).toBe(true);
  });

  it('returns true when charCount exceeds MIN_CHARS_TO_SKIP', () => {
    expect(mightOverflow('a'.repeat(MIN_CHARS_TO_SKIP + 1))).toBe(true);
  });

  it('returns false when charCount is exactly MIN_CHARS_TO_SKIP - 1 with no newlines', () => {
    expect(mightOverflow('a'.repeat(MIN_CHARS_TO_SKIP - 1))).toBe(false);
  });

  it('returns true when newline count reaches MIN_NEWLINES_TO_SKIP even with few chars', () => {
    const text = '\n'.repeat(MIN_NEWLINES_TO_SKIP);
    expect(mightOverflow(text)).toBe(true);
  });

  it('returns false when newlines are just below MIN_NEWLINES_TO_SKIP', () => {
    const text = '\n'.repeat(MIN_NEWLINES_TO_SKIP - 1);
    expect(mightOverflow(text)).toBe(false);
  });

  it('returns true for a realistic newline-heavy short message (10 short lines)', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    expect(mightOverflow(text)).toBe(true);
  });
});

// ── shouldCollapse ─────────────────────────────────────────────────────────

describe('shouldCollapse', () => {
  it('returns false when scrollHeight is below COLLAPSED_MAX_HEIGHT', () => {
    expect(shouldCollapse(100)).toBe(false);
  });

  it('returns false when scrollHeight equals COLLAPSED_MAX_HEIGHT (not strictly over)', () => {
    expect(shouldCollapse(COLLAPSED_MAX_HEIGHT)).toBe(false);
  });

  it('returns true when scrollHeight is exactly COLLAPSED_MAX_HEIGHT + 1', () => {
    expect(shouldCollapse(COLLAPSED_MAX_HEIGHT + 1)).toBe(true);
  });

  it('returns true when scrollHeight is well above COLLAPSED_MAX_HEIGHT', () => {
    expect(shouldCollapse(600)).toBe(true);
  });

  it('returns false for zero scrollHeight', () => {
    expect(shouldCollapse(0)).toBe(false);
  });
});
