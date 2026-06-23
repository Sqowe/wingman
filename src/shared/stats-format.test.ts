/**
 * Unit tests for the model-label formatters used by the model status bar.
 */
import { describe, it, expect } from 'vitest';
import { formatModelLabel, formatModelStatus } from './stats-format';
import type { ModelState } from './messages';

const state = (over: Partial<ModelState> = {}): ModelState => ({
  modelId: null,
  modelName: null,
  provider: null,
  thinkingLevel: null,
  ...over,
});

describe('formatModelLabel', () => {
  it('prefers the human name', () => {
    expect(formatModelLabel(state({ modelName: 'HY3 Preview', modelId: 'tencent/hy3-preview' }))).toBe('HY3 Preview');
  });

  it('falls back to the last path segment of the id', () => {
    expect(formatModelLabel(state({ modelId: 'tencent/hy3-preview' }))).toBe('hy3-preview');
    expect(formatModelLabel(state({ modelId: 'claude-sonnet-4.6' }))).toBe('claude-sonnet-4.6');
  });

  it('returns a dash when nothing is known', () => {
    expect(formatModelLabel(null)).toBe('—');
    expect(formatModelLabel(state())).toBe('—');
  });
});

describe('formatModelStatus', () => {
  it('appends the thinking level', () => {
    expect(formatModelStatus(state({ modelName: 'HY3 Preview', thinkingLevel: 'high' }))).toBe('HY3 Preview · high');
  });

  it('omits the thinking level when none/off/absent', () => {
    expect(formatModelStatus(state({ modelName: 'M', thinkingLevel: 'none' }))).toBe('M');
    expect(formatModelStatus(state({ modelName: 'M', thinkingLevel: 'off' }))).toBe('M');
    expect(formatModelStatus(state({ modelName: 'M' }))).toBe('M');
  });

  it('combines the id fallback with the thinking level', () => {
    expect(formatModelStatus(state({ modelId: 'a/b/deepseek-v4-pro', thinkingLevel: 'medium' }))).toBe('deepseek-v4-pro · medium');
  });
});
