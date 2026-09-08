/**
 * Contract tests for the question-card message types.
 *
 * `messages.ts` is types only, so there is no behaviour to exercise directly.
 * What is worth testing is the *seam*: `UiDialogOption` is derived from
 * `ParsedOption`, and a card is built by feeding real pi payloads through the
 * parsers in `dialog-options.ts`. These tests assemble the messages the way the
 * host will in Stage 3 and assert the result type-checks and carries the values
 * the sender needs back.
 *
 * A plain `tsc` pass would catch a structural mismatch, but not a *semantic*
 * one: putting `label` where `headline` belongs, or a display string where
 * `raw` belongs, both compile. Those are the mistakes that silently cancel a
 * questionnaire, so they are asserted on values here.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMultiSelectTitle,
  parseOption,
  parseQuestionHeader,
  parseTitlePreviews,
} from './dialog-options';
import type {
  UiDialogAnswerMessage,
  UiDialogCancelMessage,
  UiDialogMessage,
  UiDialogOption,
} from './messages';

// ─── Fixtures: real payload shapes from rpiv's rpc-fallback.ts ────────────────

/** A single-choice `select` with per-option previews folded into the title. */
const SELECT_TITLE = [
  '[REST API file] The file is a FastAPI stub but the API is built on aiohttp. How should I handle it?',
  '',
  '--- 2. Rewrite for aiohttp preview ---',
  'async def handler(request):',
  '    return web.json_response({})',
].join('\n');

const SELECT_OPTIONS = [
  '1. Keep the stub — Leave it untouched and document the mismatch.',
  '2. Rewrite for aiohttp — Replace the FastAPI stub with real aiohttp patterns.',
  '3. Type something.',
];

/** rpiv's multiple choice: an `input` whose title carries the whole list. */
const MULTI_TITLE = [
  '[REST API] Which files should I touch?',
  '',
  '1. Router — Rewrite the routes.',
  '2. Models — Convert the models.',
  '3. Tests — Update the fixtures.',
  '',
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.',
].join('\n');

// ─── Builders: what the host will do in Stage 3 ──────────────────────────────

/** Assemble a single-choice card from a `select` request's title + options. */
function buildSelectCard(id: string, title: string, options: readonly string[]): UiDialogMessage {
  const { question: withoutPreviews, previews } = parseTitlePreviews(title);
  const { header, question } = parseQuestionHeader(withoutPreviews);

  return {
    type: 'uiDialog',
    id,
    kind: 'select',
    question,
    ...(header !== undefined ? { header } : {}),
    options: options.map((raw) => toDialogOption(raw, previews)),
  };
}

/** Assemble a multiple-choice card from an `input` request's title. */
function buildMultiSelectCard(id: string, title: string): UiDialogMessage | null {
  const parsed = parseMultiSelectTitle(title);
  if (!parsed) return null;
  const { header, question } = parseQuestionHeader(parsed.question);

  return {
    type: 'uiDialog',
    id,
    kind: 'multiSelect',
    question,
    ...(header !== undefined ? { header } : {}),
    options: parsed.options.map((raw) => toDialogOption(raw, {})),
    ...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
  };
}

/**
 * Map a parsed option onto the wire shape. `label` is dropped (it keeps the
 * `"N. "` prefix for a quick pick row); the preview is attached by index.
 */
function toDialogOption(raw: string, previews: Record<number, string>): UiDialogOption {
  const { label: _label, ...rest } = parseOption(raw);
  const preview = rest.index !== undefined ? previews[rest.index] : undefined;
  return { ...rest, ...(preview !== undefined ? { preview } : {}) };
}

/**
 * Build a multiple-choice card, failing with a readable message rather than a
 * TypeError if `parseMultiSelectTitle` ever stops recognising the shape.
 * Shared by the card and answer suites so the fixture is parsed once.
 */
function requireMultiSelectCard(id: string, title: string): UiDialogMessage {
  const card = buildMultiSelectCard(id, title);
  expect(card, 'expected the title to parse as a multiple-choice question').not.toBeNull();
  return card!;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UiDialogMessage — single choice', () => {
  const card = buildSelectCard('req-1', SELECT_TITLE, SELECT_OPTIONS);

  it('carries the question with the chip and previews lifted out', () => {
    expect(card.kind).toBe('select');
    expect(card.header).toBe('REST API file');
    expect(card.question).toBe(
      'The file is a FastAPI stub but the API is built on aiohttp. How should I handle it?',
    );
    // Neither the chip nor a preview banner may leak into the rendered question.
    expect(card.question).not.toContain('[REST API file]');
    expect(card.question).not.toContain('preview ---');
  });

  it('keeps every option raw byte-for-byte', () => {
    // The single invariant that must never break: rpiv reads the leading index
    // back out and treats an unrecognised value as a dismissal.
    expect(card.options.map((o) => o.raw)).toEqual(SELECT_OPTIONS);
  });

  it('exposes headline and description separately for wrapping display', () => {
    expect(card.options[0]).toMatchObject({
      index: 1,
      headline: 'Keep the stub',
      description: 'Leave it untouched and document the mismatch.',
    });
  });

  it('has no label field — that shape is the quick pick\'s, not the card\'s', () => {
    // Omit<ParsedOption, 'label'> is a compile-time guarantee; assert it on the
    // value too, so a hand-built message cannot reintroduce the prefixed form.
    expect(card.options[0]).not.toHaveProperty('label');
    expect(card.options[0].headline).not.toMatch(/^\d+\./);
  });

  it('attaches a preview to the option its banner named', () => {
    expect(card.options[1].preview).toBe(
      'async def handler(request):\n    return web.json_response({})',
    );
    // ...and only to that one.
    expect(card.options[0].preview).toBeUndefined();
    expect(card.options[2].preview).toBeUndefined();
  });

  it('carries the "Type something." sentinel through as an ordinary option', () => {
    // The card must offer it and return it verbatim: rpiv answers it with a
    // second `input` request, so the card cannot shortcut the round trip.
    const sentinel = card.options[2];
    expect(sentinel.raw).toBe('3. Type something.');
    expect(sentinel.headline).toBe('Type something.');
    expect(sentinel.description).toBeUndefined();
  });

  it('omits header when the sender sent no chip prefix', () => {
    // Not every sender prefixes a chip, and `header` is optional on the wire —
    // the field must be absent rather than an empty string, or the card would
    // render a blank chip.
    const plain = buildSelectCard('req-4', 'Which approach should I take?', [
      '1. Rewrite — Replace it.',
      '2. Keep — Leave it.',
    ]);
    expect(plain.header).toBeUndefined();
    expect(plain).not.toHaveProperty('header');
    expect(plain.question).toBe('Which approach should I take?');
  });

  it('handles an option list with no numbering', () => {
    // A sender that does not number its options still produces a valid card;
    // the rows simply carry no index (so a multiSelect answer is not possible).
    const unnumbered = buildSelectCard('req-5', 'Pick one', [
      'Allow — Permit the command.',
      'Deny — Refuse it.',
    ]);
    expect(unnumbered.options.map((o) => o.index)).toEqual([undefined, undefined]);
    expect(unnumbered.options[0].raw).toBe('Allow — Permit the command.');
  });

  it('produces an empty option list rather than throwing when pi sends none', () => {
    // Defensive boundary: a `select` with no options is degenerate, but must not
    // crash the assembly path — the host still has to answer the request.
    const empty = buildSelectCard('req-6', 'Nothing to choose', []);
    expect(empty.options).toEqual([]);
    expect(empty.question).toBe('Nothing to choose');
  });
});

describe('UiDialogMessage — multiple choice', () => {
  const card = requireMultiSelectCard('req-2', MULTI_TITLE);

  it('recovers the question, options and instructions from the input title', () => {
    expect(card.kind).toBe('multiSelect');
    expect(card.header).toBe('REST API');
    expect(card.question).toBe('Which files should I touch?');
    expect(card.options).toHaveLength(3);
    expect(card.instructions).toContain('comma-separated');
  });

  it('numbers its options so an indices answer can be built', () => {
    // The answer is indices, so every option must carry one.
    expect(card.options.map((o) => o.index)).toEqual([1, 2, 3]);
  });

  it('returns null for a title that is not a multiple-choice list', () => {
    // rpiv's free-text follow-up — an input box handles this fine.
    expect(buildMultiSelectCard('req-3', 'How should I handle it?\n\nType your answer:')).toBeNull();
  });
});

describe('UiDialogAnswerMessage', () => {
  it('answers a single choice with the option\'s raw string', () => {
    const card = buildSelectCard('req-1', SELECT_TITLE, SELECT_OPTIONS);
    const chosen = card.options[1];
    const answer: UiDialogAnswerMessage = {
      type: 'uiDialogAnswer',
      id: card.id,
      value: chosen.raw,
    };

    expect(answer).toEqual({
      type: 'uiDialogAnswer',
      id: 'req-1',
      value: '2. Rewrite for aiohttp — Replace the FastAPI stub with real aiohttp patterns.',
    });
    // Not the headline, and not the description — the whole original line.
    expect('value' in answer && answer.value).toBe(SELECT_OPTIONS[1]);
  });

  it('answers a multiple choice with bare comma-separated indices', () => {
    const card = requireMultiSelectCard('req-2', MULTI_TITLE);
    const picked = [card.options[0], card.options[2]];
    const answer: UiDialogAnswerMessage = {
      type: 'uiDialogAnswer',
      id: card.id,
      value: picked.map((o) => o.index).join(','),
    };

    // rpiv requires every token to parse as an in-range index; a label anywhere
    // in here makes it keep the entire reply as free text instead.
    expect('value' in answer && answer.value).toBe('1,3');
  });

  it('expresses "none selected" as an empty value', () => {
    const answer: UiDialogAnswerMessage = { type: 'uiDialogAnswer', id: 'req-2', value: '' };
    expect('value' in answer && answer.value).toBe('');
  });

  it('expresses dismissal without a value', () => {
    const answer: UiDialogAnswerMessage = { type: 'uiDialogAnswer', id: 'req-1', cancelled: true };
    expect(answer).toEqual({ type: 'uiDialogAnswer', id: 'req-1', cancelled: true });
    expect('value' in answer).toBe(false);
  });

  it('is a discriminated union — value and cancelled never coexist', () => {
    // Narrowing must work on the presence of `cancelled`, because the host
    // branches on it to choose between `value` and `cancelled: true` on the wire.
    const answers: UiDialogAnswerMessage[] = [
      { type: 'uiDialogAnswer', id: 'a', value: 'x' },
      { type: 'uiDialogAnswer', id: 'b', cancelled: true },
    ];
    const described = answers.map((a) => ('cancelled' in a ? 'cancelled' : a.value));
    expect(described).toEqual(['x', 'cancelled']);
  });
});

describe('UiDialogCancelMessage', () => {
  it('names why the card was withdrawn', () => {
    const reasons: Array<UiDialogCancelMessage['reason']> = [
      'timeout',
      'sessionReset',
      'agentStopped',
    ];
    for (const reason of reasons) {
      const msg: UiDialogCancelMessage = { type: 'uiDialogCancel', id: 'req-1', reason };
      expect(msg.reason).toBe(reason);
    }
  });
});
