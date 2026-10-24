// The file is `.tsx` on purpose: `src/lib/**/*.test.ts` is pinned to the node
// environment in vitest.config.ts, and these tests need a DOM (document
// events, Selection, Range).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_CLIPBOARD_BYTES } from '@shared/limits';

const postMessage = vi.fn();
vi.mock('../vscodeApi', () => ({
  vscode: { postMessage: (m: unknown) => postMessage(m) },
}));

import {
  installSelectionCopy,
  isCopyChord,
  isTextEntryTarget,
  hasOwnSelection,
  readSelectionText,
} from './selection-copy';

/** A <p> with selectable text, plus a <textarea> standing in for the composer. */
function mountChat(): { paragraph: HTMLElement; textarea: HTMLTextAreaElement } {
  document.body.innerHTML = '<p id="chat">copied from the chat</p><textarea id="composer">a draft</textarea>';
  return {
    paragraph: document.getElementById('chat') as HTMLElement,
    textarea: document.getElementById('composer') as HTMLTextAreaElement,
  };
}

/** Selects the whole paragraph, the way a mouse drag over the chat does. */
function selectParagraph(text: HTMLElement): void {
  const selection = window.getSelection() as Selection;
  const range = document.createRange();
  range.selectNodeContents(text);
  selection.removeAllRanges();
  selection.addRange(range);
}

function copyEvent(): Event {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  const setData = vi.fn();
  (event as unknown as { clipboardData: { setData: unknown } }).clipboardData = { setData };
  return event;
}

/** The `setData` spy of a copy event built by copyEvent(). */
function setDataOf(event: Event): ReturnType<typeof vi.fn> {
  return (event as unknown as { clipboardData: { setData: ReturnType<typeof vi.fn> } }).clipboardData
    .setData;
}

/** A keydown event for the copy chord. */
function chordEvent(target: EventTarget, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    code: 'KeyC',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

// The disposer of the currently installed handler. A failing assertion must
// not leave a listener attached to the document for the next case.
let disposeInstalled: (() => void) | undefined;

function install(): () => void {
  disposeInstalled?.();
  disposeInstalled = installSelectionCopy();
  return disposeInstalled;
}

beforeEach(() => {
  postMessage.mockClear();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

afterEach(() => {
  disposeInstalled?.();
  disposeInstalled = undefined;
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('isCopyChord', () => {
  it('accepts the platform copy chord', () => {
    expect(isCopyChord({ key: 'c', code: 'KeyC', metaKey: true })).toBe(true);
    expect(isCopyChord({ key: 'c', code: 'KeyC', ctrlKey: true })).toBe(true);
  });

  it('rejects anything that is not a plain copy chord', () => {
    expect(isCopyChord({ key: 'c', code: 'KeyC' })).toBe(false);
    expect(isCopyChord({ key: 'v', code: 'KeyV', metaKey: true })).toBe(false);
    // AltGr on Windows arrives as Ctrl+Alt.
    expect(isCopyChord({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true })).toBe(false);
    // Cmd/Ctrl+Shift+C is "copy as" / developer tools.
    expect(isCopyChord({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })).toBe(false);
  });
});

describe('isTextEntryTarget', () => {
  it('recognises text-entry contexts', () => {
    const { textarea } = mountChat();
    expect(isTextEntryTarget(textarea)).toBe(true);
    expect(isTextEntryTarget(document.createElement('input'))).toBe(true);
    expect(isTextEntryTarget(document.getElementById('chat'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe('hasOwnSelection', () => {
  it('is true only for a text field with a selection of its own', () => {
    const { textarea } = mountChat();
    expect(hasOwnSelection(textarea)).toBe(false);

    textarea.setSelectionRange(0, 1);
    expect(hasOwnSelection(textarea)).toBe(true);

    expect(hasOwnSelection(document.getElementById('chat'))).toBe(false);
    expect(hasOwnSelection(null)).toBe(false);
  });
});

describe('readSelectionText', () => {
  it('returns the selected text', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    expect(readSelectionText()).toBe('copied from the chat');
  });

  it('returns an empty string when nothing is selected', () => {
    mountChat();
    expect(readSelectionText()).toBe('');
  });
});

describe('installSelectionCopy', () => {
  it('copies the chat selection to the host on Cmd+C', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    const event = chordEvent(paragraph);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      text: 'copied from the chat',
    });
    // The browser's own copy must not run as well.
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  it('keeps the chord away from VS Code, which would copy the composer', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    // VS Code listens on the frame's window, one step past `document`.
    const vscodeListener = vi.fn();
    window.addEventListener('keydown', vscodeListener);

    chordEvent(paragraph);

    expect(vscodeListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', vscodeListener);
    dispose();
  });

  it('copies on Ctrl+C too', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    chordEvent(paragraph, { metaKey: false, ctrlKey: true });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      text: 'copied from the chat',
    });
    dispose();
  });

  it('leaves the chord alone when nothing is selected', () => {
    const { paragraph } = mountChat();
    const dispose = install();

    const event = chordEvent(paragraph);

    expect(postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('leaves the composer to VS Code, which copies it correctly', () => {
    const { textarea } = mountChat();
    const dispose = install();

    const event = chordEvent(textarea);

    expect(postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('cancels a held key without writing the clipboard again', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    const event = chordEvent(paragraph, { repeat: true });

    // The chord stays ours for the whole key hold: a repeat must not reach
    // VS Code, which would copy the composer over our copy.
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'copyToClipboard' }),
    );
    dispose();
  });

  it('does nothing once disposed', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();
    dispose();

    chordEvent(paragraph);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('cancels the chord for an oversized selection instead of copying the composer', () => {
    const { paragraph } = mountChat();
    const huge = 'a'.repeat(MAX_CLIPBOARD_BYTES + 1);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => huge,
    } as unknown as Selection);
    const dispose = install();

    const event = chordEvent(paragraph);

    // The chord is ours, so VS Code must not fall back to the composer.
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'copyToClipboard' }),
    );
    // The reason is logged instead of vanishing silently.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'diag', scope: 'selection-copy' }),
    );
    dispose();
  });

  it('copies the selection on a copy event (Edit → Copy, context menu)', () => {
    const { paragraph } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    const event = copyEvent();
    paragraph.dispatchEvent(event);

    expect(setDataOf(event)).toHaveBeenCalledWith('text/plain', 'copied from the chat');
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  it('copies the chat selection even when the copy event targets the composer', () => {
    const { paragraph, textarea } = mountChat();
    selectParagraph(paragraph);
    const dispose = install();

    // VS Code re-focuses the composer before it runs execCommand('copy'),
    // so the copy event arrives with the textarea as its target.
    const event = copyEvent();
    textarea.dispatchEvent(event);

    expect(setDataOf(event)).toHaveBeenCalledWith('text/plain', 'copied from the chat');
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  it('leaves a copy event from the composer alone', () => {
    const { textarea } = mountChat();
    const dispose = install();

    const event = copyEvent();
    textarea.dispatchEvent(event);

    expect(setDataOf(event)).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('leaves the composer copy alone when the composer has its own selection', () => {
    const { paragraph, textarea } = mountChat();
    selectParagraph(paragraph);
    textarea.setSelectionRange(0, 1);
    const dispose = install();

    const event = copyEvent();
    textarea.dispatchEvent(event);

    expect(setDataOf(event)).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('leaves a contenteditable to the native copy path', () => {
    const { paragraph } = mountChat();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'editable text';
    document.body.appendChild(editable);
    selectParagraph(paragraph);
    const dispose = install();

    const event = chordEvent(editable);

    expect(postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('leaves a copy event inside a contenteditable to the native copy path', () => {
    mountChat();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'editable text';
    document.body.appendChild(editable);

    // The selection lives inside the contenteditable host.
    const selection = window.getSelection() as Selection;
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);

    const dispose = install();

    const event = copyEvent();
    editable.dispatchEvent(event);

    expect(setDataOf(event)).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });
});
