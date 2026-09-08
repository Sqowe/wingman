/**
 * Delivery tests for the question-card outbox.
 *
 * The store deliberately does not call `postMessage` — it queues answers and
 * `useDialogOutbox` drains them. That split keeps the reducer pure, but it means
 * the store tests prove only that an answer was *queued*. pi is blocked on the
 * request, so these assert the other half: a queued answer actually reaches the
 * host, exactly once, in the shape the host validator expects.
 *
 * The real hook is imported and mounted in a bare harness component. Rendering
 * App itself would pull in react-window, markdown and the whole message list for
 * no added coverage; re-implementing the effect here would test a copy and drift
 * from the real one.
 */
import { render, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './index';
import { useDialogOutbox } from './useDialogOutbox';
import { vscode } from '../vscodeApi';
import type { UiDialogMessage } from '../../../src/shared/messages';

// ── vscode bridge stub ───────────────────────────────────────────────────────
// vi.mock is hoisted above the imports, so `vscode` above resolves to this stub.

vi.mock('../vscodeApi', () => ({
  vscode: { postMessage: vi.fn() },
}));

/** The mocked postMessage, typed for assertions. */
const postMessage = vscode.postMessage as unknown as ReturnType<typeof vi.fn>;

/** Bare harness: mounts the real hook and renders nothing. */
function OutboxHarness() {
  useDialogOutbox();
  return null;
}

const DIALOG: UiDialogMessage = {
  type: 'uiDialog',
  id: 'req-1',
  kind: 'select',
  question: 'How should I handle it?',
  options: [
    { raw: '1. Keep — Leave it.', index: 1, headline: 'Keep', description: 'Leave it.' },
    { raw: '2. Rewrite — Replace it.', index: 2, headline: 'Rewrite', description: 'Replace it.' },
  ],
};

const MULTI: UiDialogMessage = {
  type: 'uiDialog',
  id: 'req-2',
  kind: 'multiSelect',
  question: 'Which files?',
  options: [
    { raw: '1. Router — Rewrite.', index: 1, headline: 'Router', description: 'Rewrite.' },
    { raw: '2. Models — Convert.', index: 2, headline: 'Models', description: 'Convert.' },
  ],
};

beforeEach(() => {
  postMessage.mockClear();
  useChatStore.setState({ items: [], pendingDialogAnswers: [] });
});

describe('question-card outbox delivery', () => {
  it('posts a single-choice answer verbatim and drains the queue', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().answerQuestionCard('req-1', '2. Rewrite — Replace it.');
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'uiDialogAnswer',
      id: 'req-1',
      value: '2. Rewrite — Replace it.',
    });
    expect(useChatStore.getState().pendingDialogAnswers).toHaveLength(0);
  });

  it('posts a dismissal as cancelled with no value', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().dismissQuestionCard('req-1');
    });

    // The host validator rejects an answer carrying both fields, so `value` must
    // be absent rather than empty.
    expect(postMessage).toHaveBeenCalledWith({
      type: 'uiDialogAnswer',
      id: 'req-1',
      cancelled: true,
    });
  });

  it('posts multi-select indices', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(MULTI);
      useChatStore.getState().toggleQuestionOption('req-2', 1);
      useChatStore.getState().toggleQuestionOption('req-2', 2);
      useChatStore.getState().submitQuestionSelection('req-2');
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'uiDialogAnswer',
      id: 'req-2',
      value: '1,2',
    });
  });

  it('posts exactly once when a card is answered twice', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
      useChatStore.getState().answerQuestionCard('req-1', '2. Rewrite — Replace it.');
    });

    // pi accepts one response per request.
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not re-post after an unrelated store update', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // A later render must not resend a flushed answer.
    act(() => {
      useChatStore.getState().addUserMessage('something else');
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers answers for two cards settled in one update', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().addQuestionCard(MULTI);
      useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
      useChatStore.getState().dismissQuestionCard('req-2');
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      type: 'uiDialogAnswer',
      id: 'req-1',
      value: '1. Keep — Leave it.',
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      type: 'uiDialogAnswer',
      id: 'req-2',
      cancelled: true,
    });
  });

  it('sends nothing for a host-withdrawn card', () => {
    render(<OutboxHarness />);

    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().withdrawQuestionCard('req-1', 'timeout');
    });

    // The host already answered pi; a reply here would be a second response.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('delivers an answer settled before the hook mounted', () => {
    // A card can be answered while the row is unmounted (react-window recycles
    // rows as the transcript scrolls), so the queue must survive until something
    // drains it rather than relying on mount order.
    act(() => {
      useChatStore.getState().addQuestionCard(DIALOG);
      useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    });
    expect(postMessage).not.toHaveBeenCalled();

    render(<OutboxHarness />);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().pendingDialogAnswers).toHaveLength(0);
  });
});
