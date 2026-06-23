/**
 * Unit tests for splitUserMessage — the pure user-message segmenter that
 * separates pi skill expansions from surrounding text.
 */
import { describe, it, expect } from 'vitest';
import { splitUserMessage } from './skill-blocks';

const skill = (name: string, body: string, attrs = '') =>
  `<skill name="${name}"${attrs ? ' ' + attrs : ''}>${body}</skill>`;

describe('splitUserMessage', () => {
  it('returns a single text segment when there is no skill block', () => {
    expect(splitUserMessage('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('parses a lone skill block, capturing name and trimmed body', () => {
    const out = splitUserMessage(skill('review-fix-loop', '\n# Review-Fix Loop\nbody\n'));
    expect(out).toEqual([{ kind: 'skill', name: 'review-fix-loop', body: '# Review-Fix Loop\nbody' }]);
  });

  it('ignores other attributes and attribute order', () => {
    const raw = '<skill location="/x/SKILL.md" name="foo" version="3">B</skill>';
    expect(splitUserMessage(raw)).toEqual([{ kind: 'skill', name: 'foo', body: 'B' }]);
  });

  it('keeps text before and after a skill block', () => {
    const raw = `please run ${skill('foo', 'BODY')} thanks`;
    expect(splitUserMessage(raw)).toEqual([
      { kind: 'text', text: 'please run' },
      { kind: 'skill', name: 'foo', body: 'BODY' },
      { kind: 'text', text: 'thanks' },
    ]);
  });

  it('handles multiple skill blocks without merging them', () => {
    const raw = `${skill('a', 'AA')}\n${skill('b', 'BB')}`;
    expect(splitUserMessage(raw)).toEqual([
      { kind: 'skill', name: 'a', body: 'AA' },
      { kind: 'skill', name: 'b', body: 'BB' },
    ]);
  });

  it('leaves an unterminated <skill …> as plain text', () => {
    const raw = '<skill name="foo">never closed';
    expect(splitUserMessage(raw)).toEqual([{ kind: 'text', text: raw }]);
  });

  it('is repeatable (regex lastIndex is reset between calls)', () => {
    const raw = skill('foo', 'X');
    const first = splitUserMessage(raw);
    const second = splitUserMessage(raw);
    expect(second).toEqual(first);
  });

  it('does not drop a whitespace-only message', () => {
    expect(splitUserMessage('   ')).toEqual([{ kind: 'text', text: '   ' }]);
  });
});
