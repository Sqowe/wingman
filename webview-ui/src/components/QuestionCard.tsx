/**
 * QuestionCard — a blocking question from a pi extension, rendered in the chat
 * transcript instead of a native quick pick.
 *
 * Why this exists: a VS Code quick pick row cannot be multi-line
 * (microsoft/vscode#153095, open since 2022) and the widget is a fixed 600px, so
 * a question whose options each carry a sentence of explanation — or a code
 * preview — is clipped exactly where the useful text starts. Here everything
 * wraps, previews render as markdown, and multiple choice gets real checkboxes.
 * See docs/design/in-chat-question-cards.md.
 *
 * Two constraints drive the implementation, both from the sending extension
 * (`@juicesharp/rpiv-ask-user-question`, rpc-fallback.ts) rather than from taste:
 *
 *  - A single choice answers with the option's `raw` string, byte-for-byte. The
 *    sender reads the leading index back out and treats anything it cannot map to
 *    an offered option as a *dismissal*, which cancels the whole questionnaire.
 *  - Multiple choice answers with bare comma-separated indices ("1,3"). Every
 *    token must parse, or the sender keeps the entire reply as free text.
 *
 * A third card kind answers with the user's own words: the sender's "Type
 * something." escape, which comes back as a second request for free text. The
 * text goes to the sender verbatim — it *is* the answer.
 *
 * All three are enforced in the store (see `answerQuestionCard` /
 * `submitQuestionSelection` / `submitQuestionText`); this component only
 * decides *when* to call them.
 *
 * pi is blocked while `status === 'open'`, so the card must always offer a way
 * out: every state has either an answer control or a Dismiss.
 */
import React, { useId, useState } from 'react';
import type { QuestionCardItem } from '../store';
import { useChatStore } from '../store';
import type { UiDialogOption } from '../../../src/shared/messages';
import { parseMultiSelectReply } from '../../../src/shared/dialog-options';
import { MemoMarkdown } from './Markdown';

interface Props {
  item: QuestionCardItem;
}

/** Human-readable note for a card the host took back. */
const WITHDRAWN_LABELS: Record<NonNullable<QuestionCardItem['withdrawnReason']>, string> = {
  timeout: 'This question expired before it was answered.',
  sessionReset: 'This question was cancelled when the session was replaced.',
  agentStopped: 'This question was cancelled because the agent stopped.',
};

/**
 * Memoized on `item`: MessageList's memoized `Row` receives the whole `items`
 * array, so it re-renders on any store change — including every streaming delta.
 * A settled card in a long transcript has no reason to re-render for that. The
 * store's action references are stable, so only a genuine `item` change gets
 * through.
 */
export const QuestionCard = React.memo(function QuestionCard({ item }: Props) {
  const answerQuestionCard = useChatStore((s) => s.answerQuestionCard);
  const submitQuestionSelection = useChatStore((s) => s.submitQuestionSelection);
  const submitQuestionText = useChatStore((s) => s.submitQuestionText);
  const setQuestionDraft = useChatStore((s) => s.setQuestionDraft);
  const setQuestionReferenceExpanded = useChatStore((s) => s.setQuestionReferenceExpanded);
  const dismissQuestionCard = useChatStore((s) => s.dismissQuestionCard);
  const toggleQuestionOption = useChatStore((s) => s.toggleQuestionOption);
  const setQuestionCardExpanded = useChatStore((s) => s.setQuestionCardExpanded);

  const isOpen = item.status === 'open';

  return (
    <div
      className={`question-card question-card--${item.status}`}
      // A blocking question is a request for input, not a passive region: `group`
      // plus the label ties the controls together for a screen reader without
      // trapping focus the way `dialog` would (the transcript stays navigable).
      role="group"
      aria-label={item.header ? `Question: ${item.header}` : 'Question'}
    >
      <div className="question-card__head">
        {item.header && <span className="question-card__chip">{item.header}</span>}
        {!isOpen && <StatusBadge item={item} />}
      </div>

      <div className="question-card__question">
        <MemoMarkdown text={item.question} />
      </div>

      {item.status === 'withdrawn' && item.withdrawnReason && (
        <p className="question-card__note" role="status">
          {WITHDRAWN_LABELS[item.withdrawnReason]}
        </p>
      )}

      {isOpen ? (
        item.kind === 'multiSelect' ? (
          <MultiSelectBody
            item={item}
            onToggle={(index) => toggleQuestionOption(item.id, index)}
            onDraft={(text) => setQuestionDraft(item.id, text)}
            onSubmit={() => submitQuestionSelection(item.id)}
            onDismiss={() => dismissQuestionCard(item.id)}
          />
        ) : item.kind === 'text' ? (
          <TextBody
            item={item}
            onDraft={(text) => setQuestionDraft(item.id, text)}
            onToggleReference={() =>
              setQuestionReferenceExpanded(item.id, !(item.referenceExpanded ?? false))
            }
            onSubmit={(text) => submitQuestionText(item.id, text)}
            onDismiss={() => dismissQuestionCard(item.id)}
          />
        ) : (
          <SelectBody
            item={item}
            onChoose={(raw) => answerQuestionCard(item.id, raw)}
            onDismiss={() => dismissQuestionCard(item.id)}
          />
        )
      ) : (
        <SettledBody
          item={item}
          onToggleExpanded={() => setQuestionCardExpanded(item.id, !item.expanded)}
        />
      )}
    </div>
  );
});

// ─── Open: single choice ──────────────────────────────────────────────────────

function SelectBody({
  item,
  onChoose,
  onDismiss,
}: {
  item: QuestionCardItem;
  onChoose: (raw: string) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <ul className="question-card__options" role="list">
        {item.options.map((option, i) => (
          <li key={option.raw + i}>
            <button
              type="button"
              className="question-card__option"
              // Clicking answers immediately: a two-step select-then-confirm adds a
              // click to every question for no gain, and pi is waiting.
              onClick={() => onChoose(option.raw)}
            >
              <OptionLabel option={option} fallbackNumber={i + 1} />
            </button>
            {option.preview !== undefined && <OptionPreview preview={option.preview} />}
          </li>
        ))}
      </ul>
      <CardActions onDismiss={onDismiss} />
    </>
  );
}

// ─── Open: multiple choice ───────────────────────────────────────────────────

function MultiSelectBody({
  item,
  onToggle,
  onDraft,
  onSubmit,
  onDismiss,
}: {
  item: QuestionCardItem;
  onToggle: (index: number) => void;
  onDraft: (text: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const fieldId = useId();
  const ownText = item.allowsCustomText ? (item.draft ?? '') : '';
  const nothing = item.selected.length === 0 && ownText.trim().length === 0;
  return (
    <>
      {item.instructions && (
        <p className="question-card__instructions">{item.instructions}</p>
      )}
      <ul className="question-card__options" role="list">
        {item.options.map((option, i) => {
          // Only an option the sender numbered can be submitted: the answer is a
          // list of indices. An unnumbered option is shown but not selectable,
          // which is honest — there is no token that would identify it.
          const index = option.index;
          const selectable = index !== undefined;
          const checked = selectable && item.selected.includes(index);
          return (
            <li key={option.raw + i}>
              <label
                className={`question-card__option question-card__option--check${
                  selectable ? '' : ' question-card__option--disabled'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!selectable}
                  // Guard on `index` itself rather than the `selectable` alias.
                  // Both compile (TS narrows an aliased const through a closure),
                  // but this form does not depend on that analysis — it still holds
                  // if the binding above is ever changed to `let`.
                  onChange={() => { if (index !== undefined) onToggle(index); }}
                />
                <OptionLabel option={option} fallbackNumber={i + 1} />
              </label>
              {option.preview !== undefined && <OptionPreview preview={option.preview} />}
            </li>
          );
        })}
      </ul>
      {item.allowsCustomText && (
        <div className="question-card__custom">
          <label className="question-card__custom-label" htmlFor={fieldId}>
            Your own answer (optional)
          </label>
          <textarea
            id={fieldId}
            className="question-card__input"
            value={ownText}
            onChange={(event) => onDraft(event.target.value)}
            rows={2}
            title="Enter sends the answer, Shift+Enter starts a new line"
            onKeyDown={(event) => {
              // Same keys as the free-text card: Enter sends, Shift+Enter keeps
              // the newline, and an IME composition is left to finish.
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              onSubmit();
            }}
          />
        </div>
      )}
      <CardActions onDismiss={onDismiss}>
        <button
          type="button"
          className="question-card__submit"
          onClick={onSubmit}
          // Deliberately enabled with nothing ticked: the sender reads an empty
          // reply as "none of these", which is a legitimate answer.
          title={nothing ? 'Submit with nothing selected' : undefined}
        >
          Submit{item.selected.length > 0 ? ` (${item.selected.length})` : ''}
        </button>
      </CardActions>
    </>
  );
}

// ─── Open: a written answer ──────────────────────────────────────────────────

/**
 * A card that takes an answer the user writes.
 *
 * This is the surface behind a sender's "Type something." row. The sender asks
 * for its own text, so the card offers a field rather than a choice: the
 * option list it repeats is reference material (the user can consult it while
 * typing), never a set of boxes to tick. The host decides this shape from the
 * request itself — see `parseInputDialog` in src/shared/dialog-options.ts.
 */
function TextBody({
  item,
  onDraft,
  onToggleReference,
  onSubmit,
  onDismiss,
}: {
  item: QuestionCardItem;
  onDraft: (text: string) => void;
  onToggleReference: () => void;
  onSubmit: (text: string) => void;
  onDismiss: () => void;
}) {
  // The draft lives in the store, not in a local `useState`: the transcript is
  // virtualised, so a card that scrolls out of view is unmounted and a local
  // value would take the half-typed answer with it.
  const text = item.draft ?? '';
  // A blank answer is not an answer: the sender behind a "Type something." row
  // reads an empty reply as "go back to the options" and re-asks the question,
  // so Submit stays disabled until there is something to send.
  const canSubmit = text.trim().length > 0;

  return (
    <>
      {item.instructions && (
        <p className="question-card__instructions">{item.instructions}</p>
      )}
      <textarea
        className="question-card__input"
        value={text}
        onChange={(event) => onDraft(event.target.value)}
        placeholder="Type your answer…"
        rows={3}
        aria-label="Your answer"
        title="Enter sends the answer, Shift+Enter starts a new line"
        onKeyDown={(event) => {
          // Enter sends, like the composer. Shift+Enter keeps the newline: an
          // answer is usually one line, but need not be.
          if (event.key !== 'Enter' || event.shiftKey) return;
          // An IME composition is still being assembled — Enter confirms it, it
          // does not send. `isComposing` is the standard signal; keyCode 229 is
          // the fallback for the browsers that do not set it.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (canSubmit) onSubmit(text);
        }}
      />
      {item.options.length > 0 && (
        <ReferenceOptions
          options={item.options}
          expanded={item.referenceExpanded ?? false}
          onToggle={onToggleReference}
        />
      )}
      <CardActions
        onDismiss={onDismiss}
        dismissTitle="Cancel — the extension decides what happens next; rpiv returns to the options"
      >
        <button
          type="button"
          className="question-card__submit"
          onClick={() => onSubmit(text)}
          disabled={!canSubmit}
          title={canSubmit ? undefined : 'Type an answer first'}
        >
          Submit
        </button>
      </CardActions>
    </>
  );
}

/**
 * The option list a free-text card repeats, collapsed by default.
 *
 * The sender puts the list there so the user can refer to it while typing
 * (rpiv, since 2.13). It is reference, not a choice: the rows are inert, and
 * nothing about them can be submitted — the answer is the user's own words.
 *
 * Open or closed is the card's own state, not local component state: the
 * transcript is virtualised, so a row that scrolls out of view is unmounted
 * and a local toggle would close the list under the user who scrolled back.
 */
function ReferenceOptions({
  options,
  expanded,
  onToggle,
}: {
  options: UiDialogOption[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="question-card__reference">
      <button
        type="button"
        className="question-card__more"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`question-card__chevron${expanded ? ' question-card__chevron--open' : ''}`}>
          ▸
        </span>
        {expanded ? 'Hide the options' : `Show the options (${options.length})`}
      </button>
      {expanded && (
        <ul className="question-card__options question-card__options--rest" role="list">
          {options.map((option, i) => (
            <li key={option.raw + i} className="question-card__option question-card__option--muted">
              <OptionLabel option={option} fallbackNumber={option.index ?? i + 1} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Settled: the transcript record ──────────────────────────────────────────

/**
 * An answered card keeps the question visible and collapses to just the chosen
 * row, with a chevron to reveal the rest. Keeping the full list expanded costs a
 * lot of vertical space in a narrow side panel; dropping the question entirely
 * would leave an answer with no context.
 */
function SettledBody({
  item,
  onToggleExpanded,
}: {
  item: QuestionCardItem;
  onToggleExpanded: () => void;
}) {
  const chosen = chosenOptions(item);
  const hasMore = item.options.length > chosen.length;
  // A free-text card has no chosen *option* — what it records is the answer
  // the user wrote, and its option list is reference rather than a choice, so
  // the toggle reads differently there.
  const isText = item.kind === 'text';
  // A multiple choice may carry the user's own text after the indices.
  const ownText = item.kind === 'multiSelect' && item.status === 'answered' && item.answer !== undefined
    ? parseMultiSelectReply(item.answer).text
    : undefined;

  return (
    <>
      {chosen.length > 0 && (
        <ul className="question-card__options" role="list">
          {chosen.map((option, i) => (
            <li key={option.raw + i} className="question-card__option question-card__option--chosen">
              <span className="question-card__tick" aria-hidden="true">✓</span>
              <OptionLabel option={option} fallbackNumber={option.index ?? i + 1} />
            </li>
          ))}
        </ul>
      )}

      {isText && item.answer !== undefined && (
        <div className="question-card__answer-text">{item.answer}</div>
      )}

      {ownText !== undefined && <div className="question-card__answer-text">{ownText}</div>}

      {item.status === 'answered' && chosen.length === 0 && !isText && ownText === undefined && (
        <p className="question-card__note">No options were selected.</p>
      )}

      {item.expanded && (
        <ul className="question-card__options question-card__options--rest" role="list">
          {item.options
            .filter((o) => !chosen.includes(o))
            .map((option, i) => (
              <li key={option.raw + i} className="question-card__option question-card__option--muted">
                <OptionLabel option={option} fallbackNumber={option.index ?? i + 1} />
              </li>
            ))}
        </ul>
      )}

      {hasMore && (
        <button
          type="button"
          className="question-card__more"
          onClick={onToggleExpanded}
          aria-expanded={item.expanded}
        >
          <span className={`question-card__chevron${item.expanded ? ' question-card__chevron--open' : ''}`}>
            ▸
          </span>
          {isText
            ? item.expanded
              ? 'Hide the options'
              : 'Show the options'
            : item.expanded
              ? 'Hide other options'
              : 'Show all options'}
        </button>
      )}
    </>
  );
}

/**
 * The options the user picked, resolved from the recorded answer.
 *
 * Derived rather than stored: the answer string is what went to pi, and deriving
 * the display from it keeps the record honest — it cannot drift from what was
 * actually sent.
 */
function chosenOptions(item: QuestionCardItem): UiDialogOption[] {
  if (item.status !== 'answered' || item.answer === undefined) return [];
  if (item.kind === 'select') {
    return item.options.filter((o) => o.raw === item.answer);
  }
  // A free-text card records the answer the user wrote, not a picked option.
  if (item.kind === 'text') return [];
  // multiSelect: comma-separated indices, own text (if any) after the separator.
  const picked = new Set(parseMultiSelectReply(item.answer).indices);
  return item.options.filter((o) => o.index !== undefined && picked.has(o.index));
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

function StatusBadge({ item }: { item: QuestionCardItem }) {
  const label =
    item.status === 'answered' ? 'Answered'
    : item.status === 'dismissed' ? 'Dismissed'
    : 'Expired';
  return <span className={`question-card__badge question-card__badge--${item.status}`}>{label}</span>;
}

/**
 * One option's text: the headline, then its explanation beneath.
 *
 * The row is numbered from the sender's own index where it has one, so the
 * numbering the user sees matches what the sender talks in.
 */
function OptionLabel({ option, fallbackNumber }: { option: UiDialogOption; fallbackNumber: number }) {
  return (
    <span className="question-card__option-text">
      <span className="question-card__option-headline">
        <span className="question-card__option-number" aria-hidden="true">
          {option.index ?? fallbackNumber}.
        </span>{' '}
        {option.headline}
      </span>
      {option.description && (
        <span className="question-card__option-description">{option.description}</span>
      )}
    </span>
  );
}

/**
 * An option's preview, collapsed by default.
 *
 * Previews are markdown (usually a code snippet or an ASCII mockup) and can run
 * to hundreds of characters, so showing every one expanded would bury the
 * options themselves. Rendered through the shared markdown component, so the
 * same no-raw-HTML and link-interception rules apply as to assistant output.
 */
function OptionPreview({ preview }: { preview: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="question-card__preview">
      <button
        type="button"
        className="question-card__preview-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`question-card__chevron${open ? ' question-card__chevron--open' : ''}`}>
          ▸
        </span>
        {open ? 'Hide preview' : 'Show preview'}
      </button>
      {open && (
        <div className="question-card__preview-body">
          <MemoMarkdown text={preview} />
        </div>
      )}
    </div>
  );
}

function CardActions({
  onDismiss,
  dismissTitle = 'Decline to answer — the extension treats this as cancelling the whole questionnaire',
  children,
}: {
  onDismiss: () => void;
  /** Tooltip for the Dismiss control; overridden where the meaning differs. */
  dismissTitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="question-card__actions">
      {children}
      <button
        type="button"
        className="question-card__dismiss"
        onClick={onDismiss}
        title={dismissTitle}
      >
        Dismiss
      </button>
    </div>
  );
}
