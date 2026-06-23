/**
 * Unit tests for normalizeModels — the defensive parser for pi's
 * get_available_models payload (shape is not contractually fixed across
 * pi versions, so the picker must tolerate several variants).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const mod = await import('../__mocks__/vscode');
  return mod;
});

import { normalizeModels } from './model-picker';

describe('normalizeModels', () => {
  it('reads the canonical { models: [{ id, name }] } shape', () => {
    expect(
      normalizeModels({ models: [{ id: 'gpt-x', name: 'GPT X' }] }),
    ).toEqual([{ id: 'gpt-x', name: 'GPT X' }]);
  });

  it('accepts a bare array', () => {
    expect(normalizeModels([{ id: 'a' }, { id: 'b' }])).toEqual([
      { id: 'a', name: undefined },
      { id: 'b', name: undefined },
    ]);
  });

  it('accepts a { data: [...] } envelope', () => {
    expect(normalizeModels({ data: [{ id: 'm1' }] })).toEqual([
      { id: 'm1', name: undefined },
    ]);
  });

  it('accepts arrays of plain strings', () => {
    expect(normalizeModels(['claude', 'gpt'])).toEqual([
      { id: 'claude' },
      { id: 'gpt' },
    ]);
  });

  it('falls back across id / model / name keys', () => {
    expect(
      normalizeModels({ models: [{ model: 'via-model' }, { name: 'via-name' }] }),
    ).toEqual([
      { id: 'via-model', name: undefined },
      { id: 'via-name', name: undefined },
    ]);
  });

  it('uses label as the display name when present', () => {
    expect(
      normalizeModels({ models: [{ id: 'x', label: 'Pretty X' }] }),
    ).toEqual([{ id: 'x', name: 'Pretty X' }]);
  });

  it('does not duplicate id into name when they are equal', () => {
    expect(normalizeModels({ models: [{ id: 'same', name: 'same' }] })).toEqual([
      { id: 'same', name: undefined },
    ]);
  });

  it('skips entries with no usable id and empty strings', () => {
    expect(
      normalizeModels({ models: [{ description: 'no id' }, '', null, 42, { id: 'ok' }] }),
    ).toEqual([{ id: 'ok', name: undefined }]);
  });

  it('returns an empty array for unrecognised shapes', () => {
    expect(normalizeModels(null)).toEqual([]);
    expect(normalizeModels(undefined)).toEqual([]);
    expect(normalizeModels({ foo: 'bar' })).toEqual([]);
    expect(normalizeModels('nope')).toEqual([]);
  });
});
