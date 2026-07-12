/**
 * Wingman bundled pi extension — claude-memory
 *
 * Shares Claude Code's project memory with pi, READ-ONLY (share, don't update).
 *
 * Claude Code keeps a per-project memory folder at
 *   ~/.claude/projects/<encoded-cwd>/memory/
 * containing a MEMORY.md index plus one markdown file per remembered fact.
 * This extension reads that folder for the current project and appends it to
 * pi's system prompt, so the pi agent shares what Claude Code has learned. It
 * never writes, updates, or deletes the memory — one-way sharing only.
 *
 * Plain JavaScript (no build step) so pi can load it directly via `-e <path>`,
 * matching the standing convention for bundled pi extensions in this repo.
 *
 * See pi-extensions/claude-memory/README.md for full documentation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Reserved status key intercepted by the Wingman host bridge (never shown in
// the generic status strip). The host parses the JSON payload and renders a
// "Project memory" group in the status banner. Mirrors wingman:instructionFiles.
const CLAUDE_MEMORY_STATUS_KEY = 'wingman:claudeMemory';

// Char budget for how much memory is eagerly inlined into the system prompt.
// Whole files are included until the budget is reached; the remainder is listed
// by name for the agent to read on demand. Overridable via env.
const DEFAULT_MAX_CHARS = 12000;

// Cap on how many fact entries are transmitted in the status report (paths +
// titles) to keep RPC payloads bounded on large memory folders. The banner
// popover only renders a handful anyway; `count` still carries the true total.
const MAX_REPORTED_FILES = 200;

export default function (pi) {
  // Kill switch — bail before registering any hooks.
  if ((process.env['WINGMAN_CLAUDE_MEMORY'] ?? '').toLowerCase() === 'off') return;

  // Resolved once per session in session_start, then injected byte-identical on
  // every turn — keeps the system-prompt prefix stable for KV caching.
  let memoryBlock = null;

  pi.on('session_start', async (_event, ctx) => {
    // Always emit a report so the host clears any stale memory from a previous
    // session/project. `null` = no memory folder / empty / read error.
    const report = (payload) => {
      if (ctx.ui && typeof ctx.ui.setStatus === 'function') {
        ctx.ui.setStatus(CLAUDE_MEMORY_STATUS_KEY, JSON.stringify(payload));
      }
    };
    try {
      const dir = resolveMemoryDir(ctx.cwd);
      if (!dir) {
        memoryBlock = null;
        report(null);
        return;
      }

      const built = buildMemoryBlock(dir);
      if (!built || built.count === 0) {
        memoryBlock = null;
        report(null);
        return;
      }

      memoryBlock = built.text;

      // Stage B: report the full fact-file list (paths + display titles) so the
      // host can render a clickable "Project memory" banner group. This lists
      // ALL facts (any is clickable), independent of which subset the char
      // budget inlined into the prompt.
      // The transmitted list is already capped by buildMemoryBlock; `count` is
      // the true total (the banner shows "+N more" beyond what it lists).
      report({ dir, count: built.count, files: built.files });
    } catch {
      // Sharing is best-effort — never let a read error break the session.
      memoryBlock = null;
      report(null);
    }
  });

  pi.on('before_agent_start', async (event) => {
    if (!memoryBlock) return;
    return {
      systemPrompt:
        event.systemPrompt +
        '\n\n## Project memory (shared from Claude Code — read-only)\n\n' +
        'The following are facts Claude Code recorded about this project. Treat them ' +
        'as point-in-time notes, not live state — verify against current code before ' +
        'relying on them. Do not edit these files; Claude Code owns and maintains them.\n\n' +
        memoryBlock,
    };
  });
}

/**
 * Resolve Claude Code's memory dir for the current project.
 *
 * Claude Code encodes the project path by replacing "/" and "." with "-" under
 * ~/.claude/projects/<slug>/memory/. We try the cwd first, then the git root,
 * so running pi from a subdirectory of the project still resolves.
 *
 * Returns an absolute dir path, or null when no memory folder exists.
 */
function resolveMemoryDir(cwd) {
  if (!cwd) return null;
  const base = path.join(os.homedir(), '.claude', 'projects');

  const candidates = [path.join(base, encodeProjectPath(cwd), 'memory')];
  const root = gitRoot(cwd);
  if (root && path.resolve(root) !== path.resolve(cwd)) {
    candidates.push(path.join(base, encodeProjectPath(root), 'memory'));
  }

  return candidates.find(isDirectory) ?? null;
}

/** Reproduce Claude Code's project-dir encoding: "/" and "." both become "-". */
function encodeProjectPath(p) {
  return path.resolve(p).replace(/[/.]/g, '-');
}

/** Walk up from `start` to the nearest ancestor containing a `.git` entry. */
function gitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the injected memory block from a Claude Code memory dir.
 *
 * Always includes MEMORY.md (the compact index), then inlines whole fact files
 * until the char budget is reached; any remainder is listed by name so the pi
 * agent can read it on demand with its own read tool. Never mid-cuts a file.
 *
 * Returns { text, count, files } where count is the number of fact files and
 * files is [{ path, title }] for every fact (titles parsed from the MEMORY.md
 * index links, filename-slug fallback), or null when the folder holds no fact
 * files.
 */
function buildMemoryBlock(dir) {
  const maxChars = parseMaxChars();
  const allMd = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const factFiles = allMd.filter((f) => f !== 'MEMORY.md').sort();
  if (factFiles.length === 0) return null;

  const parts = [];
  const indexPath = path.join(dir, 'MEMORY.md');
  const indexText = fileExists(indexPath) ? readText(indexPath) : '';
  if (indexText.trim()) parts.push(indexText.trim());

  // Map filename -> display title parsed from MEMORY.md links ("- [Title](slug.md)").
  const titles = parseIndexTitles(indexText);

  let used = parts.reduce((n, p) => n + p.length, 0);
  const skipped = [];
  for (const f of factFiles) {
    const body = stripFrontmatter(readText(path.join(dir, f))).trim();
    const block = `### ${f.replace(/\.md$/, '')}\n\n${body}`;
    if (used + block.length > maxChars) {
      skipped.push(f);
      continue;
    }
    parts.push(block);
    used += block.length + 2;
  }

  if (skipped.length > 0) {
    parts.push(
      `_${skipped.length} more memory file(s) not inlined — read on demand from ${dir}: ${skipped.join(', ')}_`,
    );
  }

  // Cap the mapped list to avoid building a huge array on large memory folders;
  // `count` stays the true total. The banner shows a "+N more" row beyond this.
  const files = factFiles.slice(0, MAX_REPORTED_FILES).map((f) => ({
    path: path.join(dir, f),
    title: titles.get(f) ?? f.replace(/\.md$/, ''),
  }));

  return { text: parts.join('\n\n'), count: factFiles.length, files };
}

/**
 * Parse a MEMORY.md index into a filename -> title map from its markdown links.
 * Matches `[Title](slug.md)` anywhere on a line; the link target's basename is
 * the key so titles resolve regardless of relative path prefixes.
 */
function parseIndexTitles(indexText) {
  const map = new Map();
  if (!indexText) return map;
  // Match [Title](target.md) allowing an optional #anchor or ?query after .md,
  // and relative path prefixes; key by the target's basename.
  const linkRe = /\[([^\]]+)\]\(([^)]+?\.md)(?:[#?][^)]*)?\)/g;
  let m;
  while ((m = linkRe.exec(indexText)) !== null) {
    const title = m[1].trim();
    const file = path.basename(m[2].trim());
    if (title && file && !map.has(file)) map.set(file, title);
  }
  return map;
}

/** Read WINGMAN_CLAUDE_MEMORY_MAX_CHARS, falling back to the default. */
function parseMaxChars() {
  const raw = process.env['WINGMAN_CLAUDE_MEMORY_MAX_CHARS'];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}

/** Remove a leading YAML frontmatter block ("---\n…\n---\n"), if present. */
function stripFrontmatter(md) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}
