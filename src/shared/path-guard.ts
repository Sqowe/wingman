/**
 * Path-containment helpers shared by the UI protocol bridge and the webview
 * provider, so both enforce the Claude Code memory dir guard identically.
 *
 * Cross-platform: on win32 the filesystem is case-insensitive, so comparisons
 * are lowercased there. Uses `path.relative` (not string prefixes) so a sibling
 * dir sharing a name prefix (e.g. `/mem-evil` vs `/mem`) cannot slip through.
 */

import * as path from 'path';

/** Lowercase on win32 (case-insensitive FS); leave untouched elsewhere. */
function caseFold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * True if `target` resolves to exactly `dir`. Both are `path.resolve`d and
 * case-folded per platform. Callers should pass already-resolved paths for
 * realpath (symlink-safe) semantics; this only handles resolution + casing.
 */
export function isSameDir(dir: string, target: string): boolean {
  return caseFold(path.resolve(dir)) === caseFold(path.resolve(target));
}

/**
 * True if `target` is strictly contained within `dir` (a descendant, not the
 * dir itself). Uses `path.relative` so name-prefix siblings are rejected.
 */
export function isStrictlyWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (rel === '' || rel === '.') return false; // the dir itself, not within
  // Escape only when the FIRST path segment is exactly '..' (parent traversal)
  // or the relative path is absolute (different root/drive). A descendant whose
  // name merely starts with '..' (e.g. '..hidden', '..notes.md') is legitimate.
  const folded = caseFold(rel);
  if (folded === '..' || folded.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(rel);
}

/**
 * True if `target` is `dir` itself OR strictly contained within it. Used for
 * "open a file inside the memory dir" (files) and the dir-equality path (folder).
 */
export function isWithinOrEqualDir(dir: string, target: string): boolean {
  return isSameDir(dir, target) || isStrictlyWithinDir(dir, target);
}
