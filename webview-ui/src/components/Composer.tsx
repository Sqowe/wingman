/**
 * Composer — prompt input with send + abort buttons, a `/` slash menu,
 * and image attachment (＋ button, paste, drag-and-drop).
 *
 * - Enter sends, Shift+Enter inserts newline.
 * - When isStreaming is true, shows an Abort button instead of Send.
 * - Typing `/` (or `/prefix`) opens an autocomplete dropdown from the
 *   commands list. Selecting a command (Enter, Tab, or click) inserts
 *   `/name ` into the input and parks the cursor after it — it does NOT
 *   send immediately. Type any arguments or free-text instructions, then
 *   press Enter or Send to execute.
 * - Disabled when pi is not found.
 * - Image attachment is gated on `supportsImages`; when the active model
 *   does not accept images the ＋ button is disabled and pasted/dropped
 *   images are ignored with an inline note. Images are always stripped
 *   when sending a slash command (text starting with `/`).
 */
import React, { useRef, useState, useCallback, useEffect, useReducer } from 'react';
import type { PiStatus, PiCommand, AttachedImage } from '@shared/messages';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT, MAX_TOTAL_IMAGE_BYTES, ALLOWED_IMAGE_MIME_TYPES } from '@shared/limits';
import { vscode } from '../vscodeApi';
import { slashFilterFromValue, filterCommands, buildInsertedText, isSlashCommand } from '../lib/slash-commands';

interface Props {
  isStreaming: boolean;
  piStatus: PiStatus | null;
  promptError: string | null;
  commands: PiCommand[];
  /** Text to pre-fill in the textarea (from pi's set_editor_text / pasteToEditor). */
  prefillText?: string | null;
  /** Called once after the pre-fill has been applied so the store can clear it. */
  onPrefillConsumed?: () => void;
  /** True when the active model accepts image input. */
  supportsImages: boolean;
  /** Human-readable name of the active model (shown in the no-images note). */
  modelName: string | null;
  onSend: (text: string, images?: AttachedImage[]) => void;
}

export function Composer({
  isStreaming,
  piStatus,
  promptError,
  commands,
  prefillText,
  onPrefillConsumed,
  supportsImages,
  modelName,
  onSend,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize the textarea to fit its content, clamped by CSS min/max-height.
  // Reset to '' (not 'auto') so the CSS min-height stays as the floor, then
  // only set an explicit height when scrollHeight exceeds that floor.
  const autoResize = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = '';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const menuRef = useRef<HTMLUListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The textarea is intentionally uncontrolled (no `value` prop, driven by ref).
  const disabled = piStatus?.kind === 'not-found';

  // ── Attachment state ──────────────────────────────────────────────────────
  //
  // A single `useReducer` keeps `image` and `previewUrl` in one atomic state
  // entry so the two arrays can never desync. All mutations go through
  // `attachDispatch`; no preview URL is ever created without a matching image
  // and vice versa.

  interface AttachEntry { image: AttachedImage; previewUrl: string; }

  type AttachAction =
    | { type: 'append'; entry: AttachEntry }
    | { type: 'remove'; idx: number }
    | { type: 'clear' };

  function attachReducer(state: AttachEntry[], action: AttachAction): AttachEntry[] {
    switch (action.type) {
      case 'append': {
        // Enforce the count + total-byte caps atomically here, not only in the
        // addFiles pre-clamp: concurrent FileReader completions could otherwise
        // overshoot the limits. Reject (and revoke) the entry if it would.
        const bytes = state.reduce((sum, e) => sum + e.image.size, 0);
        if (
          state.length >= MAX_IMAGES_PER_PROMPT ||
          bytes + action.entry.image.size > MAX_TOTAL_IMAGE_BYTES
        ) {
          URL.revokeObjectURL(action.entry.previewUrl);
          return state;
        }
        return [...state, action.entry];
      }
      case 'remove': {
        const removed = state[action.idx];
        if (removed) URL.revokeObjectURL(removed.previewUrl);
        return state.filter((_, i) => i !== action.idx);
      }
      case 'clear':
        state.forEach((e) => URL.revokeObjectURL(e.previewUrl));
        return [];
    }
  }

  const [attachments, attachDispatch] = useReducer(attachReducer, []);

  // Derive plain images array for send path (no preview URLs needed by host).
  const images: AttachedImage[] = attachments.map((e) => e.image);

  // Revoke all blob URLs on unmount.
  useEffect(() => {
    return () => attachDispatch({ type: 'clear' });
  }, []);

  /**
   * Generation counter. Incremented whenever attachments are cleared (send,
   * model-gate clear). FileReader onload callbacks capture the generation at
   * read-start and discard if it changed, preventing stale reads re-appending.
   */
  const attachGenRef = useRef(0);

  // Slash-menu state.
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  // Filtered command list derived from the current input prefix.
  const filteredCommands: PiCommand[] = filterCommands(commands, slashFilter);

  const isMenuOpen = filteredCommands.length > 0;

  // Recompute slash filter from textarea value.
  // Only open the menu when the entire input is a bare slash-prefix (no trailing
  // space or argument text yet). Once the user selects a command and starts
  // typing arguments, the input is e.g. "/name arg" and the menu stays closed.
  const updateSlashFilter = useCallback((value: string) => {
    const next = slashFilterFromValue(value);
    if (next !== null) {
      setSlashFilter(next);
      setMenuIndex(0);
    } else {
      setSlashFilter(null);
    }
  }, []);

  /** Show a brief inline note (auto-clears after 3 s). */
  const [imageNote, setImageNote] = useState<string | null>(null);
  const imageNoteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (imageNoteTimerRef.current !== undefined) clearTimeout(imageNoteTimerRef.current);
    };
  }, []);

  const showImageNote = useCallback((msg: string) => {
    setImageNote(msg);
    if (imageNoteTimerRef.current !== undefined) clearTimeout(imageNoteTimerRef.current);
    imageNoteTimerRef.current = setTimeout(() => {
      imageNoteTimerRef.current = undefined;
      setImageNote(null);
    }, 3_000);
  }, []);

  // Clear any pending images when the model changes to one that doesn't support images.
  useEffect(() => {
    if (!supportsImages && attachments.length > 0) {
      attachGenRef.current += 1;
      attachDispatch({ type: 'clear' });
      showImageNote(`${modelName ?? 'This model'} doesn't accept images — attachments cleared.`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsImages]);

  /**
   * Convert a FileList / File[] into AttachedImage entries and append them
   * to the current images state, respecting the count and size limits.
   * Pre-clamps to remaining slots before starting any FileReader reads.
   */
  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;

    const fileArray = Array.from(files);
    const accepted: File[] = [];

    for (const file of fileArray) {
      if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        showImageNote(`"${file.name}" exceeds the 5 MB image limit and was not attached.`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length === 0) return;

    // Read current counts/bytes directly from the reducer state (not inside
    // a setState updater, so no side effects in updaters).
    const currentCount = attachments.length;
    const currentBytes = attachments.reduce((s, e) => s + e.image.size, 0);
    const remaining = MAX_IMAGES_PER_PROMPT - currentCount;

    if (remaining <= 0) {
      showImageNote(`Maximum of ${MAX_IMAGES_PER_PROMPT} images per prompt reached.`);
      return;
    }

    const toProcess: File[] = [];
    let projectedBytes = currentBytes;
    for (const file of accepted) {
      if (toProcess.length >= remaining) {
        showImageNote(
          `Maximum of ${MAX_IMAGES_PER_PROMPT} images per prompt reached; ${accepted.length - toProcess.length} image(s) not added.`,
        );
        break;
      }
      if (projectedBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        showImageNote('Total image size limit (20 MB) reached; remaining images not added.');
        break;
      }
      projectedBytes += file.size;
      toProcess.push(file);
    }

    if (toProcess.length === 0) return;

    const capturedGen = attachGenRef.current;

    for (const file of toProcess) {
      const previewUrl = URL.createObjectURL(file);

      const reader = new FileReader();

      const cleanup = () => URL.revokeObjectURL(previewUrl);

      reader.onload = (ev) => {
        if (attachGenRef.current !== capturedGen) { cleanup(); return; }
        const result = ev.target?.result as string | undefined;
        if (!result) { cleanup(); return; }
        const commaIdx = result.indexOf(',');
        const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        // Append the image and its previewUrl atomically. The reducer re-checks
        // the count/byte caps, so concurrent reads completing together can't
        // overshoot the limits — the pre-clamp above is the fast path, this
        // dispatch is the safety net (a rejected entry revokes its previewUrl).
        attachDispatch({
          type: 'append',
          entry: {
            image: { data, mimeType: file.type as AttachedImage['mimeType'], fileName: file.name, size: file.size },
            previewUrl,
          },
        });
      };

      reader.onerror = cleanup;
      reader.onabort = cleanup;

      reader.readAsDataURL(file);
    }
  }, [attachments, showImageNote]);

  const handleSend = useCallback(() => {
    const text = textRef.current?.value.trim() ?? '';
    if ((!text && images.length === 0) || disabled) return;
    // Known slash commands never carry image attachments — the command text is
    // expanded by pi before the LLM sees it, and images would be misleading.
    // isSlashCommand() returns true only for commands present in the known
    // commands list (non-builtIn); unknown slash tokens and absolute paths
    // are not treated as commands and images are sent normally with them.
    // If images are currently attached and a slash command is being sent,
    // show a brief note but keep the attachments so the user can send them
    // with their next regular prompt (no silent data loss).
    const isCmd = isSlashCommand(text, commands);
    if (isCmd && images.length > 0) {
      showImageNote('Images are not sent with slash commands — attachments kept for your next prompt.');
    }
    const sendImages = isCmd ? undefined : (images.length > 0 ? images : undefined);
    onSend(text, sendImages);
    if (textRef.current) { textRef.current.value = ''; autoResize(); }
    // Only clear attachments after a regular (non-slash) send.
    if (!isCmd) {
      attachGenRef.current += 1;
      attachDispatch({ type: 'clear' });
    }
    setSlashFilter(null);
  }, [commands, disabled, images, onSend, showImageNote]);

  const handleAbort = useCallback(() => {
    vscode.postMessage({ type: 'abortTurn' });
  }, []);

  /**
   * Insert the chosen command name into the textarea and leave the cursor
   * after it so the user can append arguments or free-text instructions
   * before pressing Enter/Send.
   *
   * Skills accept any trailing text as `User: <args>`.
   * Prompt templates substitute positional args ($1, $@, $ARGUMENTS).
   * In both cases the user can write a comment here; for templates it reaches
   * the LLM only when the template body references $@ / $ARGUMENTS.
   */
  const selectCommand = useCallback((cmd: PiCommand) => {
    if (!textRef.current) return;
    // Insert "/name " with a trailing space so the cursor lands ready to type.
    const inserted = buildInsertedText(cmd);
    textRef.current.value = inserted;
    textRef.current.focus();
    // Place cursor at the end.
    textRef.current.setSelectionRange(inserted.length, inserted.length);
    // Close the menu — the slash prefix is now part of a longer string, so
    // updateSlashFilter will keep it closed as the user types more.
    setSlashFilter(null);
    // Empty deps are intentional: this callback only touches the uncontrolled
    // textarea ref and stable React state setters (setSlashFilter), plus
    // module-level imports (buildInsertedText). None of these change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashFilter(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const chosen = filteredCommands[menuIndex];
        if (chosen) selectCommand(chosen);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const chosen = filteredCommands[menuIndex];
        // Use selectCommand so Tab has the same insert-and-stay behavior as
        // Enter: inserts "/name " with trailing space, parks cursor, closes menu.
        if (chosen) selectCommand(chosen);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  }, [isMenuOpen, filteredCommands, menuIndex, selectCommand, isStreaming, handleSend]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateSlashFilter(e.target.value);
    autoResize();
  }, [updateSlashFilter, autoResize]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }

    if (imageItems.length === 0) return;

    // Prevent the default paste behavior (which would insert a file reference
    // into the textarea) whenever image items are present.
    e.preventDefault();

    // Modality gate — ignore image paste on text-only models.
    if (!supportsImages) {
      showImageNote(
        `${modelName ?? 'This model'} doesn't accept images.`,
      );
      return;
    }

    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    addFiles(files);
  }, [supportsImages, modelName, addFiles, showImageNote]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    // Always prevent default when files are being dragged to avoid browser
    // navigation / file-open fallback. Supportsimages gating is handled in onDrop.
    const hasFile = Array.from(e.dataTransfer.items).some((item) => item.kind === 'file');
    if (hasFile) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    if (!supportsImages) {
      showImageNote(`${modelName ?? 'This model'} doesn't accept images.`);
      return;
    }
    addFiles(e.dataTransfer.files);
  }, [supportsImages, modelName, addFiles, showImageNote]);

  // Apply pre-fill text from pi's set_editor_text() / pasteToEditor().
  useEffect(() => {
    if (prefillText == null || !textRef.current) return;
    textRef.current.value = prefillText;
    textRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    textRef.current.focus();
    updateSlashFilter(prefillText);
    autoResize();
    onPrefillConsumed?.();
  }, [prefillText, onPrefillConsumed, updateSlashFilter]);

  // Scroll the highlighted menu item into view.
  useEffect(() => {
    if (!isMenuOpen || !menuRef.current) return;
    const item = menuRef.current.children[menuIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [menuIndex, isMenuOpen]);

  // Close the menu when clicking outside.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        textRef.current && !textRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) {
        setSlashFilter(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isMenuOpen]);

  const removeImage = useCallback((idx: number) => {
    attachDispatch({ type: 'remove', idx });
  }, []);

  return (
    <div className="composer">
      {promptError && (
        <p className="composer__error" role="alert">
          {promptError}
        </p>
      )}

      {imageNote && (
        <p className="composer__note" role="status" aria-live="polite">
          {imageNote}
        </p>
      )}

      {attachments.length > 0 && (
        <div className="composer__chips" aria-label="Attached images">
          {attachments.map((entry, idx) => (
            <div key={idx} className="composer__chip">
              <img
                className="composer__chip-thumb"
                src={entry.previewUrl}
                alt={entry.image.fileName ?? `Image ${idx + 1}`}
              />
              <span className="composer__chip-name" title={entry.image.fileName}>
                {entry.image.fileName ?? `Image ${idx + 1}`}
              </span>
              <button
                type="button"
                className="composer__chip-remove"
                aria-label={`Remove ${entry.image.fileName ?? `image ${idx + 1}`}`}
                onClick={() => removeImage(idx)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {isMenuOpen && (
        <ul
          ref={menuRef}
          className="composer__slash-menu"
          role="listbox"
          aria-label="Slash commands"
        >
          {filteredCommands.map((cmd, i) => (
            <li
              key={cmd.name}
              role="option"
              aria-selected={i === menuIndex}
              className={
                'composer__slash-item' +
                (i === menuIndex ? ' composer__slash-item--active' : '')
              }
              onMouseDown={(e) => {
                e.preventDefault();
                selectCommand(cmd);
              }}
              onMouseEnter={() => setMenuIndex(i)}
            >
              <span className="composer__slash-name">{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="composer__slash-hint" aria-label={`Arguments: ${cmd.argumentHint}`}>
                  {cmd.argumentHint}
                </span>
              )}
              {cmd.description && (
                <span className="composer__slash-desc">{cmd.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="composer__row">
        {/* Hidden file input — triggered by the attach button */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-hidden="true"
          onChange={(e) => addFiles(e.target.files)}
          // Reset value so the same file can be re-attached after removal.
          onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
        />

        {/* Single bordered shell holds the textarea and an inset toolbar so
            the attach icon and Send sit on the input's bottom edge. */}
        <div className="composer__shell">
          <textarea
            ref={textRef}
            className="composer__input"
            placeholder={
              isStreaming
                ? ''
                : 'Send a prompt… (/ for commands, add args, then Enter)'
            }
            disabled={disabled || isStreaming}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            aria-label="Prompt input"
            aria-autocomplete={commands.length > 0 ? 'list' : 'none'}
            aria-expanded={isMenuOpen}
            aria-haspopup={commands.length > 0 ? 'listbox' : undefined}
          />

          <div className="composer__toolbar">
            <button
              type="button"
              className={'composer__attach' + (!supportsImages ? ' composer__attach--off' : '')}
              // Truly disable only when pi is unavailable. For a text-only
              // model use aria-disabled (not `disabled`) so the button stays
              // hoverable and its `title` tooltip still appears.
              disabled={disabled}
              aria-disabled={!supportsImages}
              title={
                supportsImages
                  ? 'Attach image'
                  : `${modelName ?? 'This model'} doesn't accept images`
              }
              aria-label="Attach image"
              onClick={() => {
                if (disabled) return;
                if (!supportsImages) {
                  showImageNote(`${modelName ?? 'This model'} doesn't accept images.`);
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            {isStreaming && (
              <div className="composer__working" role="status" aria-live="polite">
                <span className="composer__working-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
                <span className="composer__working-label">Agent is working…</span>
              </div>
            )}

            {isStreaming ? (
              <button
                className="composer__abort"
                type="button"
                onClick={handleAbort}
                aria-label="Stop agent"
                title="Stop agent"
              >
                ■ Stop
              </button>
            ) : (
              <button
                className="composer__send"
                type="button"
                onClick={handleSend}
                disabled={disabled}
                aria-label="Send prompt"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
