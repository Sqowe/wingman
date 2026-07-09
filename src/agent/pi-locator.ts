/**
 * Locates the pi executable and checks its version.
 *
 * Resolution strategy:
 *  1. sqoweWingman.piExecutablePath setting — an explicit choice always wins
 *     (used as-is regardless of version; a low version still warns).
 *  2. Auto-detection gathers candidates from ALL of these sources, then picks
 *     the one with the highest pi version (so a stale install on PATH never
 *     shadows a newer one — the common nvm "two node versions" case):
 *       a. the user's login shell PATH (`$SHELL -lic 'command -v pi'`) — this is
 *          what their terminal would resolve, including version-manager defaults
 *          that a GUI-launched VS Code does not inherit;
 *       b. `pi` on the inherited PATH (`which` / `where`);
 *       c. common install dirs + every nvm `versions/node/<ver>/bin` dir, which
 *          a GUI-launched VS Code's PATH typically omits.
 *
 * Never throws — any failure is expressed as `{ kind: 'not-found' }`. All
 * discovery steps are best-effort and log to the optional logger.
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
export const PI_MINIMUM_VERSION = '0.80.0';

/** Optional diagnostics sink (wired to the extension's output channel). */
export type LocatorLog = (message: string) => void;

/**
 * Static directories to probe when VS Code is launched from a GUI launcher and
 * the login-shell PATH is not inherited. nvm's versioned dirs are added
 * dynamically (see findNvmBinDirs) because they are not at a fixed path.
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
 * Resolves `pi` the way the user's interactive terminal would, by asking their
 * login shell. This captures version-manager defaults (nvm/fnm/asdf) that are
 * configured in shell rc files and therefore missing from a GUI-launched VS
 * Code's inherited PATH. POSIX-only; Windows uses `where` (see findPiOnPath).
 */
async function findPiViaLoginShell(log: LocatorLog): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    // -l (login) + -i (interactive) source profile/rc where nvm et al. live.
    const { stdout } = await execFileAsync(shell, ['-lic', 'command -v pi'], {
      timeout: 5_000,
    });
    // Interactive shells can emit banner/job-control noise — scan for the first
    // line that is an absolute path to an executable.
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/') && (await isExecutable(line))) {
        return line;
      }
    }
  } catch {
    // shell missing / timed out / pi not found — fall through to other sources
  }
  log('[pi-locator] login shell did not resolve pi');
  return null;
}

/**
 * Tries to find `pi` via the shell's `which` (macOS/Linux) or `where` (Windows).
 * This respects the PATH that was actually inherited by the extension host.
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
 * Returns every `versions/node/<ver>/bin` directory under the nvm install.
 * nvm injects the active version's bin into PATH via shell rc, so a
 * GUI-launched VS Code never sees it; probing the dirs recovers those installs.
 */
async function findNvmBinDirs(): Promise<string[]> {
  const nvmDir = process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    const entries = await fsp.readdir(versionsDir);
    return entries.map((e) => path.join(versionsDir, e, 'bin'));
  } catch {
    return []; // no nvm install
  }
}

/**
 * Probes the static install dirs plus every nvm node bin dir for a `pi` binary
 * that `which` may have missed (GUI-launched VS Code without a login-shell PATH).
 * Returns ALL matches — the caller version-checks and picks the newest.
 */
async function findPiInProbeDirs(): Promise<string[]> {
  const binary = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  const dirs = [...EXTRA_BIN_DIRS, ...(await findNvmBinDirs())];
  const found: string[] = [];
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (await isExecutable(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/** Builds the PiStatus for a resolved path + version (warns below the minimum). */
function statusFor(execPath: string, version: string): PiStatus {
  if (compareSemver(version, PI_MINIMUM_VERSION) < 0) {
    return {
      kind: 'version-warning',
      version,
      path: execPath,
      minimum: PI_MINIMUM_VERSION,
    };
  }
  return { kind: 'found', version, path: execPath };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolves the pi executable and returns its status.
 *
 * @param log Optional diagnostics sink; receives the candidate list and choice.
 */
export async function locatePi(log: LocatorLog = () => {}): Promise<PiStatus> {
  const config = vscode.workspace.getConfiguration('sqoweWingman');
  const configured = expandHome(config.get<string>('piExecutablePath', '').trim());

  // 1. An explicit setting always wins — respect the user's choice as-is.
  if (configured) {
    const version = await getPiVersion(configured);
    if (version !== null) {
      log(`[pi-locator] using configured piExecutablePath: ${configured} (v${version})`);
      return statusFor(configured, version);
    }
    log(`[pi-locator] configured piExecutablePath is not a valid pi binary, ignoring: ${configured}`);
    // fall through to auto-detection
  }

  // 2. Gather candidates from all sources concurrently, then dedup.
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (p: string | null): void => {
    if (p && !seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  const [shellPath, whichPath, probePaths] = await Promise.all([
    findPiViaLoginShell(log),
    findPiOnPath(),
    findPiInProbeDirs(),
  ]);
  push(shellPath);
  push(whichPath);
  for (const p of probePaths) push(p);

  // 3. Version every candidate (in parallel); drop invalid ones.
  const versioned = await Promise.all(
    candidates.map(async (p) => ({ path: p, version: await getPiVersion(p) })),
  );
  const resolved: Array<{ path: string; version: string }> = [];
  for (const v of versioned) {
    if (v.version === null) {
      log(`[pi-locator] skipping invalid/non-pi candidate: ${v.path}`);
    } else {
      resolved.push({ path: v.path, version: v.version });
    }
  }

  if (resolved.length === 0) {
    log('[pi-locator] no pi executable found (login shell, PATH, or probe dirs).');
    return { kind: 'not-found' };
  }

  // 4. Pick the highest version so a stale install never shadows a newer one.
  resolved.sort((a, b) => compareSemver(b.version, a.version));
  const best = resolved[0];

  if (resolved.length > 1) {
    log('[pi-locator] multiple pi installs found:');
    for (const r of resolved) {
      log(`  - ${r.path} (v${r.version})${r === best ? '  ← selected (highest version)' : ''}`);
    }
  } else {
    log(`[pi-locator] resolved pi: ${best.path} (v${best.version})`);
  }

  return statusFor(best.path, best.version);
}
