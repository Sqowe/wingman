/**
 * Unit tests for the pure pi CLI-argument helpers:
 *  - normalizeBundledExtensionPaths(): trim, drop empties, normalize, de-dupe.
 *  - buildExtraArgs(): trust flag + optional --session + one -e per extension.
 *
 * Path expectations run through path.normalize()/path.join() so they hold on
 * both POSIX and Windows (where normalize() emits backslash separators).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { normalizeBundledExtensionPaths, buildExtraArgs } from './spawn-args';

// Build an OS-native path from POSIX-style segments, and its normalized form,
// so assertions match whatever separators the current platform produces.
const p = (...segs: string[]) => path.join(...segs);
const extA = p('/ext', 'a', 'index.js');
const extB = p('/ext', 'b', 'index.js');

describe('normalizeBundledExtensionPaths()', () => {
  it('returns an empty list for no input', () => {
    expect(normalizeBundledExtensionPaths([])).toEqual([]);
  });

  it('preserves distinct paths in first-seen order', () => {
    expect(normalizeBundledExtensionPaths([extA, extB])).toEqual([extA, extB]);
  });

  it('trims entries and drops empty/whitespace-only ones', () => {
    expect(normalizeBundledExtensionPaths([`  ${extA}  `, '', '   '])).toEqual([extA]);
  });

  it('de-duplicates exact repeats, keeping the first occurrence', () => {
    expect(normalizeBundledExtensionPaths([extA, extB, extA])).toEqual([extA, extB]);
  });

  it('de-duplicates path variants that normalize to the same file', () => {
    expect(
      normalizeBundledExtensionPaths([extA, p('/ext', 'a', '.', 'index.js'), p('/ext', 'a', '..', 'a', 'index.js')]),
    ).toEqual([extA]);
  });
});

describe('buildExtraArgs()', () => {
  it('emits no -e args when there are no bundled extensions', () => {
    const args = buildExtraArgs({ bundledExtensionPaths: [] });
    expect(args).not.toContain('-e');
    expect(args).toEqual([]);
  });

  it('composes one `-e <path>` pair per extension, in order', () => {
    const args = buildExtraArgs({ bundledExtensionPaths: [extA, extB] });
    expect(args).toEqual(['-e', extA, '-e', extB]);
  });

  it('prepends the trust flag before the -e pairs', () => {
    const args = buildExtraArgs({ trustArg: '--approve', bundledExtensionPaths: [extA] });
    expect(args).toEqual(['--approve', '-e', extA]);
  });

  it('places a --session resume arg before the -e pairs', () => {
    const args = buildExtraArgs({
      resumeSessionPath: '/sessions/s1.jsonl',
      bundledExtensionPaths: [extA],
    });
    expect(args).toEqual(['--session', '/sessions/s1.jsonl', '-e', extA]);
  });

  it('orders trust flag, then --session, then -e pairs', () => {
    const args = buildExtraArgs({
      trustArg: '--no-approve',
      resumeSessionPath: '/sessions/s1.jsonl',
      bundledExtensionPaths: [extA, extB],
    });
    expect(args).toEqual([
      '--no-approve',
      '--session',
      '/sessions/s1.jsonl',
      '-e',
      extA,
      '-e',
      extB,
    ]);
  });
});
