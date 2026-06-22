/**
 * Locates the pi executable and checks its version.
 *
 * Resolution order:
 *  1. sqoweWingman.piExecutablePath setting (if set)
 *  2. `pi` on the inherited PATH  (via `which` / `where`)
 *  3. Common install directories that may not be in a GUI-launched VS Code PATH
 *     (npm global, Homebrew, Volta, ~/.local/bin)
 *
 * Returns a PiStatus that the host forwards to the webview.
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fsp, constants as fsConstants } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PiStatus } from '../shared/messages';

const execFileAsync = promisify(execFile);

/** Minimum pi version that has been tested with this extension. */
export const PI_MINIMUM_VERSION = '0.79.9';

/**
 * Extra directories to probe when VS Code is launched from a GUI launcher
 * and the login-shell PATH is not inherited.
 */
const EXTRA_BIN_DIRS: readonly string[] = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
  path.join(os.homedir(), '.fnm', 'aliases', 'default', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Expands a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Semver comparison. Returns negative if a < b, 0 if equal, positive if a > b.
 * Handles optional leading "v".
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

/** Returns true if the file at `filePath` exists and is executable. */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `<execPath> --version` and extracts the semver string.
 * Returns null on any error (missing file, non-zero exit, unexpected output).
 */
async function getPiVersion(execPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(execPath, ['--version'], {
      timeout: 5_000,
    });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Tries to find `pi` via the shell's `which` (macOS/Linux) or `where` (Windows).
 * This respects the PATH that was actually inherited by the extension host process.
 */
async function findPiOnPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['pi'], { timeout: 3_000 });
    const resolved = stdout.trim().split('\n')[0].trim();
    if (resolved && (await isExecutable(resolved))) {
      return resolved;
    }
  } catch {
    // not on PATH — fall through
  }
  return null;
}

/**
 * Probes the extra directories for a `pi` binary that `which` may have missed
 * because VS Code was not launched from a login shell.
 */
async function findPiInExtraDirs(): Promise<string | null> {
  const binary = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = path.join(dir, binary);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolves the pi executable and returns its status.
 *
 * Never throws — any failure is expressed as `{ kind: 'not-found' }`.
 */
export async function locatePi(): Promise<PiStatus> {
  const config = vscode.workspace.getConfiguration('sqoweWingman');
  const configured = expandHome(config.get<string>('piExecutablePath', '').trim());

  // Build the candidate list in priority order; deduplicate.
  const seen = new Set<string>();
  const candidates: string[] = [];

  const push = (p: string | null): void => {
    if (p && !seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  if (configured) push(configured);
  push(await findPiOnPath());
  push(await findPiInExtraDirs());

  for (const candidate of candidates) {
    const version = await getPiVersion(candidate);
    if (version === null) {
      continue; // not a valid pi binary — try next
    }
    if (compareSemver(version, PI_MINIMUM_VERSION) < 0) {
      return {
        kind: 'version-warning',
        version,
        path: candidate,
        minimum: PI_MINIMUM_VERSION,
      };
    }
    return { kind: 'found', version, path: candidate };
  }

  return { kind: 'not-found' };
}
