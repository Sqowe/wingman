/**
 * session-parse — pure (vscode-free) helpers for reading pi session files and
 * ordering them for the tree view. Kept dependency-free so the parsing and
 * grouping logic is unit-testable without mocking the filesystem or VS Code.
 */

import * as path from 'path';

export interface SessionMetadata {
  sessionPath: string;
  sessionName: string | undefined;
  /** UUID from the session header — stable key for the title index. */
  sessionId: string;
  /** Raw text of the first user message, if present. */
  firstUserMessage: string | undefined;
  cwd: string;
  timestamp: string;
  messageCount: number;
}

interface SessionHeader {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
  name?: string;
}

/**
 * Streaming accumulator for one session file's metadata.
 *
 * Feed each JSONL line via `addLine()`, then call `finalize()`. The first
 * non-blank line must be the `{"type":"session"}` header, otherwise the file
 * is treated as not-a-session and `finalize()` returns null.
 *
 * Message counting uses a `startsWith('{"type":"message"')` check on the
 * compact JSON pi writes (where `type` is the first key) rather than a
 * substring scan, so message *text* that happens to contain the literal
 * `"type":"message"` does not inflate the count.
 */
export class SessionMetadataAccumulator {
  private _header: SessionHeader | null = null;
  private _messageCount = 0;
  private _seenFirst = false;
  private _invalid = false;
  private _firstUserMessage: string | undefined = undefined;
  private _gotFirstUser = false;

  addLine(rawLine: string): void {
    if (this._invalid) return;
    const line = rawLine.trim();
    if (line === '') return; // skip blank lines (incl. a trailing newline)

    if (!this._seenFirst) {
      this._seenFirst = true;
      try {
        const header = JSON.parse(line) as SessionHeader;
        if (header.type !== 'session') {
          this._invalid = true;
          return;
        }
        this._header = header;
      } catch {
        this._invalid = true;
      }
      return;
    }

    if (line.startsWith('{"type":"message"')) {
      this._messageCount++;

      // Capture the first user message text (parse once, then skip).
      if (!this._gotFirstUser) {
        try {
          const msg = JSON.parse(line) as {
            type: string;
            message?: { role?: string; content?: unknown };
            // Some older records use top-level role/content directly
            role?: string;
            content?: unknown;
          };
          // Normalise: pi v3 wraps in `message`, older records are flat.
          const role = msg.message?.role ?? msg.role;
          const content = msg.message?.content ?? msg.content;
          if (role === 'user') {
            let extracted: string | undefined;
            if (typeof content === 'string' && content.length > 0) {
              extracted = content;
            } else if (Array.isArray(content)) {
              // content block array — find first text block
              for (const block of content) {
                if (
                  block &&
                  typeof block === 'object' &&
                  (block as Record<string, unknown>).type === 'text'
                ) {
                  const text = (block as Record<string, unknown>).text;
                  if (typeof text === 'string' && text.length > 0) {
                    extracted = text;
                    break;
                  }
                }
              }
            }
            if (extracted !== undefined) {
              // Successfully extracted text — stop scanning.
              this._gotFirstUser = true;
              this._firstUserMessage = extracted;
            }
            // If content had no extractable text (e.g. tool-call only, empty
            // array), don't set _gotFirstUser — keep scanning later messages.
          }
        } catch {
          // Malformed line — skip this line but keep scanning subsequent
          // lines for a valid first user message. Do NOT set _gotFirstUser.
        }
      }
    }
  }

  finalize(sessionPath: string): SessionMetadata | null {
    if (this._invalid || !this._header) return null;
    return {
      sessionPath,
      sessionName: this._header.name,
      sessionId: this._header.id ?? '',
      firstUserMessage: this._firstUserMessage,
      cwd: this._header.cwd ?? '',
      timestamp: this._header.timestamp ?? '',
      messageCount: this._messageCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Title derivation helpers (pure, no I/O)
// ---------------------------------------------------------------------------

/** Replace runs of whitespace / newlines with a single space and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate `s` to at most `maxLen` Unicode code points. If truncation occurs,
 * append `…`. Tries to break on a word boundary (last space before the limit).
 * Operating on code points (via Array.from) avoids splitting surrogate pairs.
 */
export function truncateTitle(s: string, maxLen = 60): string {
  const codePoints = Array.from(s);
  if (codePoints.length <= maxLen) return s;
  // Try to cut at a word boundary within the last 15 code points of the limit.
  const candidate = codePoints.slice(0, maxLen).join('');
  const boundary = candidate.lastIndexOf(' ');
  const cut = boundary > maxLen - 15 ? boundary : maxLen;
  return codePoints.slice(0, cut).join('').trimEnd() + '\u2026'; // …
}

/**
 * Derive a human-readable session title using the precedence chain:
 *   override (index / manual) → pi header `name` → first user message → filename.
 */
export function deriveSessionTitle(
  m: Pick<SessionMetadata, 'sessionName' | 'firstUserMessage' | 'sessionPath'>,
  override?: string,
): string {
  // Normalise helper: collapse whitespace + truncate, return undefined if empty.
  const normalise = (s: string | undefined): string | undefined => {
    if (!s) return undefined;
    const collapsed = collapseWhitespace(s);
    return collapsed ? truncateTitle(collapsed) : undefined;
  };

  return (
    normalise(override) ??
    normalise(m.sessionName) ??
    normalise(m.firstUserMessage) ??
    path.basename(m.sessionPath, '.jsonl')
  );
}

// ---------------------------------------------------------------------------

/** Convenience wrapper: build metadata from a whole file's text (used in tests). */
export function parseSessionText(text: string, sessionPath: string): SessionMetadata | null {
  const acc = new SessionMetadataAccumulator();
  for (const line of text.split('\n')) acc.addLine(line);
  return acc.finalize(sessionPath);
}

/**
 * Keep only sessions whose `cwd` is one of the open workspace folders.
 *
 * pi runs as a single child process pinned to the workspace folder, and
 * `switch_session` only loads a different transcript — it does not re-root the
 * agent. Resuming a session recorded in another directory would therefore load
 * its history but operate against the *current* workspace, which is incoherent.
 * Scoping the list to the open folder(s) hides everything that can't be
 * resumed here. Returns a new array.
 */
export function filterSessionsToCwds(
  sessions: SessionMetadata[],
  currentCwds: string[],
): SessionMetadata[] {
  const current = new Set(currentCwds);
  return sessions.filter((s) => current.has(s.cwd));
}

export interface ProjectGroup {
  projectPath: string;
  sessions: SessionMetadata[];
  /** True when this project is one of the open workspace folders. */
  isCurrent: boolean;
}

/**
 * Group sessions by working directory, newest session first within each group.
 * Groups whose path is one of `currentCwds` (the open workspace folders) are
 * flagged `isCurrent` and sorted first; the rest follow, ordered by their most
 * recent session. ISO-8601 timestamps sort correctly with a plain string
 * compare.
 */
export function groupSessionsByProject(
  sessions: SessionMetadata[],
  currentCwds: string[],
): ProjectGroup[] {
  const current = new Set(currentCwds);
  const byPath = new Map<string, SessionMetadata[]>();
  for (const s of sessions) {
    const list = byPath.get(s.cwd);
    if (list) list.push(s);
    else byPath.set(s.cwd, [s]);
  }

  const groups: ProjectGroup[] = [];
  for (const [projectPath, list] of byPath) {
    list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    groups.push({ projectPath, sessions: list, isCurrent: current.has(projectPath) });
  }

  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aT = a.sessions[0]?.timestamp ?? '';
    const bT = b.sessions[0]?.timestamp ?? '';
    return bT.localeCompare(aT);
  });
  return groups;
}

/** Sort a flat session list newest-first (returns a new array). */
export function sortSessionsByRecency(sessions: SessionMetadata[]): SessionMetadata[] {
  return [...sessions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
