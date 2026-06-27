/**
 * Unit tests for session-parse — the pure session-file parsing and tree
 * ordering helpers (no vscode / fs dependencies).
 */

import { describe, it, expect } from 'vitest';
import {
  SessionMetadataAccumulator,
  parseSessionText,
  filterSessionsToCwds,
  groupSessionsByProject,
  sortSessionsByRecency,
  deriveSessionTitle,
  collapseWhitespace,
  truncateTitle,
  type SessionMetadata,
} from './session-parse';

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, id: 'test-uuid-1234', cwd: '/proj', timestamp: '2026-06-22T10:00:00.000Z', ...extra });

const messageLine = (text: string, role = 'user') =>
  JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });

const assistantLine = (text: string) => messageLine(text, 'assistant');

function meta(cwd: string, timestamp: string, name?: string): SessionMetadata {
  return { sessionPath: `${cwd}/${timestamp}.jsonl`, sessionName: name, sessionId: '', firstUserMessage: undefined, cwd, timestamp, messageCount: 0 };
}

describe('SessionMetadataAccumulator / parseSessionText', () => {
  it('parses the header and counts message lines', () => {
    const text = [header(), messageLine('a'), messageLine('b'), messageLine('c')].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m).not.toBeNull();
    expect(m!.cwd).toBe('/proj');
    expect(m!.timestamp).toBe('2026-06-22T10:00:00.000Z');
    expect(m!.messageCount).toBe(3);
  });

  it('returns null when the first line is not a session header', () => {
    expect(parseSessionText(messageLine('x'), '/p/s.jsonl')).toBeNull();
  });

  it('returns null for a malformed header line', () => {
    expect(parseSessionText('{not json', '/p/s.jsonl')).toBeNull();
  });

  it('does NOT count message text that merely contains the type substring', () => {
    // A user message whose content embeds the literal `"type":"message"` must
    // not inflate the count — the old `includes()` heuristic got this wrong.
    const sneaky = JSON.stringify({ type: 'message', role: 'user', content: 'see {"type":"message"} here' });
    const text = [header(), sneaky].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m!.messageCount).toBe(1); // one real message, not two
  });

  it('ignores non-message entry lines (model_change, etc.)', () => {
    const text = [
      header(),
      JSON.stringify({ type: 'model_change', modelId: 'x' }),
      messageLine('a'),
      JSON.stringify({ type: 'thinking_level_change', level: 'high' }),
    ].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.messageCount).toBe(1);
  });

  it('captures the session name when present', () => {
    const text = [header({ name: 'Refactor auth' }), messageLine('a')].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.sessionName).toBe('Refactor auth');
  });

  it('tolerates blank lines / trailing newline', () => {
    const text = [header(), '', messageLine('a'), ''].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.messageCount).toBe(1);
  });

  it('captures sessionId from the header', () => {
    const text = [header({ id: 'abc-123' }), messageLine('hello')].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.sessionId).toBe('abc-123');
  });

  it('sessionId is empty string when header has no id', () => {
    const text = [header({ id: undefined }), messageLine('hi')].join('\n');
    // header() always injects id; use raw JSON without it
    const noId = JSON.stringify({ type: 'session', version: 3, cwd: '/proj', timestamp: '2026-06-22T10:00:00.000Z' });
    expect(parseSessionText([noId, messageLine('hi')].join('\n'), '/p/s.jsonl')!.sessionId).toBe('');
  });

  it('captures firstUserMessage from content block array', () => {
    const text = [header(), messageLine('What is the answer?')].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.firstUserMessage).toBe('What is the answer?');
  });

  it('captures firstUserMessage when content is a bare string', () => {
    const bare = JSON.stringify({ type: 'message', message: { role: 'user', content: 'bare string content' } });
    const text = [header(), bare].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.firstUserMessage).toBe('bare string content');
  });

  it('ignores assistant messages when capturing firstUserMessage', () => {
    const text = [header(), assistantLine('I am the assistant'), messageLine('user speaks first')].join('\n');
    // assistant line comes first but firstUserMessage should only be from user role
    expect(parseSessionText(text, '/p/s.jsonl')!.firstUserMessage).toBe('user speaks first');
  });

  it('only captures the first user message, not subsequent ones', () => {
    const text = [header(), messageLine('first'), messageLine('second')].join('\n');
    expect(parseSessionText(text, '/p/s.jsonl')!.firstUserMessage).toBe('first');
  });

  it('firstUserMessage is undefined when there are no user messages', () => {
    const text = header();
    expect(parseSessionText(text, '/p/s.jsonl')!.firstUserMessage).toBeUndefined();
  });

  it('tolerates a malformed message line without aborting metadata', () => {
    const text = [header(), '{not valid json', messageLine('valid')].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m).not.toBeNull();
    // messageCount counts both lines that start with {"type":"message"
    expect(m!.messageCount).toBeGreaterThanOrEqual(1);
  });

  it('still captures firstUserMessage after a malformed message line precedes it', () => {
    // A malformed line that starts with {"type":"message" should not prevent
    // capture of the first real user message that follows it.
    const malformed = '{"type":"message" this is not valid json';
    const text = [header(), malformed, messageLine('real user message')].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m).not.toBeNull();
    expect(m!.firstUserMessage).toBe('real user message');
  });

  it('captures firstUserMessage from a later user message when the first has no extractable text', () => {
    // First user message has non-text content (e.g. tool-call only), second has text.
    const noText = JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'tool_use', id: 'x' }] } });
    const text = [header(), noText, messageLine('actual text here')].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m!.firstUserMessage).toBe('actual text here');
  });

  it('captures firstUserMessage from a later user message when the first has an empty content array', () => {
    const emptyContent = JSON.stringify({ type: 'message', message: { role: 'user', content: [] } });
    const text = [header(), emptyContent, messageLine('non-empty')].join('\n');
    const m = parseSessionText(text, '/p/s.jsonl');
    expect(m!.firstUserMessage).toBe('non-empty');
  });
});

describe('filterSessionsToCwds', () => {
  it('keeps only sessions whose cwd is an open workspace folder', () => {
    const sessions = [
      meta('/proj', '2026-06-22T10:00:00.000Z'),
      meta('/other', '2026-06-23T10:00:00.000Z'),
      meta('/proj', '2026-06-21T10:00:00.000Z'),
    ];
    const kept = filterSessionsToCwds(sessions, ['/proj']);
    expect(kept.map((s) => s.cwd)).toEqual(['/proj', '/proj']);
  });

  it('matches any of multiple open folders (multi-root)', () => {
    const sessions = [meta('/a', 't'), meta('/b', 't'), meta('/c', 't')];
    expect(filterSessionsToCwds(sessions, ['/a', '/c']).map((s) => s.cwd)).toEqual(['/a', '/c']);
  });

  it('returns empty when no folders are open', () => {
    expect(filterSessionsToCwds([meta('/proj', 't')], [])).toEqual([]);
  });

  it('requires an exact cwd match (a subdirectory is a different project)', () => {
    expect(filterSessionsToCwds([meta('/proj/sub', 't')], ['/proj'])).toEqual([]);
  });
});

describe('groupSessionsByProject', () => {
  it('groups by cwd and orders the current workspace folders first', () => {
    const sessions = [
      meta('/other', '2026-06-23T10:00:00.000Z'),
      meta('/proj', '2026-06-20T10:00:00.000Z'),
    ];
    const groups = groupSessionsByProject(sessions, ['/proj']);
    expect(groups.map((g) => g.projectPath)).toEqual(['/proj', '/other']);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[1].isCurrent).toBe(false);
  });

  it('orders sessions newest-first within a group', () => {
    const sessions = [
      meta('/proj', '2026-06-20T10:00:00.000Z'),
      meta('/proj', '2026-06-22T10:00:00.000Z'),
      meta('/proj', '2026-06-21T10:00:00.000Z'),
    ];
    const [group] = groupSessionsByProject(sessions, []);
    expect(group.sessions.map((s) => s.timestamp)).toEqual([
      '2026-06-22T10:00:00.000Z',
      '2026-06-21T10:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
    ]);
  });

  it('orders non-current groups by their most recent session', () => {
    const sessions = [
      meta('/a', '2026-06-19T10:00:00.000Z'),
      meta('/b', '2026-06-24T10:00:00.000Z'),
    ];
    const groups = groupSessionsByProject(sessions, []);
    expect(groups.map((g) => g.projectPath)).toEqual(['/b', '/a']);
  });

  it('returns an empty array for no sessions', () => {
    expect(groupSessionsByProject([], ['/proj'])).toEqual([]);
  });
});

describe('sortSessionsByRecency', () => {
  it('returns a new array sorted newest-first', () => {
    const input = [meta('/p', '2026-06-20T10:00:00.000Z'), meta('/p', '2026-06-25T10:00:00.000Z')];
    const out = sortSessionsByRecency(input);
    expect(out).not.toBe(input);
    expect(out.map((s) => s.timestamp)).toEqual(['2026-06-25T10:00:00.000Z', '2026-06-20T10:00:00.000Z']);
  });
});

describe('collapseWhitespace', () => {
  it('collapses runs of spaces', () => {
    expect(collapseWhitespace('a  b   c')).toBe('a b c');
  });

  it('replaces newlines and tabs with a single space', () => {
    expect(collapseWhitespace('line1\nline2\ttab')).toBe('line1 line2 tab');
  });

  it('trims leading and trailing whitespace', () => {
    expect(collapseWhitespace('  hello  ')).toBe('hello');
  });

  it('returns empty string for all-whitespace input', () => {
    expect(collapseWhitespace('   \n\t  ')).toBe('');
  });
});

describe('truncateTitle', () => {
  it('returns the string unchanged when within the limit', () => {
    expect(truncateTitle('short', 60)).toBe('short');
  });

  it('appends ellipsis when truncated', () => {
    const long = 'a'.repeat(70);
    expect(truncateTitle(long, 60)).toMatch(/\u2026$/);
  });

  it('keeps length at most maxLen + 1 (the ellipsis character)', () => {
    const long = 'word '.repeat(20);
    const result = truncateTitle(long, 60);
    // The result is cut + '…' — ensure it's not longer than maxLen+1
    expect([...result].length).toBeLessThanOrEqual(61);
  });

  it('prefers a word boundary cut', () => {
    const s = 'fix the authentication middleware so it validates tokens';
    const result = truncateTitle(s, 40);
    // The character just before the ellipsis should follow a complete word,
    // meaning the original string has a space at that cut position.
    const cutText = result.endsWith('\u2026') ? result.slice(0, -1) : result;
    const posInOriginal = s.indexOf(cutText);
    // Either the result is the full string (no cut needed) or the char after
    // the cut in the original is a space (clean word boundary).
    if (result.endsWith('\u2026')) {
      expect(s[cutText.length]).toBe(' ');
    } else {
      expect(result).toBe(s);
    }
  });

  it('falls back to hard cut when no word boundary is near', () => {
    const s = 'a'.repeat(80);
    const result = truncateTitle(s, 60);
    expect(result.endsWith('\u2026')).toBe(true);
  });
});

describe('deriveSessionTitle', () => {
  const base: Pick<SessionMetadata, 'sessionName' | 'firstUserMessage' | 'sessionPath'> = {
    sessionName: undefined,
    firstUserMessage: undefined,
    sessionPath: '/sessions/2026-06-22T10-00-00_abc-uuid.jsonl',
  };

  it('uses override when provided', () => {
    expect(deriveSessionTitle({ ...base, sessionName: 'Header name' }, 'Override title')).toBe('Override title');
  });

  it('normalizes whitespace in override', () => {
    expect(deriveSessionTitle(base, '  Spaced\n  override  ')).toBe('Spaced override');
  });

  it('falls through to sessionName when no override', () => {
    expect(deriveSessionTitle({ ...base, sessionName: 'Auth refactor' })).toBe('Auth refactor');
  });

  it('normalizes whitespace in sessionName', () => {
    expect(deriveSessionTitle({ ...base, sessionName: 'Auth\n  refactor' })).toBe('Auth refactor');
  });

  it('falls through to firstUserMessage when no name', () => {
    expect(deriveSessionTitle({ ...base, firstUserMessage: 'Fix the login bug' })).toBe('Fix the login bug');
  });

  it('collapses and truncates the firstUserMessage', () => {
    const msg = 'I would like to\n  mirror this repo from my own private gitlab\n  to public github so others can contribute';
    const result = deriveSessionTitle({ ...base, firstUserMessage: msg });
    expect(result).not.toContain('\n');
    expect([...result].length).toBeLessThanOrEqual(61);
  });

  it('falls back to filename basename when firstUserMessage is empty string', () => {
    expect(deriveSessionTitle({ ...base, firstUserMessage: '   ' }))
      .toBe('2026-06-22T10-00-00_abc-uuid');
  });

  it('falls back to filename basename when all fields are absent', () => {
    expect(deriveSessionTitle(base)).toBe('2026-06-22T10-00-00_abc-uuid');
  });

  it('override takes precedence over sessionName and firstUserMessage', () => {
    expect(deriveSessionTitle(
      { ...base, sessionName: 'Name', firstUserMessage: 'Message' },
      'Override',
    )).toBe('Override');
  });
});

