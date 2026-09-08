/**
 * Component tests for QuestionCard.
 *
 * These drive the real store rather than stubbing callbacks, so each test proves
 * the whole click → store → outbox path: what the user sees, and what would be
 * sent to pi as a result. The two answer encodings are the point — a single
 * choice must send the option's `raw` byte-for-byte and multiple choice must send
 * bare indices, or the sending extension silently cancels the questionnaire (see
 * the component header and docs/design/in-chat-question-cards.md).
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuestionCard } from './QuestionCard';
import { useChatStore } from '../store';
import type { QuestionCardItem } from '../store';
import type { UiDialogMessage } from '../../../src/shared/messages';

// `acquireVsCodeApi()` only exists inside a real webview, and the card reaches the
// module transitively (via the shared markdown renderer's copy buttons and link
// interception). Delivery itself is covered in store/dialog-outbox.test.tsx; here
// the assertions are on the store queue, so a stub is enough.
vi.mock('../vscodeApi', () => ({
  vscode: { postMessage: vi.fn() },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELECT_DIALOG: UiDialogMessage = {
  type: 'uiDialog',
  id: 'req-1',
  kind: 'select',
  question: 'The file is a FastAPI stub but the API is built on aiohttp. How should I handle it?',
  header: 'REST API file',
  options: [
    {
      raw: '1. Keep the stub — Leave it untouched and document the mismatch.',
      index: 1,
      headline: 'Keep the stub',
      description: 'Leave it untouched and document the mismatch.',
    },
    {
      raw: '2. Rewrite for aiohttp — Replace the FastAPI stub with real aiohttp patterns.',
      index: 2,
      headline: 'Rewrite for aiohttp',
      description: 'Replace the FastAPI stub with real aiohttp patterns.',
      preview: '```python\nasync def handler(request):\n    return web.json_response({})\n```',
    },
    { raw: '3. Type something.', index: 3, headline: 'Type something.' },
  ],
};

const MULTI_DIALOG: UiDialogMessage = {
  type: 'uiDialog',
  id: 'req-2',
  kind: 'multiSelect',
  question: 'Which files should I touch?',
  options: [
    { raw: '1. Router — Rewrite the routes.', index: 1, headline: 'Router', description: 'Rewrite the routes.' },
    { raw: '2. Models — Convert the models.', index: 2, headline: 'Models', description: 'Convert the models.' },
    { raw: '3. Tests — Update the fixtures.', index: 3, headline: 'Tests', description: 'Update the fixtures.' },
  ],
  instructions: 'Enter the numbers of all that apply.',
};

/** Add a card to the store and render it. */
function renderCard(dialog: UiDialogMessage) {
  useChatStore.getState().addQuestionCard(dialog);
  const card = currentCard(dialog.id);
  const view = render(<QuestionCard item={card} />);
  // Re-render with the latest store state after an interaction.
  const rerender = () => view.rerender(<QuestionCard item={currentCard(dialog.id)} />);
  return { ...view, rerender };
}

function currentCard(id: string): QuestionCardItem {
  const found = useChatStore
    .getState()
    .items.find((i): i is QuestionCardItem => i.itemKind === 'question' && i.id === id);
  if (!found) throw new Error(`no question card with id ${id}`);
  return found;
}

const answers = () => useChatStore.getState().pendingDialogAnswers;

beforeEach(() => {
  useChatStore.setState({ items: [], pendingDialogAnswers: [] });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe('QuestionCard — rendering', () => {
  it('shows the question, the chip and every option with its explanation', () => {
    renderCard(SELECT_DIALOG);

    expect(screen.getByText(/FastAPI stub but the API is built on aiohttp/)).toBeInTheDocument();
    expect(screen.getByText('REST API file')).toBeInTheDocument();

    // Full text for every option — the thing a quick pick row could not do.
    expect(screen.getByText('Keep the stub')).toBeInTheDocument();
    expect(screen.getByText('Leave it untouched and document the mismatch.')).toBeInTheDocument();
    expect(screen.getByText('Rewrite for aiohttp')).toBeInTheDocument();
    expect(screen.getByText('Replace the FastAPI stub with real aiohttp patterns.')).toBeInTheDocument();
    expect(screen.getByText('Type something.')).toBeInTheDocument();
  });

  it('numbers rows from the sender\'s own index', () => {
    renderCard(SELECT_DIALOG);
    // The sender talks in option numbers, so the displayed numbering must match.
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    expect(screen.getByText('3.')).toBeInTheDocument();
  });

  it('exposes the card as a labelled group', () => {
    renderCard(SELECT_DIALOG);
    expect(screen.getByRole('group', { name: 'Question: REST API file' })).toBeInTheDocument();
  });

  it('collapses a preview by default and expands it in place', () => {
    renderCard(SELECT_DIALOG);

    const toggle = screen.getByRole('button', { name: /Show preview/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/web\.json_response/)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: /Hide preview/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/web\.json_response/)).toBeInTheDocument();
  });

  it('shows a preview toggle only for options that have one', () => {
    renderCard(SELECT_DIALOG);
    // Only option 2 carries a preview in the fixture.
    expect(screen.getAllByRole('button', { name: /Show preview/ })).toHaveLength(1);
  });

  it('does not render raw HTML from an extension-authored preview', () => {
    // A preview is authored outside the webview, so it goes through the shared
    // markdown renderer's skipHtml guard. Markdown.test.tsx pins that guarantee on
    // the component; this pins that the card actually routes previews through it.
    const { container } = renderCard({
      ...SELECT_DIALOG,
      id: 'req-html',
      options: [
        {
          raw: '1. Risky — Has a preview.',
          index: 1,
          headline: 'Risky',
          description: 'Has a preview.',
          preview: '<img src=x onerror="alert(1)">',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Show preview/ }));

    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });
});

// ── Single choice ────────────────────────────────────────────────────────────

describe('QuestionCard — single choice', () => {
  it('answers with the option\'s raw string on click', () => {
    renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByText('Rewrite for aiohttp'));

    // Byte-for-byte: the sender parses its own encoding back out of this.
    expect(answers()).toEqual([
      { id: 'req-1', value: '2. Rewrite for aiohttp — Replace the FastAPI stub with real aiohttp patterns.' },
    ]);
  });

  it('answers with the sentinel option verbatim', () => {
    renderCard(SELECT_DIALOG);

    // "Type something." is a sentinel: the sender responds with a second `input`
    // request for the free text, so the card must not shortcut it.
    fireEvent.click(screen.getByText('Type something.'));

    expect(answers()).toEqual([{ id: 'req-1', value: '3. Type something.' }]);
  });

  it('cannot be answered twice', () => {
    const { rerender } = renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByText('Keep the stub'));
    rerender();

    // The options are gone once answered, so a second answer is unreachable.
    expect(screen.queryByText('Rewrite for aiohttp')).not.toBeInTheDocument();
    expect(answers()).toHaveLength(1);
  });

  it('offers no Submit button — a click is the answer', () => {
    renderCard(SELECT_DIALOG);
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
  });
});

// ── Multiple choice ──────────────────────────────────────────────────────────

describe('QuestionCard — multiple choice', () => {
  it('renders checkboxes and the sender\'s instructions', () => {
    renderCard(MULTI_DIALOG);

    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('Enter the numbers of all that apply.')).toBeInTheDocument();
  });

  it('accumulates ticks and submits bare comma-separated indices', () => {
    const { rerender } = renderCard(MULTI_DIALOG);

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    rerender();
    fireEvent.click(boxes[2]);
    rerender();

    // Ticks are visible before submitting — nothing is sent yet.
    expect(answers()).toHaveLength(0);
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    expect(screen.getAllByRole('checkbox')[2]).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));

    // Indices, never labels: one unparseable token makes the sender keep the
    // entire reply as free text.
    expect(answers()).toEqual([{ id: 'req-2', value: '1,3' }]);
  });

  it('unticks an option', () => {
    const { rerender } = renderCard(MULTI_DIALOG);

    const box = screen.getAllByRole('checkbox')[1];
    fireEvent.click(box);
    rerender();
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked();

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    rerender();
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
  });

  it('shows the running count on the Submit button', () => {
    const { rerender } = renderCard(MULTI_DIALOG);

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    rerender();

    expect(screen.getByRole('button', { name: 'Submit (1)' })).toBeInTheDocument();
  });

  it('submits an empty answer when nothing is ticked', () => {
    renderCard(MULTI_DIALOG);

    // Enabled on purpose: the sender reads an empty reply as "none of these".
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(answers()).toEqual([{ id: 'req-2', value: '' }]);
  });

  it('disables an option the sender did not number', () => {
    // Without an index there is no token that identifies the option, so it can be
    // shown but not selected.
    renderCard({
      ...MULTI_DIALOG,
      id: 'req-3',
      options: [
        { raw: '1. Router — Rewrite.', index: 1, headline: 'Router', description: 'Rewrite.' },
        { raw: 'Unnumbered — No index.', headline: 'Unnumbered', description: 'No index.' },
      ],
    });

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeEnabled();
    expect(boxes[1]).toBeDisabled();
  });
});

// ── Dismissal ────────────────────────────────────────────────────────────────

describe('QuestionCard — dismissal', () => {
  it('sends a cancellation from the Dismiss button', () => {
    renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(answers()).toEqual([{ id: 'req-1', cancelled: true }]);
  });

  it('offers Dismiss on a multiple-choice card too', () => {
    renderCard(MULTI_DIALOG);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(answers()).toEqual([{ id: 'req-2', cancelled: true }]);
  });
});

// ── The settled record ───────────────────────────────────────────────────────

describe('QuestionCard — settled record', () => {
  it('keeps the question and the chosen row, hiding the rest', () => {
    const { rerender } = renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByText('Rewrite for aiohttp'));
    rerender();

    // The question stays for context; the chosen option is marked.
    expect(screen.getByText(/FastAPI stub but the API is built on aiohttp/)).toBeInTheDocument();
    expect(screen.getByText('Rewrite for aiohttp')).toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeInTheDocument();
    // The unchosen options are collapsed away.
    expect(screen.queryByText('Keep the stub')).not.toBeInTheDocument();
  });

  it('reveals the other options on request', () => {
    const { rerender } = renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByText('Rewrite for aiohttp'));
    rerender();

    const more = screen.getByRole('button', { name: /Show all options/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(more);
    rerender();

    expect(screen.getByText('Keep the stub')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide other options/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('marks every chosen row on a multiple-choice card', () => {
    const { rerender } = renderCard(MULTI_DIALOG);

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    rerender();
    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    rerender();
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    rerender();

    expect(screen.getByText('Router')).toBeInTheDocument();
    expect(screen.getByText('Tests')).toBeInTheDocument();
    expect(screen.queryByText('Models')).not.toBeInTheDocument();
    // No live controls remain.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('says so when a multiple choice was submitted empty', () => {
    const { rerender } = renderCard(MULTI_DIALOG);

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    rerender();

    expect(screen.getByText('No options were selected.')).toBeInTheDocument();
  });

  it('records a dismissal', () => {
    const { rerender } = renderCard(SELECT_DIALOG);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender();

    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('explains a card the host withdrew', () => {
    const { rerender } = renderCard(SELECT_DIALOG);

    useChatStore.getState().withdrawQuestionCard('req-1', 'timeout');
    rerender();

    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('This question expired before it was answered.')).toBeInTheDocument();
    // Nothing was sent: the host had already answered pi.
    expect(answers()).toHaveLength(0);
    // And there is nothing left to click.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('names the reason for a session-reset withdrawal', () => {
    const { rerender } = renderCard(SELECT_DIALOG);
    useChatStore.getState().withdrawQuestionCard('req-1', 'sessionReset');
    rerender();
    expect(
      screen.getByText('This question was cancelled when the session was replaced.'),
    ).toBeInTheDocument();
  });

  it('names the reason for an agent-stopped withdrawal', () => {
    const { rerender } = renderCard(SELECT_DIALOG);
    useChatStore.getState().withdrawQuestionCard('req-1', 'agentStopped');
    rerender();
    expect(
      screen.getByText('This question was cancelled because the agent stopped.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('does not offer to expand when there is nothing more to show', () => {
    // A single-option card has no "other options" to reveal.
    const { rerender } = renderCard({
      ...SELECT_DIALOG,
      id: 'req-4',
      options: [{ raw: '1. Only — The only one.', index: 1, headline: 'Only', description: 'The only one.' }],
    });

    fireEvent.click(screen.getByText('Only'));
    rerender();

    expect(screen.queryByRole('button', { name: /Show all options/ })).not.toBeInTheDocument();
  });
});

// ── Two cards at once ────────────────────────────────────────────────────────

describe('QuestionCard — queued questions', () => {
  it('answers each card independently', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);

    const { container } = render(
      <>
        <QuestionCard item={currentCard('req-1')} />
        <QuestionCard item={currentCard('req-2')} />
      </>,
    );

    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>('.question-card'),
    );

    fireEvent.click(within(first).getByText('Keep the stub'));
    fireEvent.click(within(second).getByRole('button', { name: 'Dismiss' }));

    expect(answers()).toEqual([
      { id: 'req-1', value: '1. Keep the stub — Leave it untouched and document the mismatch.' },
      { id: 'req-2', cancelled: true },
    ]);
  });
});
