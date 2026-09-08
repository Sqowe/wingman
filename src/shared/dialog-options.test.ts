/**
 * Unit tests for the shared dialog-payload parser.
 *
 * These rules are consumed by two surfaces (the host's quick pick and the
 * webview's question card), so they are asserted here once rather than twice.
 *
 * Payload shapes are taken from the real sender,
 * `@juicesharp/rpiv-ask-user-question` (`rpc-fallback.ts`):
 *   - `formatOptionLine`  → `"N. Label — Description"`
 *   - `askSingleSelect`   → appends a bare `"N. Type something."` sentinel
 *   - `buildPreviewBlock` → previews folded into the title as
 *                           `--- N. Label preview ---` blocks
 *   - `askMultiSelect`    → question / numbered list / instructions in an
 *                           `input` title, answered with `"1,3"`
 *
 * The invariant that matters most: `raw` is never rewritten. rpiv maps an
 * unrecognised answer to a dismissal, which cancels the whole questionnaire.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_QUICK_PICK_OPTION_CHARS,
  OPTION_DETAIL_SEPARATOR,
  parseMultiSelectTitle,
  parseOption,
  parseQuestionHeader,
  parseTitlePreviews,
  shouldRouteToCard,
  splitTitleBlocks,
} from './dialog-options';

describe('parseOption()', () => {
  it('splits a numbered option into index, label and description', () => {
    const raw = '1. Rewrite for aiohttp — Replace the wrong FastAPI stub with real aiohttp patterns.';
    expect(parseOption(raw)).toEqual({
      raw,
      index: 1,
      label: '1. Rewrite for aiohttp',
      headline: 'Rewrite for aiohttp',
      description: 'Replace the wrong FastAPI stub with real aiohttp patterns.',
    });
  });

  it('keeps a plain option on one line with no description', () => {
    expect(parseOption('Allow')).toEqual({
      raw: 'Allow',
      label: 'Allow',
      headline: 'Allow',
    });
  });

  it('parses the "Type something." sentinel as a numbered option with no description', () => {
    // rpiv appends this row to every single-select list (askSingleSelect).
    expect(parseOption('4. Type something.')).toEqual({
      raw: '4. Type something.',
      index: 4,
      label: '4. Type something.',
      headline: 'Type something.',
    });
  });

  it('reads a multi-digit index', () => {
    expect(parseOption('12. Twelfth — The twelfth one.')).toMatchObject({
      index: 12,
      headline: 'Twelfth',
    });
  });

  it('splits at the FIRST separator when an option contains several', () => {
    // Design doc §6: worst case is cosmetic — text moves to the description.
    const raw = '2. A — B — C';
    expect(parseOption(raw)).toMatchObject({
      raw,
      label: '2. A',
      description: 'B — C',
    });
  });

  it('leaves a bare em dash with no spaces alone', () => {
    // The convention is a SPACED em dash; "range—like" text is not a split.
    const raw = 'Range 1—5';
    expect(parseOption(raw)).toEqual({ raw, label: raw, headline: raw });
  });

  it('does not split when the separator has no headline before it', () => {
    const raw = ' — orphaned description';
    const parsed = parseOption(raw);
    expect(parsed).toMatchObject({ raw, label: raw });
    expect(parsed.description).toBeUndefined();
  });

  it('does not split when the separator has no text after it', () => {
    const raw = '1. Headline — ';
    const parsed = parseOption(raw);
    expect(parsed).toMatchObject({ raw, label: raw });
    expect(parsed.description).toBeUndefined();
  });

  it('preserves raw byte-for-byte even when the display parts are trimmed', () => {
    // The value sent back to pi must survive display-side tidying untouched.
    const raw = '3.   Padded   —   Spaced description.  ';
    const parsed = parseOption(raw);
    expect(parsed.raw).toBe(raw);
    expect(parsed.label).toBe('3.   Padded');
    expect(parsed.description).toBe('Spaced description.');
  });

  it('has no index when the option is not numbered', () => {
    expect(parseOption('Deny & suggest alternative').index).toBeUndefined();
  });
});

describe('shouldRouteToCard()', () => {
  it('routes when any option carries the separator', () => {
    expect(shouldRouteToCard([
      '1. Rewrite for aiohttp — Replace the stub.',
      '2. Type something.',
    ])).toBe(true);
  });

  it('routes when an option exceeds the quick pick row width', () => {
    const long = `1. ${'x'.repeat(MAX_QUICK_PICK_OPTION_CHARS)}`;
    expect(long.length).toBeGreaterThan(MAX_QUICK_PICK_OPTION_CHARS);
    expect(shouldRouteToCard([long])).toBe(true);
  });

  it('keeps the bash-restrictions permission prompt on the quick pick', () => {
    // The product's most frequent dialog: three short labels, answered in a
    // keystroke. A card would make it slower for no gain (design doc §4).
    expect(shouldRouteToCard(['Allow once', 'Deny', 'Deny & suggest alternative'])).toBe(false);
  });

  it('does not route on an option exactly at the threshold', () => {
    expect(shouldRouteToCard(['x'.repeat(MAX_QUICK_PICK_OPTION_CHARS)])).toBe(false);
  });

  it('does not route an empty option list', () => {
    expect(shouldRouteToCard([])).toBe(false);
  });

  it('ignores the title entirely — options alone decide', () => {
    // Reading the title would drag bash-restrictions (multi-line title, short
    // options) into the card. The signature takes no title by construction;
    // this test documents the intent.
    expect(shouldRouteToCard(['Allow once', 'Deny'])).toBe(false);
  });
});

describe('splitTitleBlocks()', () => {
  it('returns a single-block title unchanged', () => {
    expect(splitTitleBlocks('Enter a value')).toEqual({ head: 'Enter a value' });
  });

  it('splits at the first blank line', () => {
    expect(splitTitleBlocks('Bash restriction\n\n  rm -rf build')).toEqual({
      head: 'Bash restriction',
      rest: 'rm -rf build',
    });
  });

  it('keeps every later block in rest', () => {
    const title = ['Question?', '', '1. A — a.', '2. B — b.', '', 'Enter numbers.'].join('\n');
    expect(splitTitleBlocks(title)).toEqual({
      head: 'Question?',
      rest: ['1. A — a.', '2. B — b.', '', 'Enter numbers.'].join('\n'),
    });
  });

  it('treats a whitespace-only line as blank', () => {
    expect(splitTitleBlocks('Head\n   \nTail')).toEqual({ head: 'Head', rest: 'Tail' });
  });

  it('does not split a title that is only a blank line', () => {
    expect(splitTitleBlocks('\n\n')).toEqual({ head: '\n\n' });
  });

  it('does not split when a single newline separates the lines', () => {
    expect(splitTitleBlocks('Line one\nLine two')).toEqual({ head: 'Line one\nLine two' });
  });
});

describe('parseQuestionHeader()', () => {
  it('lifts rpiv\'s bracketed chip off the question', () => {
    expect(parseQuestionHeader('[REST API file] How should I handle it?')).toEqual({
      header: 'REST API file',
      question: 'How should I handle it?',
    });
  });

  it('leaves a question with no chip alone', () => {
    expect(parseQuestionHeader('How should I handle it?')).toEqual({
      question: 'How should I handle it?',
    });
  });

  it('does not treat a bracketed clause spanning lines as a chip', () => {
    const text = '[not\na chip] text';
    expect(parseQuestionHeader(text)).toEqual({ question: text });
  });

  it('does not treat an over-long bracketed prefix as a chip', () => {
    const text = `[${'x'.repeat(61)}] question`;
    expect(parseQuestionHeader(text)).toEqual({ question: text });
  });

  it('does not strip a prefix with no question after it', () => {
    expect(parseQuestionHeader('[only a chip]')).toEqual({ question: '[only a chip]' });
  });
});

describe('parseTitlePreviews()', () => {
  it('returns a title with no previews unchanged', () => {
    expect(parseTitlePreviews('How should I handle it?')).toEqual({
      question: 'How should I handle it?',
      previews: {},
    });
  });

  it('pulls previews back out keyed by option index', () => {
    // Shape from rpiv's buildPreviewBlock.
    const title = [
      '[REST API file] How should I handle it?',
      '',
      '--- 1. Keep the stub preview ---',
      'def handler(request):',
      '    return web.json_response({})',
      '',
      '--- 3. Delete it preview ---',
      '# file removed',
    ].join('\n');

    expect(parseTitlePreviews(title)).toEqual({
      question: '[REST API file] How should I handle it?',
      previews: {
        1: 'def handler(request):\n    return web.json_response({})',
        3: '# file removed',
      },
    });
  });

  it('keys previews to match parseOption().index', () => {
    // The two must agree or a card would attach a preview to the wrong row.
    const options = ['1. Keep — Leave it.', '2. Rewrite — Replace it.'];
    const { previews } = parseTitlePreviews('Q?\n\n--- 2. Rewrite preview ---\nnew code');
    const rewrite = parseOption(options[1]);
    expect(rewrite.index).toBe(2);
    expect(previews[rewrite.index!]).toBe('new code');
  });

  it('is repeatable — the module-scoped /g regex does not carry state', () => {
    const title = 'Q?\n\n--- 1. A preview ---\nbody';
    const first = parseTitlePreviews(title);
    const second = parseTitlePreviews(title);
    expect(second).toEqual(first);
    expect(second.previews[1]).toBe('body');
  });

  it('drops a banner with an empty body', () => {
    expect(parseTitlePreviews('Q?\n\n--- 1. A preview ---\n')).toEqual({
      question: 'Q?',
      previews: {},
    });
  });

  it('keeps the last body when an index is banner-duplicated', () => {
    const title = 'Q?\n\n--- 1. A preview ---\nfirst\n\n--- 1. A preview ---\nsecond';
    expect(parseTitlePreviews(title).previews[1]).toBe('second');
  });

  it('does not mistake a plain dashed rule for a preview banner', () => {
    const title = 'Q?\n\n-----\nnot a preview';
    expect(parseTitlePreviews(title).previews).toEqual({});
  });
});

describe('parseMultiSelectTitle()', () => {
  it('recovers rpiv\'s multiple-choice question from an input title', () => {
    // Shape from rpiv's askMultiSelect.
    const title = [
      '[REST API] Which files should I touch?',
      '',
      '1. Router — Rewrite the routes.',
      '2. Models — Convert the models.',
      '3. Tests — Update the fixtures.',
      '',
      'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.',
    ].join('\n');

    expect(parseMultiSelectTitle(title)).toEqual({
      question: '[REST API] Which files should I touch?',
      options: [
        '1. Router — Rewrite the routes.',
        '2. Models — Convert the models.',
        '3. Tests — Update the fixtures.',
      ],
      instructions:
        'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.',
    });
  });

  it('yields options whose raw strings round-trip through parseOption', () => {
    const title = 'Q?\n\n1. Router — Rewrite.\n2. Models — Convert.\n\nEnter numbers.';
    const parsed = parseMultiSelectTitle(title)!;
    expect(parsed.options.map((o) => parseOption(o).index)).toEqual([1, 2]);
    // The verbatim line is preserved, so a card can display it and still send indices.
    expect(parsed.options[0]).toBe('1. Router — Rewrite.');
  });

  it('returns null for rpiv\'s free-text follow-up', () => {
    // question, blank line, "Type your answer:" — an input box handles this fine.
    expect(parseMultiSelectTitle('[REST API] How should I handle it?\n\nType your answer:')).toBeNull();
  });

  it('returns null for a single-block title', () => {
    expect(parseMultiSelectTitle('Enter a value')).toBeNull();
  });

  it('returns null for the bash-restrictions title', () => {
    expect(parseMultiSelectTitle('Bash restriction\n\n  rm -rf build')).toBeNull();
  });

  it('returns null when only one numbered line is present', () => {
    expect(parseMultiSelectTitle('Q?\n\n1. Only one — sole option.')).toBeNull();
  });

  it('returns null when the block mixes numbered and unnumbered lines', () => {
    expect(parseMultiSelectTitle('Q?\n\n1. A — a.\nnot numbered\n2. B — b.')).toBeNull();
  });

  it('never treats the first block as the option list', () => {
    // A question that happens to be numbered lines is still the question.
    expect(parseMultiSelectTitle('1. A — a.\n2. B — b.\n\nsomething else')).toBeNull();
  });

  it('omits instructions when the list is the final block', () => {
    const parsed = parseMultiSelectTitle('Q?\n\n1. A — a.\n2. B — b.')!;
    expect(parsed.options).toHaveLength(2);
    expect(parsed.instructions).toBeUndefined();
  });

  it('keeps a multi-block question together', () => {
    const parsed = parseMultiSelectTitle('Q?\n\nmore context\n\n1. A — a.\n2. B — b.\n\nEnter numbers.')!;
    expect(parsed.question).toBe('Q?\n\nmore context');
  });
});

describe('module invariants', () => {
  it('uses a spaced em dash as the separator', () => {
    expect(OPTION_DETAIL_SEPARATOR).toBe(' — ');
  });

  it('documents the quick pick row width as a tunable constant', () => {
    expect(MAX_QUICK_PICK_OPTION_CHARS).toBe(90);
  });
});
