/**
 * skill-blocks — pure helper for presenting pi skill expansions in user
 * messages.
 *
 * When the user invokes a slash-command skill (e.g. `/review-fix-loop`), pi
 * expands it and the expanded `<skill name="…" location="…">…</skill>` block
 * becomes the content of the user turn. Rendered verbatim that floods the chat
 * with the whole SKILL.md. `splitUserMessage` breaks a user message into
 * ordered segments so the UI can render the skill body collapsed while keeping
 * any surrounding plain text intact.
 */

export type UserSegment =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; name: string; body: string };

// Matches a complete <skill …>…</skill> block, capturing the `name` attribute
// and the inner body. `[\s\S]*?` is a non-greedy any-char (incl. newlines) so
// adjacent blocks don't get merged. Tolerant of other/extra attributes and of
// attribute order (only `name` is required for a labelled segment).
const SKILL_BLOCK = /<skill\b[^>]*?\bname="([^"]*)"[^>]*>([\s\S]*?)<\/skill>/g;

/**
 * Split a user message into ordered text / skill segments.
 *
 * - A message with no complete skill block returns a single `text` segment.
 * - An unterminated `<skill …>` (e.g. truncated) is left inside a `text`
 *   segment rather than guessed at.
 * - Leading/trailing whitespace around a skill block is trimmed away so we
 *   don't emit empty text segments, but text *between* blocks is preserved.
 */
export function splitUserMessage(text: string): UserSegment[] {
  const segments: UserSegment[] = [];
  let lastIndex = 0;

  const pushText = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length > 0) segments.push({ kind: 'text', text: trimmed });
  };

  // Reset lastIndex: the regex is module-level and stateful with the /g flag.
  SKILL_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_BLOCK.exec(text)) !== null) {
    pushText(text.slice(lastIndex, match.index));
    segments.push({ kind: 'skill', name: match[1], body: match[2].trim() });
    lastIndex = match.index + match[0].length;
  }
  pushText(text.slice(lastIndex));

  // A message that was nothing but whitespace still renders as one text
  // segment so the bubble isn't dropped entirely.
  if (segments.length === 0) segments.push({ kind: 'text', text });
  return segments;
}
