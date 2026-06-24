/**
 * project-trust.ts — pure helpers for pi's project-trust gate.
 *
 * Pi's security model (docs/security.md):
 *  - A project "requires trust" when it has any of:
 *      .pi/settings.json
 *      .pi/extensions, .pi/skills, .pi/prompts, or .pi/themes
 *      .pi/SYSTEM.md or .pi/APPEND_SYSTEM.md
 *      .agents/skills in the cwd or any ancestor directory
 *  - Trust decisions are stored in ~/.pi/agent/trust.json as a map of
 *    canonical directory path → boolean.
 *  - The *closest* saved decision on the current or parent path wins.
 *  - In non-interactive modes (--mode rpc) without a saved decision,
 *    `defaultProjectTrust: "ask"` (the default) and `"never"` ignore project
 *    resources; `"always"` trusts them.
 *  - The extension passes --approve or --no-approve to override for one run.
 *
 * This module is intentionally vscode-free (no `vscode` import) so it can be
 * unit-tested without mocking the extension host.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The result of evaluating project trust for a workspace folder. */
export type TrustDecision =
  | { kind: 'no-resources' }              // no .pi/ resources found — no flag needed
  | { kind: 'saved'; trusted: boolean }   // found a saved decision in trust.json
  | { kind: 'temporary'; trusted: boolean } // one-run override; not persisted
  | { kind: 'needs-prompt' };             // resources present, no saved decision

/** trust.json is a Record<canonicalPath, boolean> */
export type TrustMap = Record<string, boolean>;

// ─── Resource detection ───────────────────────────────────────────────────────

/**
 * Items inside .pi/ that, if present, require trust before pi will load them.
 * A bare .pi/ directory with none of these does NOT require trust.
 */
const PI_TRUST_FILES = [
  'settings.json',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
];

const PI_TRUST_DIRS = [
  'extensions',
  'skills',
  'prompts',
  'themes',
];

/**
 * Returns true if the workspace folder at `folderPath` contains .pi/ resources
 * that require trust before pi will load them in non-interactive mode.
 *
 * Also checks `.agents/skills` in `folderPath` and all its ancestors up to the
 * filesystem root (pi inherits project skills from parent directories).
 */
export function hasProjectResources(
  folderPath: string,
  fsStat: (p: string) => fs.Stats | null = safeStat,
): boolean {
  const piDir = path.join(folderPath, '.pi');
  const piDirStat = fsStat(piDir);
  if (piDirStat?.isDirectory()) {
    for (const f of PI_TRUST_FILES) {
      if (fsStat(path.join(piDir, f))) return true;
    }
    for (const d of PI_TRUST_DIRS) {
      const s = fsStat(path.join(piDir, d));
      if (s?.isDirectory()) return true;
    }
  }

  // Walk up the directory tree checking for .agents/skills
  let current = folderPath;
  while (true) {
    const agentsSkills = path.join(current, '.agents', 'skills');
    const s = fsStat(agentsSkills);
    if (s?.isDirectory()) return true;
    const parent = path.dirname(current);
    if (parent === current) break; // reached fs root
    current = parent;
  }

  return false;
}

// ─── trust.json helpers ───────────────────────────────────────────────────────

/** Default location of pi's shared trust store. */
export function defaultTrustJsonPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'trust.json');
}

/**
 * Read trust.json and return its contents.
 * Returns an empty map if the file doesn't exist or can't be parsed.
 */
export function readTrustJson(
  trustJsonPath: string = defaultTrustJsonPath(),
): TrustMap {
  try {
    const text = fs.readFileSync(trustJsonPath, 'utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Validate: only keep boolean values.
      const result: TrustMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') result[k] = v;
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write a single trust decision for `folderPath` into trust.json.
 * Creates parent dirs and the file if they don't exist.
 * Merges with any existing content so other projects' decisions are preserved.
 *
 * When trust.json exists but is malformed/unparseable, the original file is
 * backed up to `trust.json.bak` before being overwritten, so user decisions
 * from a corrupted file are not silently lost.
 *
 * Uses the canonical (realpath) of the folder so decisions survive symlink
 * variations; falls back to the original path if realpath fails.
 */
export function saveTrustDecision(
  folderPath: string,
  trusted: boolean,
  trustJsonPath: string = defaultTrustJsonPath(),
): void {
  const canonical = canonicalizePath(folderPath);

  // Read existing content. If the file exists but is unreadable/malformed,
  // back it up before overwriting so existing decisions are not silently lost.
  let existing: TrustMap = {};
  try {
    const text = fs.readFileSync(trustJsonPath, 'utf8');
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'boolean') existing[k] = v;
        }
      } else {
        // Valid JSON but wrong shape — back up and start fresh.
        _backupTrustJson(trustJsonPath, text);
      }
    } catch {
      // Malformed JSON — back up and start fresh.
      _backupTrustJson(trustJsonPath, text);
    }
  } catch {
    // File doesn't exist yet — that's fine, we'll create it.
  }

  existing[canonical] = trusted;

  const dir = path.dirname(trustJsonPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(trustJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

/** Write a `.bak` copy of the original trust.json content. Best-effort. */
function _backupTrustJson(trustJsonPath: string, content: string): void {
  try {
    fs.writeFileSync(trustJsonPath + '.bak', content, 'utf8');
  } catch {
    // Back-up is best-effort — don't fail the save operation over it.
  }
}

/**
 * Look up the trust decision for `folderPath` in `trustMap`.
 *
 * Walks from the folder path up to the filesystem root and returns the
 * decision for the *closest* matching ancestor (same algorithm pi uses).
 * Returns `null` if no decision is found.
 */
export function lookupTrustDecision(
  folderPath: string,
  trustMap: TrustMap,
): boolean | null {
  const canonical = canonicalizePath(folderPath);

  let current = canonical;
  while (true) {
    if (Object.prototype.hasOwnProperty.call(trustMap, current)) {
      return trustMap[current];
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// ─── Top-level evaluator ──────────────────────────────────────────────────────

/**
 * Evaluate the trust status for a workspace folder.
 *
 * Returns:
 *  - `{ kind: 'no-resources' }` — spawn without --approve/--no-approve.
 *  - `{ kind: 'saved', trusted }` — pass --approve or --no-approve accordingly.
 *  - `{ kind: 'needs-prompt' }` — ask the user before spawning.
 */
export function evaluateTrust(
  folderPath: string,
  opts: {
    trustJsonPath?: string;
    fsStat?: (p: string) => fs.Stats | null;
  } = {},
): TrustDecision {
  const fsStat = opts.fsStat ?? safeStat;
  if (!hasProjectResources(folderPath, fsStat)) {
    return { kind: 'no-resources' };
  }

  const trustMap = readTrustJson(opts.trustJsonPath);
  const saved = lookupTrustDecision(folderPath, trustMap);
  if (saved !== null) {
    return { kind: 'saved', trusted: saved };
  }

  return { kind: 'needs-prompt' };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Return a normalized canonical path for use as a trust.json key.
 *
 * - Resolves symlinks via `realpathSync` (falls back to raw path on failure).
 * - Normalizes separators and removes trailing separators via `path.normalize`.
 * - On Windows, lowercases the drive letter for case-insensitive comparison.
 */
function canonicalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = p;
  }
  let normalized = path.normalize(resolved);
  // Remove trailing separator unless it is the root itself (e.g. '/' or 'C:\\').
  const { root } = path.parse(normalized);
  if (normalized !== root && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  // On Windows, lowercase the drive letter for case-insensitive key matching.
  if (process.platform === 'win32' && normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}
