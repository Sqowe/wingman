/**
 * Unit tests for session-titles — the title index I/O module.
 * Uses a temp directory so no real ~/.pi files are touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  loadTitleIndex,
  getTitle,
  setTitle,
  removeTitle,
  planRename,
  applyRenamePlan,
  type TitleEntry,
  type TitleIndex,
  type RenameApplyDeps,
} from './session-titles';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let indexFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wingman-titles-test-'));
  indexFile = path.join(tmpDir, '.wingman-titles.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sampleEntry = (): TitleEntry => ({
  title: 'GitLab → GitHub mirror cleanup',
  source: 'manual',
  generatedAt: '2026-06-27T13:20:00.000Z',
});

async function writeIndex(data: unknown): Promise<void> {
  await fs.writeFile(indexFile, JSON.stringify(data), 'utf-8');
}

// ---------------------------------------------------------------------------
// loadTitleIndex
// ---------------------------------------------------------------------------

describe('loadTitleIndex', () => {
  it('returns an empty index when the file does not exist', async () => {
    const idx = await loadTitleIndex(indexFile);
    expect(idx).toEqual({ version: 1, titles: {} });
  });

  it('returns an empty index for corrupt JSON', async () => {
    await fs.writeFile(indexFile, '{not valid json', 'utf-8');
    const idx = await loadTitleIndex(indexFile);
    expect(idx).toEqual({ version: 1, titles: {} });
  });

  it('returns an empty index when version is wrong', async () => {
    await writeIndex({ version: 99, titles: {} });
    expect(await loadTitleIndex(indexFile)).toEqual({ version: 1, titles: {} });
  });

  it('returns an empty index when titles field is missing', async () => {
    await writeIndex({ version: 1 });
    expect(await loadTitleIndex(indexFile)).toEqual({ version: 1, titles: {} });
  });

  it('loads a valid index file correctly', async () => {
    const data: TitleIndex = {
      version: 1,
      titles: {
        'uuid-1': sampleEntry(),
      },
    };
    await writeIndex(data);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.version).toBe(1);
    expect(idx.titles['uuid-1']?.title).toBe('GitLab → GitHub mirror cleanup');
  });

  it('strips prototype-pollution keys and malformed entries', async () => {
    await writeIndex({
      version: 1,
      titles: {
        '__proto__': sampleEntry(),
        'constructor': sampleEntry(),
        'valid-uuid': sampleEntry(),
        'bad-entry': { title: 123, source: 'manual', generatedAt: 'x' }, // title not string
        'bad-source': { title: 'ok', source: 'unknown', generatedAt: 'x' }, // invalid source
      },
    });
    const idx = await loadTitleIndex(indexFile);
    expect('__proto__' in idx.titles).toBe(false);
    expect('constructor' in idx.titles).toBe(false);
    expect('bad-entry' in idx.titles).toBe(false);
    expect('bad-source' in idx.titles).toBe(false);
    expect(idx.titles['valid-uuid']?.title).toBe('GitLab → GitHub mirror cleanup');
  });
});

// ---------------------------------------------------------------------------
// getTitle
// ---------------------------------------------------------------------------

describe('getTitle', () => {
  it('returns the entry for a known session id', async () => {
    const data: TitleIndex = { version: 1, titles: { 'abc': sampleEntry() } };
    await writeIndex(data);
    const idx = await loadTitleIndex(indexFile);
    expect(getTitle(idx, 'abc')?.title).toBe('GitLab → GitHub mirror cleanup');
  });

  it('returns undefined for an unknown session id', async () => {
    const idx = await loadTitleIndex(indexFile);
    expect(getTitle(idx, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setTitle
// ---------------------------------------------------------------------------

describe('setTitle', () => {
  it('creates the index file if it does not exist', async () => {
    await setTitle('uuid-new', sampleEntry(), indexFile);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.titles['uuid-new']?.title).toBe('GitLab → GitHub mirror cleanup');
  });

  it('silently ignores dangerous sessionId keys', async () => {
    await setTitle('__proto__', sampleEntry(), indexFile);
    await setTitle('constructor', sampleEntry(), indexFile);
    await setTitle('prototype', sampleEntry(), indexFile);
    // File should not have been written (or if it was, prototype keys are absent).
    const idx = await loadTitleIndex(indexFile);
    expect('__proto__' in idx.titles).toBe(false);
    expect('constructor' in idx.titles).toBe(false);
    expect('prototype' in idx.titles).toBe(false);
  });

  it('adds a new entry without removing existing ones', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    await setTitle('uuid-2', { ...sampleEntry(), title: 'Second title' }, indexFile);
    const idx = await loadTitleIndex(indexFile);
    expect(Object.keys(idx.titles)).toHaveLength(2);
    expect(idx.titles['uuid-1']?.title).toBe('GitLab → GitHub mirror cleanup');
    expect(idx.titles['uuid-2']?.title).toBe('Second title');
  });

  it('overwrites an existing entry for the same id', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    await setTitle('uuid-1', { ...sampleEntry(), title: 'Updated title' }, indexFile);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.titles['uuid-1']?.title).toBe('Updated title');
    expect(Object.keys(idx.titles)).toHaveLength(1);
  });

  it('writes valid JSON that round-trips cleanly', async () => {
    await setTitle('uuid-rt', sampleEntry(), indexFile);
    const raw = await fs.readFile(indexFile, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('does not leave a .tmp file after a successful write', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('creates parent directories that do not exist yet', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', '.wingman-titles.json');
    await setTitle('uuid-deep', sampleEntry(), nested);
    const idx = await loadTitleIndex(nested);
    expect(idx.titles['uuid-deep']?.title).toBe('GitLab → GitHub mirror cleanup');
  });

  it('overwrites an existing index file atomically (no .tmp left behind)', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    await setTitle('uuid-1', { ...sampleEntry(), title: 'New title' }, indexFile);
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.titles['uuid-1']?.title).toBe('New title');
  });

  it('serializes concurrent writes so both updates persist (no lost updates)', async () => {
    // In-process serialization (writeQueues) guarantees both writes land,
    // even though each is a read-modify-write. Atomic temp naming still leaves
    // no .tmp behind.
    await Promise.all([
      setTitle('uuid-a', { ...sampleEntry(), title: 'Title A' }, indexFile),
      setTitle('uuid-b', { ...sampleEntry(), title: 'Title B' }, indexFile),
    ]);
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.titles['uuid-a']?.title).toBe('Title A');
    expect(idx.titles['uuid-b']?.title).toBe('Title B');
  });

  it('serializes many concurrent writes + removes to the same index file', async () => {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writes.push(
        setTitle(`uuid-${i}`, { ...sampleEntry(), title: `Title ${i}` }, indexFile),
      );
    }
    // Interleave a set-then-remove on the same key; serialization preserves
    // submission order so the net effect is "removed".
    writes.push(setTitle('uuid-r1', sampleEntry(), indexFile));
    writes.push(removeTitle('uuid-r1', indexFile));
    await Promise.all(writes);
    const idx = await loadTitleIndex(indexFile);
    for (let i = 0; i < 10; i++) {
      expect(idx.titles[`uuid-${i}`]?.title).toBe(`Title ${i}`);
    }
    expect(idx.titles['uuid-r1']).toBeUndefined();
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeTitle
// ---------------------------------------------------------------------------

describe('removeTitle', () => {
  it('removes an existing entry', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    await removeTitle('uuid-1', indexFile);
    const idx = await loadTitleIndex(indexFile);
    expect(idx.titles['uuid-1']).toBeUndefined();
  });

  it('is a no-op when the entry does not exist', async () => {
    await setTitle('uuid-1', sampleEntry(), indexFile);
    await removeTitle('uuid-nonexistent', indexFile);
    const idx = await loadTitleIndex(indexFile);
    expect(Object.keys(idx.titles)).toHaveLength(1);
  });

  it('is a no-op when the file does not exist at all', async () => {
    await expect(removeTitle('uuid-x', indexFile)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planRename (Phase 1.5)
// ---------------------------------------------------------------------------

describe('planRename', () => {
  // Fixed injected timestamp so the expected `set` entry is deterministic.
  const fixedNow = () => '2026-06-28T10:00:00.000Z';
  // A current title that differs from the set-test inputs, so those cases
  // are not mistaken for "unchanged".
  const CURRENT = 'Original Title';

  it('returns noop when the input is undefined (cancelled)', () => {
    expect(planRename(undefined, CURRENT, fixedNow)).toEqual({ kind: 'noop' });
  });

  it('returns reset when the input is the empty string', () => {
    expect(planRename('', CURRENT, fixedNow)).toEqual({ kind: 'reset' });
  });

  it('returns reset when the input is whitespace-only', () => {
    expect(planRename('   \t\n  ', CURRENT, fixedNow)).toEqual({ kind: 'reset' });
  });

  it('returns a manual set entry for normal text', () => {
    const plan = planRename('Mirror repo to GitHub', CURRENT, fixedNow);
    expect(plan).toEqual({
      kind: 'set',
      entry: {
        title: 'Mirror repo to GitHub',
        source: 'manual',
        generatedAt: '2026-06-28T10:00:00.000Z',
      },
    });
  });

  it('collapses multi-line / padded input to a single line', () => {
    const plan = planRename('  lots\n   of\t  whitespace  ', CURRENT, fixedNow);
    expect(plan).toEqual({
      kind: 'set',
      entry: {
        title: 'lots of whitespace',
        source: 'manual',
        generatedAt: '2026-06-28T10:00:00.000Z',
      },
    });
  });

  it('does NOT truncate long titles (manual titles are kept verbatim)', () => {
    const long = 'a'.repeat(200); // well past the 60-char derived-title cap
    const plan = planRename(long, CURRENT, fixedNow);
    expect(plan.kind).toBe('set');
    if (plan.kind !== 'set') return;
    expect(plan.entry.title).toBe(long); // full length, no ellipsis
  });

  it('does not set `model` or `sourceMsgCount` on manual entries', () => {
    const plan = planRename('some title', CURRENT, fixedNow);
    expect(plan.kind).toBe('set');
    if (plan.kind !== 'set') return;
    expect(plan.entry).not.toHaveProperty('model');
    expect(plan.entry).not.toHaveProperty('sourceMsgCount');
  });

  it('uses the injected `now` for generatedAt', () => {
    const ts = '2099-01-02T03:04:05.678Z';
    const plan = planRename('x', CURRENT, () => ts);
    expect(plan.kind).toBe('set');
    if (plan.kind !== 'set') return;
    expect(plan.entry.generatedAt).toBe(ts);
  });

  it('collapses leading/trailing whitespace before the empty check', () => {
    // '   x   ' collapses to 'x' → set, not reset.
    const plan = planRename('   x   ', CURRENT, fixedNow);
    expect(plan.kind).toBe('set');
    if (plan.kind !== 'set') return;
    expect(plan.entry.title).toBe('x');
  });

  it('returns noop when the input is unchanged (accepted verbatim)', () => {
    // Prefilled title submitted without edits must not pin a derived title
    // as a manual override.
    expect(planRename('Same Title', 'Same Title', fixedNow)).toEqual({
      kind: 'noop',
    });
  });

  it('returns noop when input differs from current only by whitespace', () => {
    // Collapsed forms match → no-op (no redundant write).
    expect(planRename('  Same   Title  ', 'Same Title', fixedNow)).toEqual({
      kind: 'noop',
    });
  });
});

// ---------------------------------------------------------------------------
// applyRenamePlan (Phase 1.5 — command wiring orchestration)
// ---------------------------------------------------------------------------

describe('applyRenamePlan', () => {
  /** Build injectable deps with mock persistence + callbacks. */
  const mockDeps = (overrides: Partial<RenameApplyDeps> = {}): RenameApplyDeps => ({
    setTitle: vi.fn().mockResolvedValue(undefined),
    removeTitle: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  });

  it('does nothing for a noop plan', async () => {
    const deps = mockDeps();
    await applyRenamePlan({ kind: 'noop' }, 'sid', deps);
    expect(deps.setTitle).not.toHaveBeenCalled();
    expect(deps.removeTitle).not.toHaveBeenCalled();
    expect(deps.onChanged).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('calls setTitle (with id + entry) and onChanged for a set plan', async () => {
    const deps = mockDeps();
    const entry: TitleEntry = {
      title: 'New Title',
      source: 'manual',
      generatedAt: '2026-06-28T10:00:00.000Z',
    };
    await applyRenamePlan({ kind: 'set', entry }, 'sid', deps);
    expect(deps.setTitle).toHaveBeenCalledWith('sid', entry);
    expect(deps.removeTitle).not.toHaveBeenCalled();
    expect(deps.onChanged).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('calls removeTitle (with id) and onChanged for a reset plan', async () => {
    const deps = mockDeps();
    await applyRenamePlan({ kind: 'reset' }, 'sid', deps);
    expect(deps.removeTitle).toHaveBeenCalledWith('sid');
    expect(deps.setTitle).not.toHaveBeenCalled();
    expect(deps.onChanged).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('reports an error and skips onChanged when setTitle throws', async () => {
    const deps = mockDeps({
      setTitle: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    await applyRenamePlan(
      { kind: 'set', entry: { title: 'x', source: 'manual', generatedAt: 't' } },
      'sid',
      deps,
    );
    expect(deps.onError).toHaveBeenCalledTimes(1);
    expect(deps.onError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to rename session'),
    );
    expect(deps.onError).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  it('reports an error and skips onChanged when removeTitle throws', async () => {
    const deps = mockDeps({
      removeTitle: vi.fn().mockRejectedValue(new Error('locked')),
    });
    await applyRenamePlan({ kind: 'reset' }, 'sid', deps);
    expect(deps.onError).toHaveBeenCalledTimes(1);
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  it('reports a refresh error (not a rename failure) when onChanged throws after a successful set', async () => {
    // The rename was saved, so a refresh failure must be reported as a
    // refresh problem — never as a rename failure (HIGH bug regression guard).
    const deps = mockDeps({
      onChanged: vi.fn().mockImplementation(() => {
        throw new Error('refresh boom');
      }),
    });
    await applyRenamePlan(
      { kind: 'set', entry: { title: 'x', source: 'manual', generatedAt: 't' } },
      'sid',
      deps,
    );
    // Persistence happened (rename was saved)...
    expect(deps.setTitle).toHaveBeenCalledTimes(1);
    // ...reported as a refresh failure, with the underlying message, and NOT
    // mislabelled as a rename failure.
    expect(deps.onError).toHaveBeenCalledTimes(1);
    expect(deps.onError).toHaveBeenCalledWith(
      expect.stringContaining('could not be refreshed'),
    );
    expect(deps.onError).toHaveBeenCalledWith(
      expect.stringContaining('refresh boom'),
    );
    expect(deps.onError).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to rename session'),
    );
  });
});
