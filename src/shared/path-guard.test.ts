/**
 * Unit tests for the shared path-containment guards used by the memory-dir
 * open/reveal flow (bridge + provider).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isSameDir, isStrictlyWithinDir, isWithinOrEqualDir } from './path-guard';

// Use OS-native paths so assertions hold on both POSIX and Windows.
const p = (...segs: string[]) => path.join(...segs);
const dir = p('/mem');

describe('isSameDir()', () => {
  it('is true for the same dir', () => {
    expect(isSameDir(dir, dir)).toBe(true);
  });

  it('is true after normalization (redundant segments)', () => {
    expect(isSameDir(dir, p('/mem', 'sub', '..'))).toBe(true);
  });

  it('is false for a different dir', () => {
    expect(isSameDir(dir, p('/other'))).toBe(false);
  });

  it('is false for a file inside the dir', () => {
    expect(isSameDir(dir, p('/mem', 'a.md'))).toBe(false);
  });
});

describe('isStrictlyWithinDir()', () => {
  it('is true for a file directly inside', () => {
    expect(isStrictlyWithinDir(dir, p('/mem', 'a.md'))).toBe(true);
  });

  it('is true for a nested file', () => {
    expect(isStrictlyWithinDir(dir, p('/mem', 'sub', 'a.md'))).toBe(true);
  });

  it('is false for the dir itself', () => {
    expect(isStrictlyWithinDir(dir, dir)).toBe(false);
  });

  it('rejects a name-prefix sibling dir', () => {
    expect(isStrictlyWithinDir(dir, p('/mem-evil', 'secret.md'))).toBe(false);
  });

  it('rejects a parent-escape via ..', () => {
    expect(isStrictlyWithinDir(dir, p('/mem', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('rejects a sibling reached via ..', () => {
    expect(isStrictlyWithinDir(dir, p('/other', 'a.md'))).toBe(false);
  });

  it('allows a descendant dir whose name merely starts with ..', () => {
    expect(isStrictlyWithinDir(dir, p('/mem', '..hidden', 'a.md'))).toBe(true);
  });

  it('allows a file whose name merely starts with ..', () => {
    expect(isStrictlyWithinDir(dir, p('/mem', '..notes.md'))).toBe(true);
  });
});

describe('isWithinOrEqualDir()', () => {
  it('is true for the dir itself', () => {
    expect(isWithinOrEqualDir(dir, dir)).toBe(true);
  });

  it('is true for a contained file', () => {
    expect(isWithinOrEqualDir(dir, p('/mem', 'a.md'))).toBe(true);
  });

  it('is false for a name-prefix sibling', () => {
    expect(isWithinOrEqualDir(dir, p('/mem-evil', 'x.md'))).toBe(false);
  });
});
