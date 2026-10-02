/**
 * Unit tests for the pure model-memory helpers.
 *
 * Covers the validation/normalization that guards the persisted value before it
 * is ever turned into a set_model / set_thinking_level command, plus the
 * partial-merge semantics (a thinking-level write must not erase the model half).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  MODEL_MEMORY_KEY,
  normalizeModelMemory,
  hasModelRef,
  mergeModelMemory,
  readModelMemory,
  writeModelMemory,
  type MementoLike,
} from './model-memory';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMemento(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string) => store[key] as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => {
      store[key] = value;
    }),
  };
}

// ─── normalizeModelMemory ────────────────────────────────────────────────────

describe('normalizeModelMemory', () => {
  it('keeps the three known string fields', () => {
    expect(normalizeModelMemory({ provider: 'p', modelId: 'm', thinkingLevel: 'high' }))
      .toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });

  it('returns undefined for non-objects', () => {
    expect(normalizeModelMemory(null)).toBeUndefined();
    expect(normalizeModelMemory(undefined)).toBeUndefined();
    expect(normalizeModelMemory('p/m')).toBeUndefined();
    expect(normalizeModelMemory(42)).toBeUndefined();
  });

  it('drops non-string and empty values', () => {
    expect(normalizeModelMemory({ provider: 7, modelId: '', thinkingLevel: 'low' }))
      .toEqual({ thinkingLevel: 'low' });
  });

  it('trims stored values so a padded id is never sent verbatim', () => {
    expect(normalizeModelMemory({ provider: ' p ', modelId: ' m\n', thinkingLevel: ' high ' }))
      .toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });

  it('returns undefined when nothing usable survives (no empty object)', () => {
    expect(normalizeModelMemory({})).toBeUndefined();
    expect(normalizeModelMemory({ provider: '   ' })).toBeUndefined();
  });

  it('ignores unknown extra fields', () => {
    expect(normalizeModelMemory({ provider: 'p', modelId: 'm', bogus: 'x' }))
      .toEqual({ provider: 'p', modelId: 'm' });
  });
});

// ─── hasModelRef ─────────────────────────────────────────────────────────────

describe('hasModelRef', () => {
  it('requires both provider and modelId', () => {
    expect(hasModelRef({ provider: 'p', modelId: 'm' })).toBe(true);
    expect(hasModelRef({ provider: 'p' })).toBe(false);
    expect(hasModelRef({ modelId: 'm' })).toBe(false);
    expect(hasModelRef({ thinkingLevel: 'high' })).toBe(false);
    expect(hasModelRef(undefined)).toBe(false);
  });
});

// ─── mergeModelMemory ────────────────────────────────────────────────────────

describe('mergeModelMemory', () => {
  it('overlays the patch onto the previous value', () => {
    expect(mergeModelMemory(
      { provider: 'old', modelId: 'old', thinkingLevel: 'low' },
      { provider: 'new', modelId: 'new' },
    )).toEqual({ provider: 'new', modelId: 'new', thinkingLevel: 'low' });
  });

  it('does not let a thinking-only write erase the model half', () => {
    expect(mergeModelMemory({ provider: 'p', modelId: 'm' }, { thinkingLevel: 'high' }))
      .toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });

  it('ignores empty / undefined patch fields', () => {
    expect(mergeModelMemory(
      { provider: 'p', modelId: 'm' },
      { provider: undefined, modelId: '', thinkingLevel: undefined },
    )).toEqual({ provider: 'p', modelId: 'm' });
  });

  it('seeds from an empty previous value', () => {
    expect(mergeModelMemory(undefined, { provider: 'p', modelId: 'm' }))
      .toEqual({ provider: 'p', modelId: 'm' });
  });

  it('returns undefined when both sides are empty', () => {
    expect(mergeModelMemory(undefined, {})).toBeUndefined();
  });
});

// ─── read / write ────────────────────────────────────────────────────────────

describe('readModelMemory / writeModelMemory', () => {
  it('reads and normalizes a stored value', () => {
    const memento = makeMemento({ [MODEL_MEMORY_KEY]: { provider: 'p', modelId: 'm' } });
    expect(readModelMemory(memento)).toEqual({ provider: 'p', modelId: 'm' });
  });

  it('returns undefined when nothing is stored', () => {
    expect(readModelMemory(makeMemento())).toBeUndefined();
  });

  it('returns undefined for a corrupted stored value', () => {
    expect(readModelMemory(makeMemento({ [MODEL_MEMORY_KEY]: 'garbage' }))).toBeUndefined();
  });

  it('returns undefined (never throws) when the memento throws', () => {
    const memento = {
      get: () => { throw new Error('boom'); },
      update: async () => {},
    } as unknown as MementoLike;
    expect(readModelMemory(memento)).toBeUndefined();
  });

  it('returns undefined when no memento was injected', () => {
    expect(readModelMemory(undefined)).toBeUndefined();
  });

  it('writes under the namespaced key', async () => {
    const memento = makeMemento();
    await writeModelMemory(memento, { provider: 'p', modelId: 'm', thinkingLevel: 'max' });
    expect(memento.update).toHaveBeenCalledWith(MODEL_MEMORY_KEY, {
      provider: 'p', modelId: 'm', thinkingLevel: 'max',
    });
    expect(memento.store[MODEL_MEMORY_KEY]).toEqual({
      provider: 'p', modelId: 'm', thinkingLevel: 'max',
    });
  });

  it('swallows update failures and no-ops without a memento', async () => {
    const failing = {
      get: () => undefined,
      update: async () => { throw new Error('disk full'); },
    } as unknown as MementoLike;
    await expect(writeModelMemory(failing, { provider: 'p' })).resolves.toBeUndefined();
    await expect(writeModelMemory(undefined, { provider: 'p' })).resolves.toBeUndefined();
  });

  it('round-trips through the memento', async () => {
    const memento = makeMemento();
    await writeModelMemory(memento, { provider: 'p', modelId: 'm', thinkingLevel: 'high' });
    expect(readModelMemory(memento)).toEqual({ provider: 'p', modelId: 'm', thinkingLevel: 'high' });
  });
});
