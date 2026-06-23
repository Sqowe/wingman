/**
 * session-parse — pure (vscode-free) helpers for reading pi session files and
 * ordering them for the tree view. Kept dependency-free so the parsing and
 * grouping logic is unit-testable without mocking the filesystem or VS Code.
 */

export interface SessionMetadata {
  sessionPath: string;
  sessionName: string | undefined;
  cwd: string;
  timestamp: string;
  messageCount: number;
}

interface SessionHeader {
  type?: string;
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
    }
  }

  finalize(sessionPath: string): SessionMetadata | null {
    if (this._invalid || !this._header) return null;
    return {
      sessionPath,
      sessionName: this._header.name,
      cwd: this._header.cwd ?? '',
      timestamp: this._header.timestamp ?? '',
      messageCount: this._messageCount,
    };
  }
}

/** Convenience wrapper: build metadata from a whole file's text (used in tests). */
export function parseSessionText(text: string, sessionPath: string): SessionMetadata | null {
  const acc = new SessionMetadataAccumulator();
  for (const line of text.split('\n')) acc.addLine(line);
  return acc.finalize(sessionPath);
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
