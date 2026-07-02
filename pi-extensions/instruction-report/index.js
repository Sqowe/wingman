/**
 * Wingman bundled pi extension — instruction-report
 *
 * Registers a single internal command (/wingman-instruction-report) that
 * reads pi's resolved instruction files via ctx.getSystemPromptOptions() and
 * reports them back to Wingman's UiProtocolBridge via ctx.ui.setStatus().
 *
 * This is plain JavaScript (no build step) so it can be loaded directly by pi
 * via `-e <path>` without any compilation pipeline.
 *
 * See pi-extensions/instruction-report/README.md for full documentation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STATUS_KEY = 'wingman:instructionFiles';
const COMMAND_NAME = 'wingman-instruction-report';

export default function (pi) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Internal — reports pi's resolved instruction files to Sqowe Wingman.",
    handler: async (_args, ctx) => {
      try {
        if (typeof ctx.getSystemPromptOptions !== 'function') {
          ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ unsupported: true }));
          return;
        }

        const options = ctx.getSystemPromptOptions();
        const files = [];

        // ── Context files (AGENTS.md / CLAUDE.md) ─────────────────────────
        // options.contextFiles is ordered [global?, ...ancestors→cwd].
        // Classify by path prefix: if it lives under the global agent dir
        // (~/.pi/agent/ or the custom AGENT_DIR if set), scope is 'global';
        // everything else is 'project'. Never forward .content — paths only.
        const agentDir = resolveAgentDir();
        for (const f of options.contextFiles ?? []) {
          if (!f.path) continue;
          const scope = isUnderDir(f.path, agentDir) ? 'global' : 'project';
          files.push({ path: f.path, scope, role: 'context' });
        }

        // ── System-prompt override (SYSTEM.md) ────────────────────────────
        // options.customPrompt is the resulting TEXT, not a file path, and
        // cannot be traced back to --system-prompt / SYSTEM.md / a template.
        // Resolve the *file* identity explicitly: project .pi/SYSTEM.md (only
        // when trusted) else global ~/.pi/agent/SYSTEM.md — a fixed two-
        // candidate existence check, not an ancestor walk.
        if (options.customPrompt) {
          const sysFile = resolveOverrideFile(ctx, 'SYSTEM.md');
          if (sysFile) {
            files.push({ path: sysFile.path, scope: sysFile.scope, role: 'systemPrompt' });
          } else {
            // --system-prompt flag or a template — no file path available.
            files.push({ path: null, scope: null, role: 'customPrompt' });
          }
        }

        // ── Append system-prompt (APPEND_SYSTEM.md) ───────────────────────
        if (options.appendSystemPrompt) {
          const appendFile = resolveOverrideFile(ctx, 'APPEND_SYSTEM.md');
          if (appendFile) {
            files.push({ path: appendFile.path, scope: appendFile.scope, role: 'appendSystemPrompt' });
          }
        }

        ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ files }));
      } catch (err) {
        ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ error: String(err) }));
      }
    },
  });
}

/**
 * Resolve the global agent directory.
 * Mirrors pi's own resolution order: AGENT_DIR env var → ~/.pi/agent/.
 */
function resolveAgentDir() {
  const envDir = process.env['AGENT_DIR'];
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * Check whether filePath is located under parentDir (canonically).
 */
function isUnderDir(filePath, parentDir) {
  try {
    const norm = path.resolve(filePath);
    const base = path.resolve(parentDir);
    return norm.startsWith(base + path.sep) || norm === base;
  } catch {
    return false;
  }
}

/**
 * Resolve which file (project or global) is the source of a system-prompt
 * override (SYSTEM.md or APPEND_SYSTEM.md).
 *
 * Mirrors pi's own discoverSystemPromptFile() / discoverAppendSystemPromptFile()
 * two-candidate logic:
 *   1. Project .pi/<filename> — only when the project is trusted.
 *   2. Global ~/.pi/agent/<filename> — fallback.
 *
 * Returns { path, scope } or null when neither exists.
 */
function resolveOverrideFile(ctx, filename) {
  // Project candidate (trust-gated).
  if (ctx.isProjectTrusted && ctx.isProjectTrusted() && ctx.cwd) {
    const projectPath = path.join(ctx.cwd, '.pi', filename);
    if (existsSync(projectPath)) {
      return { path: projectPath, scope: 'project' };
    }
  }

  // Global candidate.
  const agentDir = resolveAgentDir();
  const globalPath = path.join(agentDir, filename);
  if (existsSync(globalPath)) {
    return { path: globalPath, scope: 'global' };
  }

  return null;
}

/** Synchronous existence check — wrapped for clarity and to centralise error handling. */
function existsSync(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
