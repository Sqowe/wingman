/**
 * Unit tests for the model-picker pure helpers: normalizeModels (defensive
 * parser for pi's get_available_models payload), and the shortlist plumbing
 * that scopes the picker to settings.json `enabledModels` and resolves each
 * pick to the `{ provider, modelId }` pair set_model requires.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const mod = await import('../__mocks__/vscode');
  return mod;
});

import {
  normalizeModels,
  parseEnabledModels,
  splitModelRef,
  buildShortlistItems,
  buildCatalogItems,
  readCycledModelRef,
} from './model-picker';

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

  it('captures the provider from a full Model object', () => {
    expect(
      normalizeModels({ models: [{ id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }] }),
    ).toEqual([{ id: 'deepseek/deepseek-v4-pro', name: undefined, provider: 'openrouter' }]);
  });
});

describe('parseEnabledModels', () => {
  it('reads the enabledModels array of refs', () => {
    const settings = { enabledModels: ['openrouter/tencent/hy3-preview', 'local-claude/claude-sonnet-4.6'] };
    expect(parseEnabledModels(settings)).toEqual([
      'openrouter/tencent/hy3-preview',
      'local-claude/claude-sonnet-4.6',
    ]);
  });

  it('drops non-string / empty entries', () => {
    expect(parseEnabledModels({ enabledModels: ['ok', '', 1, null, 'two'] })).toEqual(['ok', 'two']);
  });

  it('returns [] when the setting is missing or malformed', () => {
    expect(parseEnabledModels({})).toEqual([]);
    expect(parseEnabledModels(null)).toEqual([]);
    expect(parseEnabledModels({ enabledModels: 'nope' })).toEqual([]);
  });
});

describe('splitModelRef', () => {
  it('splits on the first slash, keeping slashes in the model id', () => {
    expect(splitModelRef('openrouter/deepseek/deepseek-v4-pro')).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-pro',
    });
    expect(splitModelRef('local-claude/claude-sonnet-4.6')).toEqual({
      provider: 'local-claude',
      modelId: 'claude-sonnet-4.6',
    });
  });

  it('yields an empty provider when there is no slash', () => {
    expect(splitModelRef('bare')).toEqual({ provider: '', modelId: 'bare' });
  });
});

describe('buildShortlistItems', () => {
  const catalog = [
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'openrouter' },
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Local)', provider: 'local-claude' },
  ];

  it('resolves provider/modelId and enriches labels from the catalog', () => {
    const items = buildShortlistItems(
      ['openrouter/deepseek/deepseek-v4-pro', 'local-claude/claude-sonnet-4.6'],
      catalog,
    );
    expect(items).toEqual([
      { label: 'DeepSeek V4 Pro', description: 'openrouter/deepseek/deepseek-v4-pro', provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' },
      { label: 'Claude Sonnet 4.6 (Local)', description: 'local-claude/claude-sonnet-4.6', provider: 'local-claude', modelId: 'claude-sonnet-4.6' },
    ]);
  });

  it('keeps a shortlisted model that is absent from the catalog, labelled by its ref', () => {
    const [item] = buildShortlistItems(['openrouter/tencent/hy3-preview'], catalog);
    expect(item).toEqual({
      label: 'openrouter/tencent/hy3-preview',
      description: undefined,
      provider: 'openrouter',
      modelId: 'tencent/hy3-preview',
    });
  });
});

describe('buildCatalogItems', () => {
  it('uses the Model provider/id directly when provider is present', () => {
    expect(buildCatalogItems([{ id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', provider: 'openrouter' }])).toEqual([
      { label: 'Claude Opus 4.8', description: 'anthropic/claude-opus-4.8', provider: 'openrouter', modelId: 'anthropic/claude-opus-4.8' },
    ]);
  });

  it('splits the id when no provider field is present', () => {
    expect(buildCatalogItems([{ id: 'openrouter/foo/bar' }])).toEqual([
      { label: 'openrouter/foo/bar', description: undefined, provider: 'openrouter', modelId: 'foo/bar' },
    ]);
  });
});

// ─── readCycledModelRef ──────────────────────────────────────────────────────
//
// pi's cycleModel answers `{ model: <Model>, thinkingLevel, isScoped }` — the
// `model` field is an object, which the string-only readCurrentModel cannot
// see. readCycledModelRef exists so the cycled-to model can be remembered for
// the next new_session (pi's RPC cannot persist it — see agent/model-memory.ts).

describe('readCycledModelRef', () => {
  it('reads the canonical nested { model: { provider, id } } shape', () => {
    expect(readCycledModelRef({
      model: { id: 'claude-opus-5', provider: 'local-claude' },
      thinkingLevel: 'high',
      isScoped: true,
    })).toEqual({ provider: 'local-claude', modelId: 'claude-opus-5' });
  });

  it('reads a flat { provider, modelId } shape', () => {
    expect(readCycledModelRef({ provider: 'p', modelId: 'm' }))
      .toEqual({ provider: 'p', modelId: 'm' });
  });

  it('reads a flat { provider, id } shape', () => {
    expect(readCycledModelRef({ provider: 'p', id: 'm' }))
      .toEqual({ provider: 'p', modelId: 'm' });
  });

  it('returns undefined when the provider is missing (set_model needs both)', () => {
    expect(readCycledModelRef({ model: { id: 'm' } })).toBeUndefined();
    expect(readCycledModelRef({ id: 'm' })).toBeUndefined();
  });

  it('returns undefined when the id is missing', () => {
    expect(readCycledModelRef({ model: { provider: 'p' } })).toBeUndefined();
  });

  it('returns undefined for a null / non-object payload (cycle past the end)', () => {
    expect(readCycledModelRef(null)).toBeUndefined();
    expect(readCycledModelRef(undefined)).toBeUndefined();
    expect(readCycledModelRef('nope')).toBeUndefined();
  });

  it('returns undefined when the model field is a bare string', () => {
    // readCurrentModel's shape — usable for the message, but not for set_model.
    expect(readCycledModelRef({ model: 'some-model' })).toBeUndefined();
  });
});
