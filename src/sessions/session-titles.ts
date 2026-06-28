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
import { collapseWhitespace } from './session-parse';

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
    for (const [key, entry] of Object.entries(parsed.titles) as [string, unknown][]) {
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
// Rename planning (Phase 1.5 — pure, vscode-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * The set/reset/no-op decision for the Rename Session command.
 *
 * - `noop`: the user cancelled the input box (Esc / focus lost) → do nothing.
 * - `reset`: the input was cleared → removeTitle, falling back to the derived
 *   first-message title.
 * - `set`: a non-empty value → store a manual override.
 */
export type RenamePlan =
  | { kind: 'noop' }
  | { kind: 'reset' }
  | { kind: 'set'; entry: TitleEntry };

/**
 * Decide what the Rename Session command should do from the raw input-box
 * result and the row's current displayed title. Pure and deterministic — the
 * vscode-bound handler stays thin.
 *
 * - `undefined` (cancelled) → `{ kind: 'noop' }`.
 * - whitespace-collapsed input is empty → `{ kind: 'reset' }`.
 * - collapsed input equals the collapsed `currentTitle` → `{ kind: 'noop' }`.
 *   Accepting the prefilled value verbatim must not pin a derived title as a
 *   manual override (which would freeze it against future derived updates and
 *   add a redundant index write). Comparing on the collapsed form means an
 *   incidental whitespace difference also counts as unchanged.
 * - otherwise → `{ kind: 'set', entry }` where the title is collapsed (but
 *   *not* truncated — manual titles are kept verbatim; only derived titles
 *   are capped at 60 chars, §4). `model` and `sourceMsgCount` are omitted
 *   for manual entries — staleness is irrelevant when the user picked it.
 *
 * `now` is injectable so tests get a deterministic timestamp.
 */
export function planRename(
  rawInput: string | undefined,
  currentTitle: string,
  now: () => string = () => new Date().toISOString(),
): RenamePlan {
  if (rawInput === undefined) {
    return { kind: 'noop' };
  }
  const collapsed = collapseWhitespace(rawInput);
  if (collapsed === '') {
    return { kind: 'reset' };
  }
  // Unchanged → no-op (see JSDoc).
  if (collapsed === collapseWhitespace(currentTitle)) {
    return { kind: 'noop' };
  }
  return {
    kind: 'set',
    entry: {
      title: collapsed,
      source: 'manual',
      generatedAt: now(),
    },
  };
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
  // Serialize per-file so concurrent read-modify-write cycles in this
  // process can't interleave and drop an entry (cross-process is still
  // last-writer-wins; the atomic rename prevents corruption).
  return serializedWrite(filePath, async () => {
    const current = await loadTitleIndex(filePath);
    current.titles[sessionId] = entry;
    await atomicWrite(filePath, current);
  });
}

/**
 * Remove a title entry by session UUID. No-op if the entry does not exist.
 */
export async function removeTitle(
  sessionId: string,
  filePath = INDEX_FILE,
): Promise<void> {
  if (!isSafeKey(sessionId)) return;
  return serializedWrite(filePath, async () => {
    const current = await loadTitleIndex(filePath);
    if (!Object.prototype.hasOwnProperty.call(current.titles, sessionId)) return;
    delete current.titles[sessionId];
    await atomicWrite(filePath, current);
  });
}

// ---------------------------------------------------------------------------
// Rename application (Phase 1.5 — orchestration over setTitle/removeTitle)
// ---------------------------------------------------------------------------

/**
 * Effects the Rename Session command needs, injected so `applyRenamePlan` is
 * unit-testable without vscode or the filesystem. `setTitle` / `removeTitle`
 * are passed in (rather than called directly) so tests can stub them —
 * including the failure path.
 */
export interface RenameApplyDeps {
  setTitle: (sessionId: string, entry: TitleEntry) => Promise<void>;
  removeTitle: (sessionId: string) => Promise<void>;
  /** Called after a successful set / reset (e.g. refresh the tree). May be async. */
  onChanged: () => void | Promise<void>;
  /** Called when persistence fails (e.g. show an error message). */
  onError: (message: string) => void;
}

/**
 * Apply a rename plan: persist via `setTitle` / `removeTitle`, notify on
 * change, and surface failures. Pure orchestration — every effect is injected
 * so it is unit-testable without vscode or the real title index. `noop` does
 * nothing (no write, no refresh).
 */
export async function applyRenamePlan(
  plan: RenamePlan,
  sessionId: string,
  deps: RenameApplyDeps,
): Promise<void> {
  if (plan.kind === 'noop') return;
  // Persist first. A failure here means nothing was saved.
  try {
    if (plan.kind === 'reset') {
      await deps.removeTitle(sessionId);
    } else {
      await deps.setTitle(sessionId, plan.entry);
    }
  } catch (err) {
    deps.onError(`Failed to rename session — ${describeError(err)}`);
    return;
  }
  // Persisted OK — now refresh. A refresh failure must NOT be reported as a
  // rename failure: the rename already succeeded on disk, so surface a
  // distinct, accurate message instead. `onChanged` may be async — awaiting it
  // here means a rejected refresh promise is caught and reported, not swallowed.
  try {
    await deps.onChanged();
  } catch (err) {
    deps.onError(
      `Rename saved, but the session list could not be refreshed — ${describeError(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Render a thrown value as a concise message (prefer `Error.message`). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-file write queue. Each value is the (always-settled) promise of the last
 * scheduled write for that file, so concurrent writes to the SAME file are
 * serialized within this process — a read-modify-write cycle can't interleave
 * with another and silently drop an entry. (Writes from other processes still
 * race; the atomic rename in `atomicWrite` prevents corruption, last wins.)
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Run `op` after any previously-serialized op for `filePath` has settled, then
 * chain the next one behind this. The returned promise forwards `op`'s own
 * result/error to the caller; the stored queue never rejects, so one failed
 * write never blocks the next.
 */
function serializedWrite<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  // Run `op` whether `prev` resolved or rejected (second onRejected arg) so a
  // prior failure doesn't deadlock the queue.
  const result = prev.then(op, op);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(filePath, tail);
  // Clean up once idle: if no newer op chained behind this one, drop the entry
  // so one-off paths (e.g. per-test temp files) don't accumulate. Safe because
  // any newer op would have replaced the stored tail synchronously first.
  void tail.then(() => {
    if (writeQueues.get(filePath) === tail) {
      writeQueues.delete(filePath);
    }
  });
  return result;
}

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
