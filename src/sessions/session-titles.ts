/**
 * session-titles — Phase-1 title index for Sqowe Wingman.
 *
 * Manages ~/.pi/agent/sessions/.wingman-titles.json, a single JSON file keyed
 * by session UUID that stores override titles (source: "llm" | "manual").
 *
 * Phase 1 ships the reader + schema; the writer is used by future rename /
 * LLM-title features. Atomic writes (temp file + rename) prevent partial
 * file corruption from concurrent VS Code windows.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface TitleEntry {
  /** The stored title string. */
  title: string;
  /** How this title was produced. */
  source: 'llm' | 'manual';
  /** Model that generated the title (omitted for manual). */
  model?: string;
  /** ISO-8601 timestamp of generation / last update. */
  generatedAt: string;
  /** Message count in the session at generation time (staleness hook). */
  sourceMsgCount?: number;
}

export interface TitleIndex {
  version: 1;
  titles: Record<string, TitleEntry>; // keyed by session UUID
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, '.wingman-titles.json');

/** Exposed for tests — allows overriding the resolved path. */
export function indexFilePath(): string {
  return INDEX_FILE;
}

/** Return the path of the title index for a given sessions directory. */
export function titleIndexPath(sessionsDir: string): string {
  return path.join(sessionsDir, '.wingman-titles.json');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load the title index from disk. Returns an empty index on any error
 * (missing file, corrupt JSON, wrong schema) — never throws.
 * Validates entry shapes and builds a clean object to prevent prototype pollution.
 */
export async function loadTitleIndex(filePath = INDEX_FILE): Promise<TitleIndex> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TitleIndex>;
    if (parsed.version !== 1 || typeof parsed.titles !== 'object' || !parsed.titles || Array.isArray(parsed.titles)) {
      return emptyIndex();
    }
    // Build a clean null-prototype map to avoid prototype pollution.
    // We only access parsed.titles via Object.entries() — never directly —
    // so any __proto__ key in the JSON cannot mutate Object.prototype here.
    const titles: Record<string, TitleEntry> = Object.create(null);
    for (const [key, entry] of Object.entries(parsed.titles)) {
      if (
        key === '__proto__' || key === 'constructor' || key === 'prototype'
      ) {
        continue; // skip dangerous keys
      }
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).title === 'string' &&
        ((entry as Record<string, unknown>).source === 'llm' ||
          (entry as Record<string, unknown>).source === 'manual') &&
        typeof (entry as Record<string, unknown>).generatedAt === 'string'
      ) {
        titles[key] = entry as TitleEntry;
      }
    }
    return { version: 1, titles };
  } catch {
    return emptyIndex();
  }
}

/** Look up one title entry by session UUID. Returns undefined if not found. */
export function getTitle(index: TitleIndex, sessionId: string): TitleEntry | undefined {
  if (!isSafeKey(sessionId)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(index.titles, sessionId)) return undefined;
  return index.titles[sessionId];
}

// ---------------------------------------------------------------------------
// Write (Phase 1.5 / Phase 2 — ships with rename or LLM feature)
// ---------------------------------------------------------------------------

/**
 * Persist a title entry for `sessionId`. Uses an atomic temp-file + rename
 * to prevent file corruption when multiple VS Code windows run concurrently.
 *
 * Note: concurrent writes use a read-modify-write pattern with no lock, so
 * the last rename wins. File corruption is prevented; lost updates (where one
 * window's write overwrites another's) remain possible. A lock-file strategy
 * would be needed to eliminate lost updates entirely.
 */
export async function setTitle(
  sessionId: string,
  entry: TitleEntry,
  filePath = INDEX_FILE,
): Promise<void> {
  if (!isSafeKey(sessionId)) return;
  const current = await loadTitleIndex(filePath);
  current.titles[sessionId] = entry;
  await atomicWrite(filePath, current);
}

/**
 * Remove a title entry by session UUID. No-op if the entry does not exist.
 */
export async function removeTitle(
  sessionId: string,
  filePath = INDEX_FILE,
): Promise<void> {
  if (!isSafeKey(sessionId)) return;
  const current = await loadTitleIndex(filePath);
  if (!Object.prototype.hasOwnProperty.call(current.titles, sessionId)) return;
  delete current.titles[sessionId];
  await atomicWrite(filePath, current);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function emptyIndex(): TitleIndex {
  return { version: 1, titles: Object.create(null) as Record<string, TitleEntry> };
}

/** Return true if `key` is safe to use as a plain-object property name. */
function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Write `index` to `filePath` atomically: serialize to a uniquely-named sibling
 * `.tmp` file (PID + timestamp + random suffix) then rename over the target.
 * Using a unique name per write prevents concurrent writers from clobbering
 * each other's temp file.
 *
 * `mkdir -p` ensures the parent directory exists.
 *
 * On Windows, `fs.rename` can throw EPERM / EEXIST / EACCES when the
 * destination exists. Rather than deleting the original (data-loss risk if the
 * retry rename then fails), we rename the original to a `.bak` first, rename
 * the tmp into place, then discard the backup. If the replacement rename fails,
 * we restore the backup so no data is lost.
 */
async function atomicWrite(filePath: string, index: TitleIndex): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Unique temp name to avoid concurrent-writer collisions.
  const uid = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const tmp = `${filePath}.${uid}.tmp`;
  const bak = `${filePath}.${uid}.bak`;
  let backedUp = false;
  try {
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
    try {
      // Optimistic path (POSIX: rename atomically replaces destination).
      await fs.rename(tmp, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST' || code === 'EACCES') {
        // Windows: back up the original, then swap in the new file.
        // If rename-to-bak fails the original is untouched; if swap fails
        // we restore from backup — no data is ever permanently deleted.
        await fs.rename(filePath, bak).catch(() => undefined);
        backedUp = true;
        try {
          await fs.rename(tmp, filePath);
          // Success — discard backup.
          await fs.rm(bak, { force: true }).catch(() => undefined);
        } catch (swapErr) {
          // Swap failed — restore backup to preserve original data.
          await fs.rename(bak, filePath).catch(() => undefined);
          throw swapErr;
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Best-effort cleanup of the temp file on any failure.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    // If we never completed the backup step, bak doesn't exist — nothing to clean.
    if (backedUp) {
      await fs.rm(bak, { force: true }).catch(() => undefined);
    }
    throw err;
  }
}
