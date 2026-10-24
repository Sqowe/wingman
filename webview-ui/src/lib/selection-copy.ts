/**
 * selection-copy — makes the copy chord (Cmd+C on macOS, Ctrl+C elsewhere)
 * copy the text the user selected in the chat.
 *
 * Why this has to exist
 * ---------------------
 * VS Code cancels the browser's own copy inside a webview. The webview
 * bootstrap (`pre/index.html` in the VS Code sources) calls `preventDefault()`
 * on Cmd/Ctrl+C and then re-dispatches the key to the workbench, where
 * `editor.action.clipboardCopyAction` is overridden for webviews to run
 * `document.execCommand('copy')` back inside the frame.
 *
 * That replacement re-focuses the last focused element before copying
 * (`pre/index.html`: `lastFocused.focus()`), and the last focused element in
 * Wingman is the composer's <textarea> — clicking chat text blurs the
 * textarea, but the "last focused" map is only updated for non-body elements,
 * so it still points at the textarea. Chromium then copies the textarea's
 * (empty) selection instead of the chat selection and the clipboard stays
 * unchanged. The copy buttons do not hit this path: they go straight to the
 * host (`vscode.env.clipboard.writeText`).
 *
 * This module takes the copy over: it reads the selection and writes it
 * through the host, the same path the copy buttons use.
 *
 * Listener placement matters
 * --------------------------
 * The keydown handler is registered on `document`, not on `window`. A key
 * event bubbles document → window, and VS Code's listener sits on the frame's
 * `window`, so a document-level handler still runs first and can cancel the
 * event before VS Code's `preventDefault()` fires. `stopPropagation()` then
 * keeps VS Code from running its own copy afterwards, which would otherwise
 * overwrite what we just wrote with the textarea's empty selection.
 */
import { vscode } from '../vscodeApi';
import { MAX_CLIPBOARD_BYTES } from '@shared/limits';

const encoder = new TextEncoder();

/** Minimal shape of the key event fields this module looks at. */
interface KeyChord {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * True when the event is the platform copy chord.
 *
 * Alt and Shift are excluded on purpose: AltGr on Windows arrives as
 * Ctrl+Alt, and Cmd/Ctrl+Shift+C is taken by "copy as" / developer tools.
 */
export function isCopyChord(e: KeyChord): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (!e.metaKey && !e.ctrlKey) return false;
  return e.code === 'KeyC' || e.key === 'c';
}

/**
 * The contenteditable host the target belongs to, or null.
 *
 * `isContentEditable` is not implemented everywhere and is false for a node
 * inside a contenteditable host, so the attribute is checked as well.
 */
function editableHost(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return null;
  if (el.isContentEditable === true) return el;
  const host = el.closest?.('[contenteditable]');
  if (host && host.getAttribute('contenteditable') !== 'false') return host as HTMLElement;
  return null;
}

/**
 * True when the event target is a text-entry context (input, textarea, or a
 * contenteditable host). Those keep VS Code's own copy path, which handles
 * them correctly — the composer must stay copyable.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  return editableHost(target) !== null;
}

/**
 * True when the target is a text field that has a selection of its own.
 *
 * A field's own selection never shows up in `window.getSelection()`, so the
 * two can coexist: the user can select chat text and then select part of a
 * draft in the composer. In that case the field's selection is the more
 * specific intent and must win.
 */
export function hasOwnSelection(target: EventTarget | null): boolean {
  const el = target as HTMLTextAreaElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return false;
  try {
    return el.selectionStart !== el.selectionEnd;
  } catch {
    // Some input types (email, number, …) refuse to report a selection.
    return false;
  }
}

/**
 * The text the user currently has selected, or '' when there is no selection.
 *
 * Text selected inside a <textarea> is not part of `window.getSelection()`,
 * so a composer selection never shows up here — which is exactly why the
 * copy chord inside the composer is left to VS Code.
 */
export function readSelectionText(win: Pick<Window, 'getSelection'> = window): string {
  const selection = win.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  return selection.toString();
}

/** Byte length of the text, for the clipboard size cap. */
function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Diagnostics must never break copying. */
function diag(detail: string): void {
  try {
    vscode.postMessage({ type: 'diag', scope: 'selection-copy', detail });
  } catch {
    // ignore
  }
}

/**
 * Writes the selected text to the clipboard through the host.
 *
 * Returns false when the payload is over the cap — the host would drop it
 * anyway, so nothing is written and the reason is logged instead.
 */
function postSelection(text: string): boolean {
  if (byteLength(text) > MAX_CLIPBOARD_BYTES) {
    diag(`selection too large to copy (> ${MAX_CLIPBOARD_BYTES} bytes)`);
    return false;
  }
  vscode.postMessage({ type: 'copyToClipboard', text });
  return true;
}

/**
 * Installs the copy-chord handling. Returns a disposer.
 *
 * Two paths are covered:
 *  - the key chord: the primary route, cancelled before VS Code sees it and
 *    written to the clipboard through the host;
 *  - the `copy` event: covers Edit → Copy and the webview context menu, which
 *    reach the frame through `execCommand('copy')` instead of a key press.
 */
export function installSelectionCopy(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isCopyChord(e)) return;
    // The composer keeps VS Code's own copy path.
    if (isTextEntryTarget(e.target)) return;
    const text = readSelectionText();
    if (!text) return; // nothing selected — leave the chord alone

    // The chat selection owns the chord, so it is cancelled for the whole key
    // hold: a repeated keydown must not reach VS Code either, or VS Code
    // would copy the composer on top of what we just wrote.
    e.preventDefault();
    e.stopPropagation();

    // Holding the key down must not write the clipboard over and over.
    if (e.repeat) return;
    postSelection(text);
  };

  const onCopy = (e: ClipboardEvent) => {
    // A text field with a selection of its own keeps its own copy.
    if (hasOwnSelection(e.target)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString();
    if (!text) return; // no chat selection — let the event through

    // A contenteditable host owns its own copy, rich text included.
    const editable = editableHost(e.target);
    if (
      editable &&
      (editable.contains(selection.anchorNode) || editable.contains(selection.focusNode))
    ) {
      return;
    }

    if (byteLength(text) > MAX_CLIPBOARD_BYTES) {
      e.preventDefault();
      diag(`selection too large to copy (> ${MAX_CLIPBOARD_BYTES} bytes)`);
      return;
    }

    e.preventDefault();
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      return;
    }
    // No clipboardData to write into — fall back to the host.
    postSelection(text);
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('copy', onCopy);
  return () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('copy', onCopy);
  };
}
