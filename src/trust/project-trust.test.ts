/**
 * Unit tests for src/trust/project-trust.ts
 * Pure filesystem helpers — no vscode dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  hasProjectResources,
  readTrustJson,
  saveTrustDecision,
  lookupTrustDecision,
  evaluateTrust,
  type TrustMap,
} from './project-trust';

// ─── hasProjectResources ──────────────────────────────────────────────────────

describe('hasProjectResources', () => {
  // Use a platform-safe root derived from tmpdir so path separators are correct
  // on all OSes.  The fsStat stub never touches the real filesystem.
  const root = path.parse(os.tmpdir()).root; // '/' on POSIX, 'C:\\' on Windows
  const proj = path.join(root, 'proj');
  const piDir = path.join(proj, '.pi');

  const makeStat = (dirs: string[], files: string[]) =>
    (p: string): fs.Stats | null => {
      if (dirs.includes(p)) return { isDirectory: () => true } as fs.Stats;
      if (files.includes(p)) return { isDirectory: () => false } as fs.Stats;
      return null;
    };

  it('returns false when .pi/ does not exist', () => {
    expect(hasProjectResources(proj, makeStat([], []))).toBe(false);
  });

  it('returns false for a bare .pi/ directory (no trust-gated files)', () => {
    expect(hasProjectResources(proj, makeStat([piDir], []))).toBe(false);
  });

  it('detects .pi/settings.json', () => {
    expect(
      hasProjectResources(proj, makeStat([piDir], [path.join(piDir, 'settings.json')])),
    ).toBe(true);
  });

  it('detects .pi/SYSTEM.md', () => {
    expect(
      hasProjectResources(proj, makeStat([piDir], [path.join(piDir, 'SYSTEM.md')])),
    ).toBe(true);
  });

  it('detects .pi/APPEND_SYSTEM.md', () => {
    expect(
      hasProjectResources(proj, makeStat([piDir], [path.join(piDir, 'APPEND_SYSTEM.md')])),
    ).toBe(true);
  });

  it.each(['extensions', 'skills', 'prompts', 'themes'])(
    'detects .pi/%s directory',
    (dir) => {
      expect(
        hasProjectResources(proj, makeStat([piDir, path.join(piDir, dir)], [])),
      ).toBe(true);
    },
  );

  it('detects .agents/skills in the project folder itself', () => {
    expect(
      hasProjectResources(proj, makeStat([path.join(proj, '.agents', 'skills')], [])),
    ).toBe(true);
  });

  it('detects .agents/skills in a parent directory', () => {
    const parent = path.join(root, 'parent');
    const child  = path.join(parent, 'child');
    const dirs = [path.join(parent, '.agents', 'skills')];
    expect(hasProjectResources(child, makeStat(dirs, []))).toBe(true);
  });

  it('returns false when .agents/skills is a file, not a directory', () => {
    const fsStat = (p: string): fs.Stats | null => {
      if (p === path.join(proj, '.agents', 'skills')) return { isDirectory: () => false } as fs.Stats;
      return null;
    };
    expect(hasProjectResources(proj, fsStat)).toBe(false);
  });
});

// ─── readTrustJson ────────────────────────────────────────────────────────────

describe('readTrustJson', () => {
  it('returns an empty map when the file does not exist', () => {
    const p = path.join(os.tmpdir(), `trust-nonexistent-${Date.now()}.json`);
    expect(readTrustJson(p)).toEqual({});
  });

  it('returns an empty map for malformed JSON', () => {
    const p = path.join(os.tmpdir(), `trust-bad-${Date.now()}.json`);
    fs.writeFileSync(p, '{not valid json}', 'utf8');
    expect(readTrustJson(p)).toEqual({});
    fs.unlinkSync(p);
  });

  it('parses a valid trust.json', () => {
    const p = path.join(os.tmpdir(), `trust-valid-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ '/proj': true, '/other': false }), 'utf8');
    expect(readTrustJson(p)).toEqual({ '/proj': true, '/other': false });
    fs.unlinkSync(p);
  });

  it('strips non-boolean values', () => {
    const p = path.join(os.tmpdir(), `trust-mixed-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ '/proj': true, '/bad': 'yes', '/num': 1 }), 'utf8');
    const result = readTrustJson(p);
    expect(result).toEqual({ '/proj': true });
    fs.unlinkSync(p);
  });
});

// ─── saveTrustDecision ────────────────────────────────────────────────────────

describe('saveTrustDecision', () => {
  it('creates the file if it does not exist', () => {
    const p = path.join(os.tmpdir(), `trust-save-new-${Date.now()}.json`);
    saveTrustDecision('/my/project', true, p);
    const map = readTrustJson(p);
    // The key is the realpath of /my/project (may differ on CI)
    const hasEntry = Object.values(map).some((v) => v === true);
    expect(hasEntry).toBe(true);
    fs.unlinkSync(p);
  });

  it('merges with existing entries', () => {
    const p = path.join(os.tmpdir(), `trust-save-merge-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ '/other': false }), 'utf8');
    // Use a real existing path so realpath succeeds
    const folder = os.tmpdir();
    const canonical = fs.realpathSync(folder);
    saveTrustDecision(folder, true, p);
    const map = readTrustJson(p);
    expect(map['/other']).toBe(false);
    // The canonical tmpdir entry should be true
    expect(map[canonical]).toBe(true);
    fs.unlinkSync(p);
  });

  it('overwrites an existing decision for the same folder', () => {
    const p = path.join(os.tmpdir(), `trust-save-overwrite-${Date.now()}.json`);
    const folder = os.tmpdir();
    saveTrustDecision(folder, false, p);
    saveTrustDecision(folder, true, p);
    const map = readTrustJson(p);
    // canonical of tmpdir → should be true after overwrite
    const val = Object.entries(map).find(([k]) => k === fs.realpathSync(folder))?.[1];
    expect(val).toBe(true);
    fs.unlinkSync(p);
  });
});

// ─── lookupTrustDecision ──────────────────────────────────────────────────────

describe('lookupTrustDecision', () => {
  // Build paths from the fs root so separators are correct on all platforms.
  const root = path.parse(os.tmpdir()).root;
  const parent = path.join(root, 'parent');
  const childOther = path.join(root, 'parent', 'child', 'other');
  const unrelated = path.join(root, 'unrelated');

  const map: TrustMap = {
    [parent]: true,
    [childOther]: false,
  };

  it('returns exact match', () => {
    // parent is not on disk — realpathSync falls back to raw string,
    // which matches the map key exactly.
    expect(lookupTrustDecision(parent, map)).toBe(true);
  });

  it('returns ancestor match when no exact match exists', () => {
    // Use os.tmpdir() (a real, resolvable path) as the parent so
    // realpathSync returns the canonical form which we use as the map key.
    const realParent = fs.realpathSync(os.tmpdir());
    const child = path.join(realParent, 'some-sub');
    const m: TrustMap = { [realParent]: true };
    // child does not exist on disk — realpathSync falls back to raw string,
    // then the walk reaches realParent which IS in the map.
    expect(lookupTrustDecision(child, m)).toBe(true);
  });

  it('returns null when no decision is found', () => {
    expect(lookupTrustDecision(unrelated, map)).toBeNull();
  });

  it('returns the closest (most specific) match', () => {
    // Use the canonical tmpdir as the base so realpathSync resolves correctly.
    const base = fs.realpathSync(os.tmpdir());
    const closer = path.join(base, 'closer');
    // base → true, closer → false. A path under closer should hit closer
    // (false), not base (true), because closer is the nearest ancestor.
    const m: TrustMap = { [base]: true, [closer]: false };
    const deeper = path.join(closer, 'deep', 'nested');
    // realpathSync on non-existent deeper falls back to the raw string;
    // the walk: deeper → .../deep → closer (first hit → false).
    expect(lookupTrustDecision(deeper, m)).toBe(false);
  });
});

// ─── evaluateTrust ────────────────────────────────────────────────────────────

describe('evaluateTrust', () => {
  const noResources = (_p: string): fs.Stats | null => null;
  const withSettings = (folderPath: string) =>
    (p: string): fs.Stats | null => {
      if (p === path.join(folderPath, '.pi')) return { isDirectory: () => true } as fs.Stats;
      if (p === path.join(folderPath, '.pi', 'settings.json')) return { isDirectory: () => false } as fs.Stats;
      return null;
    };

  it('returns no-resources when no .pi/ resources are found', () => {
    const result = evaluateTrust('/proj', { fsStat: noResources });
    expect(result.kind).toBe('no-resources');
  });

  it('returns needs-prompt when resources exist but no saved decision', () => {
    const p = path.join(os.tmpdir(), `trust-eval-empty-${Date.now()}.json`);
    // Empty trust.json
    fs.writeFileSync(p, '{}', 'utf8');
    const result = evaluateTrust('/proj', {
      fsStat: withSettings('/proj'),
      trustJsonPath: p,
    });
    expect(result.kind).toBe('needs-prompt');
    fs.unlinkSync(p);
  });

  it('returns saved:true when a trust decision exists', () => {
    const p = path.join(os.tmpdir(), `trust-eval-saved-${Date.now()}.json`);
    // Use a real folder so realpath works
    const folder = os.tmpdir();
    const canonical = fs.realpathSync(folder);
    fs.writeFileSync(p, JSON.stringify({ [canonical]: true }), 'utf8');
    const result = evaluateTrust(folder, {
      fsStat: withSettings(folder),
      trustJsonPath: p,
    });
    expect(result).toEqual({ kind: 'saved', trusted: true });
    fs.unlinkSync(p);
  });

  it('returns saved:false when an untrusted decision exists', () => {
    const p = path.join(os.tmpdir(), `trust-eval-denied-${Date.now()}.json`);
    const folder = os.tmpdir();
    const canonical = fs.realpathSync(folder);
    fs.writeFileSync(p, JSON.stringify({ [canonical]: false }), 'utf8');
    const result = evaluateTrust(folder, {
      fsStat: withSettings(folder),
      trustJsonPath: p,
    });
    expect(result).toEqual({ kind: 'saved', trusted: false });
    fs.unlinkSync(p);
  });
});
