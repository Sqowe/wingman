/**
 * slash-commands — pure helpers for the slash-command autocomplete menu.
 *
 * Extracted from Composer.tsx so they can be unit-tested without a DOM / jsdom.
 */
import type { PiCommand } from '@shared/messages';

/**
 * Given the current textarea value, return the slash prefix to filter by, or
 * null when the menu should be closed.
 *
 * Rules:
 * - Open only when the *entire* input is a bare slash token with no whitespace,
 *   e.g. "/", "/sk", "/skill:review".
 * - Once the user has selected a command and the value becomes "/name " (trailing
 *   space) or "/name arg", the menu stays closed — they are now typing arguments.
 */
export function slashFilterFromValue(value: string): string | null {
  const match = /^(\/\S*)$/.exec(value);
  return match ? match[1] : null;
}

/**
 * Filter the full command list down to entries whose name starts with the
 * given prefix (case-insensitive). Returns an empty array when prefix is null.
 * Built-in TUI commands (`builtIn: true`) are excluded — they are inert over
 * RPC and must never appear in the autocomplete menu.
 */
export function filterCommands(
  commands: PiCommand[],
  prefix: string | null,
): PiCommand[] {
  if (prefix === null) return [];
  const lower = prefix.toLowerCase();
  return commands.filter(
    (c) => !c.builtIn && c.name.toLowerCase().startsWith(lower),
  );
}

/**
 * Build the string to insert into the textarea when the user selects a command.
 * Always appends a trailing space so the cursor lands ready to type arguments.
 */
export function buildInsertedText(cmd: PiCommand): string {
  return `${cmd.name} `;
}

/**
 * Returns true when the given prompt text is a slash command invocation
 * whose first token matches a known non-builtIn command from the provided
 * list. Falls back to the heuristic `/^\/#\S/` when no command list is
 * available (e.g. before get_commands completes).
 *
 * Passing the known commands list avoids false positives on absolute paths
 * like '/usr/local/bin' or any other slash-prefixed text that happens not to
 * be a registered command.
 */
export function isSlashCommand(text: string, commands?: PiCommand[]): boolean {
  if (!text.startsWith('/')) return false;
  const token = text.split(/\s/)[0];
  if (!token || token.length < 2) return false;
  if (commands !== undefined) {
    // Command-aware: only match known non-builtIn commands.
    // An empty list means no commands are loaded yet — return false rather
    // than falling back to the heuristic, to avoid false positives on paths.
    const lower = token.toLowerCase();
    return commands.some((c) => !c.builtIn && c.name.toLowerCase() === lower);
  }
  // Heuristic fallback when no list is available at all (commands === undefined).
  return /^\/\S/.test(text);
}

