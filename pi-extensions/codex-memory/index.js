/**
 * Wingman bundled pi extension — codex-memory
 *
 * Shares OpenAI Codex's local memories with pi, READ-ONLY (share, don't update).
 *
 * Codex (CLI, IDE extension, desktop app share one store) keeps local memories at
 *   $CODEX_HOME/memories/          (layout v1)
 *   $CODEX_HOME/memories_v2/       (layout v2)
 * with `memory_summary.md` (always prompt-loaded by Codex itself), `MEMORY.md`
 * (task-group handbook with `applies_to: cwd=` tags), `skills/<name>/SKILL.md`
 * and `rollout_summaries/<slug>.md`. The store is global per machine — project
 * scope is preserved inside the content via cwd tags, not in the folder layout.
 *
 * This extension reads that store for the current machine and appends it to
 * pi's system prompt, so the pi agent shares what Codex has learned. It never
 * writes, updates, or deletes anything — one-way sharing only.
 *
 * Plain JavaScript (no build step) so pi can load it directly via `-e <path>`,
 * matching the standing convention for bundled pi extensions in this repo.
 *
 * See pi-extensions/codex-memory/README.md for full documentation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Reserved status key intercepted by the Wingman host bridge (never shown in
// the generic status strip). The host parses the JSON payload and renders a
// "Codex memory" group in the status banner. Mirrors wingman:claudeMemory.
const CODEX_MEMORY_STATUS_KEY = 'wingman:codexMemory';

// Char budget for what is eagerly inlined beyond memory_summary.md (task-group
// blocks from MEMORY.md). Whole blocks are included until the budget is
// reached; the remainder is listed by name for the agent to read on demand.
// memory_summary.md itself is always inlined whole — Codex keeps it dense and
// prompt-sized by design, and it is the artifact Codex itself prompt-loads.
// Overridable via env.
const DEFAULT_MAX_CHARS = 12000;

// Cap on how many artifact entries are transmitted in the status report
// (paths + titles) to keep RPC payloads bounded on large memory stores. The
// banner popover only renders a handful anyway; `count` carries the true total.
const MAX_REPORTED_FILES = 200;

// Hard cap for memory_summary.md. The summary is injected whole (Codex keeps
// it prompt-sized by design), so a corrupted or oversized file would otherwise
// inflate every turn's system prompt without bound. Beyond this the summary is
// truncated and the agent is told to read the full file on demand.
const MAX_SUMMARY_CHARS = 100000;

// Hard ceiling for a MEMORY.md read (bytes). The registry is parsed for task
// groups, so it is read whole — but never more than this, so a pathological
// file cannot blow up the session start.
const MAX_REGISTRY_BYTES = 2000000;

// Clamp for the char budget, matching the sqoweWingman.codexMemoryMaxChars
// setting range — settings and env must not disagree.
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 200000;

// Whether the platform's default filesystem compares paths case-insensitively
// (Windows always; macOS on its default case-insensitive volume).
const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';

/** Layout versions in preference order (v2 is the newer layout). */
const MEMORY_DIR_CANDIDATES = ['memories_v2', 'memories'];

export default function (pi) {
  // Kill switch — bail before registering any hooks.
  if ((process.env['WINGMAN_CODEX_MEMORY'] ?? '').toLowerCase() === 'off') return;

  // Resolved once per session in session_start, then injected byte-identical on
  // every turn — keeps the system-prompt prefix stable for KV caching.
  let memoryBlock = null;
  // `null` means "nothing to inject" — tracked explicitly rather than by the
  // text's truthiness, so the banner report and the injection always agree.

  pi.on('session_start', async (_event, ctx) => {
    // Always emit a report so the host clears any stale memory from a previous
    // session/machine state. `null` = no memory store / empty / read error.
    const report = (payload) => {
      if (ctx.ui && typeof ctx.ui.setStatus === 'function') {
        ctx.ui.setStatus(CODEX_MEMORY_STATUS_KEY, JSON.stringify(payload));
      }
    };
    try {
      const dir = resolveMemoryDir();
      if (!dir) {
        memoryBlock = null;
        report(null);
        return;
      }

      const built = buildMemoryBlock(dir, ctx.cwd);
      if (!built || built.count === 0) {
        memoryBlock = null;
        report(null);
        return;
      }

      // Nothing to inline (e.g. project scope with no matching blocks): skip
      // the injection rather than append a hollow section — but still report
      // the artifacts, so the banner can list what Codex has on disk.
      memoryBlock = built.text.trim() ? built.text : null;

      // Report the artifact list (paths + display titles) so the host can
      // render a clickable "Codex memory" banner group. This lists ALL memory
      // artifacts (any is clickable), independent of what the scope/char
      // budget inlined into the prompt. The list is capped; `count` is the
      // true total (the banner shows "+N more" beyond what it lists).
      report({ dir, count: built.count, files: built.files });
    } catch {
      // Sharing is best-effort — never let a read error break the session.
      memoryBlock = null;
      report(null);
    }
  });

  pi.on('before_agent_start', async (event) => {
    if (memoryBlock === null) return;
    return {
      systemPrompt:
        event.systemPrompt +
        '\n\n## Codex memory (shared, read-only)\n\n' +
        'The following is memory OpenAI Codex recorded about this machine and its projects. ' +
        'Treat it as point-in-time notes, not live state — verify against current code before ' +
        'relying on it. Do not edit these files; Codex owns and maintains them.\n\n' +
        memoryBlock,
    };
  });
}

/**
 * Resolve Codex's memory dir for this machine.
 *
 * Codex stores memories under $CODEX_HOME (default ~/.codex), in `memories`
 * (v1) or `memories_v2` (v2). The version is selected by Codex's own config
 * (`memories.version`), which we do not parse — instead prefer the newer
 * layout that actually holds memory artifacts, falling back to the older one.
 *
 * Returns an absolute dir path, or null when no memory store exists.
 */
function resolveMemoryDir() {
  const home = process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
  for (const name of MEMORY_DIR_CANDIDATES) {
    // Absolute: the host requires an absolute dir and absolute file paths in
    // the status payload (CODEX_HOME may be relative).
    const dir = path.resolve(home, name);
    if (!isDirectory(dir)) continue;
    if (fileExists(path.join(dir, 'memory_summary.md')) || fileExists(path.join(dir, 'MEMORY.md'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Build the injected memory block from a Codex memory dir.
 *
 * Artifacts, in order:
 *  1. `memory_summary.md` — always inlined whole when present (Codex itself
 *     prompt-loads it; it is kept dense by design). It does not consume the
 *     char budget.
 *  2. Task-group blocks from `MEMORY.md` — per the scope setting:
 *       - `summary` (default): none (the summary already routes into MEMORY.md)
 *       - `project`: only blocks whose `applies_to: cwd=` matches the current
 *         workspace (see `selectBlocks` for the matching rule)
 *       - `all`: every block
 *     Whole blocks are inlined until the remaining char budget is spent; the
 *     rest are listed by name for the pi agent to read on demand. Never
 *     mid-cuts a block. When the store has no summary, the registry stands in
 *     for it — scope- and budget-filtered, never dumped whole.
 *
 * Returns { text, count, files } where count is the total number of memory
 * artifacts (summary, MEMORY.md, rollout summaries, skill entrypoints) and
 * files is [{ path, title }] for display, or null when the store holds no
 * artifacts.
 */
function buildMemoryBlock(dir, cwd) {
  const scope = parseScope();
  const maxChars = parseMaxChars();

  const summaryPath = path.join(dir, 'memory_summary.md');
  const registryPath = path.join(dir, 'MEMORY.md');
  const hasSummary = fileExists(summaryPath);
  const hasRegistry = fileExists(registryPath);
  if (!hasSummary && !hasRegistry) return null;

  const parts = [];
  // The summary is the core prompt artifact; when it is missing (older or
  // hand-edited store) the registry stands in for it — but still scope- and
  // budget-filtered, never dumped whole.
  if (hasSummary) {
    parts.push(readSummary(summaryPath));
  }

  // ── Task-group blocks from MEMORY.md ────────────────────────────────────
  const skipped = [];
  if (hasRegistry) {
    const registryText = readTextCapped(registryPath, MAX_REGISTRY_BYTES).trim();
    const blocks = parseTaskGroups(registryText);
    // Without a summary the registry IS the summary — so `summary` scope falls
    // back to admitting every block (still under the char budget).
    const effectiveScope = hasSummary || scope !== 'summary' ? scope : 'all';
    const selected = selectBlocks(blocks, effectiveScope, cwd);
    // The budget bounds the registry blocks — the summary (when present) is
    // always whole and does not consume it. Blocks are taken in order; once
    // one does not fit, the rest is listed by name (never mid-cut).
    let used = 0;
    for (let i = 0; i < selected.length; i++) {
      const block = selected[i];
      const cost = block.text.length + 2;
      if (used + cost > maxChars) {
        for (const rest of selected.slice(i)) skipped.push(`MEMORY.md — ${rest.name}`);
        break;
      }
      parts.push(block.text);
      used += cost;
    }
    if (blocks.length === 0 && registryText) {
      // Free-form registry (no task-group headers): it carries no cwd tag, so
      // it is only inlined when it may be inlined at all — `all`, or when it
      // stands in for a missing summary. `project` treats untagged content
      // like an untagged block and skips it.
      if (effectiveScope === 'all') {
        if (registryText.length <= maxChars) parts.push(registryText);
        else skipped.push('MEMORY.md');
      }
    }
  }

  if (skipped.length > 0) {
    parts.push(
      `_${skipped.length} more memory artifact(s) not inlined — read on demand from ${dir}: ${skipped.join('; ')}_`,
    );
  }

  const artifacts = listArtifacts(dir);
  if (artifacts.length === 0) return null;

  return {
    text: parts.join('\n\n'),
    // `count` is the true total; the transmitted list is capped for RPC size.
    count: artifacts.length,
    files: artifacts.slice(0, MAX_REPORTED_FILES),
  };
}

/** Task-group block from MEMORY.md: its display name, raw text, and cwd tag. */
function parseTaskGroups(registryText) {
  const blocks = [];
  const lines = registryText.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = line.match(/^#\s*Task Group:\s*(.+?)\s*$/);
    if (m) {
      if (current) blocks.push(current);
      current = { name: m[1], text: line, cwd: null };
      continue;
    }
    if (current) {
      const tag = line.match(/^\s*applies_to:\s*cwd=([^;]+)/i);
      // The path may contain spaces (e.g. "C:\Users\John Doe\project"), so the
      // capture runs to the ';' separator (or end of line) and is trimmed.
      if (tag && current.cwd === null) current.cwd = tag[1].trim();
      current.text += '\n' + line;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Pick the task-group blocks a scope admits. `project` matches a block when
 * its cwd tag equals the workspace, or one path-prefixes the other (a tag at a
 * repo root applies from subdirectories, and vice versa). Untagged blocks are
 * excluded from `project` (conservative — they may belong to any checkout) and
 * admitted by `all`.
 *
 * The git root needs no special case: it is always an ancestor of the
 * workspace, so a tag that covers the git root also covers the workspace and
 * is matched by the bidirectional check below. That is why a workspace in a
 * monorepo subfolder (e.g. /monorepo/packages/app) does not pull in sibling
 * package tags (e.g. /monorepo/packages/other) — while a tag on the monorepo
 * root itself still matches.
 */
function selectBlocks(blocks, scope, cwd) {
  if (scope === 'all') return blocks;
  if (scope !== 'project') return [];
  const workdir = cwd ? path.resolve(cwd) : null;
  return blocks.filter((b) => {
    if (!b.cwd || !workdir) return false;
    const tagged = b.cwd;
    // The workspace itself: same dir, an ancestor of it, or a descendant of it.
    return isUnder(tagged, workdir) || isUnder(workdir, tagged);
  });
}

/**
 * True when `child` is `parent` or sits below it. Comparison is
 * separator-aware and case-folded where the platform's default filesystem is
 * case-insensitive (Windows, and macOS's default case-insensitive volumes),
 * so a tag written with different casing still matches.
 */
function isUnder(parent, child) {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  if (c === p) return true;
  const sep = process.platform === 'win32' ? '/' : path.sep;
  const pWithSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(pWithSep);
}

/** Canonical form used for path comparison (case-folded where appropriate). */
function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return CASE_INSENSITIVE_FS
    ? resolved.replace(/\\/g, '/').toLowerCase()
    : resolved;
}

/**
 * Read memory_summary.md, bounded by MAX_SUMMARY_CHARS. The summary is
 * prompt-loaded whole, so an oversized one is truncated with a marker instead
 * of being injected unbounded.
 */
function readSummary(filePath) {
  const text = readTextCapped(filePath, MAX_SUMMARY_CHARS).trim();
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size <= MAX_SUMMARY_CHARS) return text;
  return (
    text.slice(0, MAX_SUMMARY_CHARS) +
    `\n\n_[summary truncated at ${MAX_SUMMARY_CHARS} characters — read the full file at ${filePath}]_`
  );
}

/**
 * Read a text file, reading at most `maxBytes` from it. Keeps a corrupted or
 * oversized file from being slurped into memory in full — the read is bounded
 * before it happens, not after.
 */
function readTextCapped(filePath, maxBytes) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return '';
  }
  if (size <= maxBytes) return readText(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * List memory artifacts for the banner: the summary and registry files, every
 * rollout summary, and each skill entrypoint. Sorted. The FULL list is
 * returned — the caller reports `count` from its true length and caps only
 * the transmitted `files` (see MAX_REPORTED_FILES).
 */
function listArtifacts(dir) {
  const out = [];
  const push = (abs, title) => out.push({ path: abs, title });

  if (fileExists(path.join(dir, 'memory_summary.md'))) {
    push(path.join(dir, 'memory_summary.md'), 'memory_summary.md');
  }
  if (fileExists(path.join(dir, 'MEMORY.md'))) {
    push(path.join(dir, 'MEMORY.md'), 'MEMORY.md');
  }

  const summariesDir = path.join(dir, 'rollout_summaries');
  if (isDirectory(summariesDir)) {
    for (const f of fs.readdirSync(summariesDir).filter((f) => f.endsWith('.md')).sort()) {
      push(path.join(summariesDir, f), f.replace(/\.md$/, ''));
    }
  }

  const skillsDir = path.join(dir, 'skills');
  if (isDirectory(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir).sort()) {
      const skillMd = path.join(skillsDir, entry, 'SKILL.md');
      if (fileExists(skillMd)) push(skillMd, `skill: ${entry}`);
    }
  }

  return out;
}

/** Read WINGMAN_CODEX_MEMORY_SCOPE; anything unrecognized falls back to 'summary'. */
function parseScope() {
  const raw = (process.env['WINGMAN_CODEX_MEMORY_SCOPE'] ?? '').trim().toLowerCase();
  return raw === 'project' || raw === 'all' ? raw : 'summary';
}

/** Read WINGMAN_CODEX_MEMORY_MAX_CHARS, clamped to the setting's range. */
function parseMaxChars() {
  const raw = process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, n));
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

// Exported for unit tests (src/agent/codex-memory-extension.test.ts) — the
// runtime path only uses the default export below.
export const _internals = {
  resolveMemoryDir,
  buildMemoryBlock,
  parseTaskGroups,
  selectBlocks,
  parseScope,
  parseMaxChars,
  listArtifacts,
};
