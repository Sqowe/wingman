/**
 * Pure helpers for composing the pi child-process CLI arguments.
 *
 * Kept as standalone, side-effect-free functions (not AgentController methods)
 * so they can be unit-tested directly without spawning a process, mocking the
 * transport, or reaching into private class internals.
 */

import * as path from 'path';

/**
 * Normalize and de-duplicate bundled extension paths.
 *
 * - Trims each entry and drops empty/whitespace-only ones (a `-e ''` arg would
 *   fail pi startup in a hard-to-diagnose way).
 * - Normalizes each path (collapses `.`/`..`/redundant separators) so trivial
 *   path variants of the same file de-duplicate, and lowercases on Windows
 *   (case-insensitive by default) for the uniqueness comparison. macOS is left
 *   case-sensitive here because APFS/HFS+ volumes can be either; a false
 *   de-dupe there could silently drop a distinct extension, so we don't risk it.
 * - Preserves first-seen order and returns the normalized (not lowercased)
 *   paths — lowercasing is only used as the de-dupe key.
 */
export function normalizeBundledExtensionPaths(paths: readonly string[]): string[] {
  const caseInsensitive = process.platform === 'win32';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const normalized = path.normalize(trimmed);
    const key = caseInsensitive ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * Compose the extra CLI args passed to the pi child process on spawn:
 * the trust flag, an optional `--session` resume, then one `-e <path>` pair per
 * (already normalized/de-duplicated) bundled extension.
 */
export function buildExtraArgs(opts: {
  trustArg?: string;
  resumeSessionPath?: string;
  bundledExtensionPaths: readonly string[];
}): string[] {
  return [
    ...(opts.trustArg ? [opts.trustArg] : []),
    ...(opts.resumeSessionPath ? ['--session', opts.resumeSessionPath] : []),
    ...opts.bundledExtensionPaths.flatMap((p) => ['-e', p]),
  ];
}
