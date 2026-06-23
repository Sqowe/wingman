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
  type SessionMetadata,
} from './session-parse';

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', version: 3, cwd: '/proj', timestamp: '2026-06-22T10:00:00.000Z', ...extra });

const messageLine = (text: string) =>
  JSON.stringify({ type: 'message', role: 'user', content: text });

function meta(cwd: string, timestamp: string, name?: string): SessionMetadata {
  return { sessionPath: `${cwd}/${timestamp}.jsonl`, sessionName: name, cwd, timestamp, messageCount: 0 };
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
