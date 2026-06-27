/**
 * Unit tests for session-titles — the title index I/O module.
 * Uses a temp directory so no real ~/.pi files are touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  loadTitleIndex,
  getTitle,
  setTitle,
  removeTitle,
  type TitleEntry,
  type TitleIndex,
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

  it('uses a unique temp file name per write (no shared .tmp clobbering)', async () => {
    // Fire two concurrent writes. With a read-modify-write pattern and no lock,
    // the last rename wins — so one entry may overwrite the other. What we
    // guarantee here is: no .tmp files are left behind, no errors are thrown,
    // and the final index is valid (at least one entry present).
    await Promise.all([
      setTitle('uuid-a', { ...sampleEntry(), title: 'Title A' }, indexFile),
      setTitle('uuid-b', { ...sampleEntry(), title: 'Title B' }, indexFile),
    ]);
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const idx = await loadTitleIndex(indexFile);
    // At least one of the two entries must have survived.
    const survived = ['uuid-a', 'uuid-b'].filter((k) => k in idx.titles);
    expect(survived.length).toBeGreaterThanOrEqual(1);
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
