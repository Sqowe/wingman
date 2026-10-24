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
import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PiStatus, PiCommand, AttachedImage } from '@shared/messages';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT, MAX_TOTAL_IMAGE_BYTES, ALLOWED_IMAGE_MIME_TYPES } from '@shared/limits';
import { vscode } from '../vscodeApi';
import { slashFilterFromValue, filterCommands, buildInsertedText, isSlashCommand } from '../lib/slash-commands';

/**
 * How long a pending image read may block the prompt. A read that never
 * completes must not lock the composer — past this point the text is sent
 * without the image and the user is told so.
 */
const PENDING_READ_TIMEOUT_MS = 10_000;

/** Format a byte budget for the user-facing notes, so the copy cannot drift. */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

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

  // ── Inline note + diagnostics ────────────────────────────────────────────
  //
  // Declared before the attachment machinery, which reports into both.

  /** A brief inline note shown above the composer (auto-clears after 5 s). */
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
    }, 5_000);
  }, []);

  /**
   * Report an internal step of the image-attachment path to the host, which
   * writes it to the "Sqowe Wingman" output channel. Diagnostic only — it
   * changes no behaviour. Without it, a file that is silently rejected (wrong
   * MIME, failed read, Enter pressed while the read is still running) leaves
   * no trace at all, and the user just sees "the model never saw my image".
   */
  const diag = useCallback((scope: string, detail: string) => {
    try {
      vscode.postMessage({ type: 'diag', scope, detail });
    } catch {
      // Diagnostics must never break the composer.
    }
  }, []);

  // ── Attachment state ──────────────────────────────────────────────────────
  //
  // A single state list keeps `image` and `previewUrl` in one atomic entry so
  // the two arrays can never desync. All mutations go through `applyAttach`;
  // no preview URL is ever created without a matching image and vice versa.

  interface AttachEntry { image: AttachedImage; previewUrl: string; }

  /**
   * Mirror of the attachment state.
   *
   * `handleSend` must send *every* attachment, including one added after the
   * last render. The mirror is written synchronously wherever the state
   * changes — never inside a reducer, which React may invoke twice — so it is
   * never stale at send time.
   */
  const attachmentsRef = useRef<AttachEntry[]>([]);

  type AttachAction =
    | { type: 'append'; entry: AttachEntry }
    | { type: 'remove'; idx: number }
    | { type: 'clear' };

  const [attachments, setAttachments] = useState<AttachEntry[]>([]);

  /**
   * Apply an attachment change: compute the next list, release the preview
   * URLs that are dropped, and update the rendered state and the mirror
   * together.
   */
  const applyAttach = useCallback((action: AttachAction) => {
    const current = attachmentsRef.current;
    let next: AttachEntry[];
    switch (action.type) {
      case 'append': {
        // Enforce the count + total-byte caps atomically here, not only in the
        // addFiles pre-clamp: concurrent FileReader completions could otherwise
        // overshoot the limits.
        const bytes = current.reduce((sum, e) => sum + e.image.size, 0);
        const overCount = current.length >= MAX_IMAGES_PER_PROMPT;
        const overBytes = bytes + action.entry.image.size > MAX_TOTAL_IMAGE_BYTES;
        if (overCount || overBytes) {
          // A rejected attachment must not vanish without a word — and the
          // note must name the limit that actually rejected it.
          URL.revokeObjectURL(action.entry.previewUrl);
          const name = action.entry.image.fileName ?? 'image';
          diag(
            'composer.attach',
            `REJECTED "${name}" — ${overCount ? 'per-prompt image cap' : 'total size cap'} reached`,
          );
          showImageNote(
            overCount
              ? `Maximum of ${MAX_IMAGES_PER_PROMPT} images per prompt reached — "${name}" was not attached.`
              : `Total image size limit (${formatMb(MAX_TOTAL_IMAGE_BYTES)}) reached — "${name}" was not attached.`,
          );
          return;
        }
        next = [...current, action.entry];
        break;
      }
      case 'remove': {
        const removed = current[action.idx];
        if (removed) URL.revokeObjectURL(removed.previewUrl);
        next = current.filter((_, i) => i !== action.idx);
        break;
      }
      case 'clear':
        current.forEach((e) => URL.revokeObjectURL(e.previewUrl));
        next = [];
        break;
    }
    attachmentsRef.current = next;
    setAttachments(next);
  }, [diag, showImageNote]);

  // Derive plain images array for send path (no preview URLs needed by host).
  const images: AttachedImage[] = attachments.map((e) => e.image);

  /**
   * Generation counter. Incremented whenever attachments are cleared (send,
   * model-gate clear). FileReader onload callbacks capture the generation at
   * read-start and discard if it changed, preventing stale reads re-appending.
   */
  const attachGenRef = useRef(0);

  /**
   * The readers currently in flight, each with the moment it started. They
   * are aborted when the attachments are cleared (send, model switch,
   * unmount): a read that is left running would block every later prompt —
   * including plain text — with "still loading the attached image", even
   * though no attachment is left to load.
   *
   * The start time is per reader, so a read that hangs does not condemn a
   * younger one that is still making progress.
   */
  const activeReadersRef = useRef<Array<{ reader: FileReader; startedAt: number }>>([]);

  /**
   * Abort every read in flight. Called whenever the attachments are
   * discarded, so no orphaned read can block the next prompt.
   */
  const cancelPendingReads = useCallback(() => {
    const readers = activeReadersRef.current;
    activeReadersRef.current = [];
    for (const { reader } of readers) {
      try {
        reader.abort();
      } catch {
        // The reader may already be done — nothing to abort.
      }
    }
  }, []);

  // Revoke all blob URLs and drop in-flight reads on unmount.
  useEffect(() => {
    return () => {
      // Bump the generation first, so a read callback that was already
      // queued discards itself instead of appending to a dead component.
      attachGenRef.current += 1;
      cancelPendingReads();
      applyAttach({ type: 'clear' });
    };
  }, [applyAttach, cancelPendingReads]);

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

  // Clear any pending images when the model changes to one that doesn't support images.
  useEffect(() => {
    if (supportsImages) return;
    const hadAttachments = attachments.length > 0;
    const hadPendingReads = activeReadersRef.current.length > 0;
    if (!hadAttachments && !hadPendingReads) return;
    // A read that is still running would keep blocking every later prompt —
    // it must be aborted together with the attachments.
    attachGenRef.current += 1;
    cancelPendingReads();
    if (hadAttachments) {
      applyAttach({ type: 'clear' });
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
    if (!files) {
      diag('composer.addFiles', 'called with null file list');
      return;
    }

    const fileArray = Array.from(files);
    diag('composer.addFiles', `received ${fileArray.length} file(s): ${
      fileArray.map((f) => `${f.name} (${f.type || 'no type'}, ${f.size}B)`).join(', ') || 'none'
    }`);
    const accepted: File[] = [];

    for (const file of fileArray) {
      if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        // Previously dropped without a word — the user saw no chip, no note,
        // and no explanation. Say it, and say why.
        diag('composer.addFiles', `REJECTED "${file.name}": mime "${file.type || 'unknown'}" not allowed`);
        showImageNote(
          `"${file.name}" is not a supported image type (${ALLOWED_IMAGE_MIME_TYPES.join(', ')}) — not attached.`,
        );
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        diag('composer.addFiles', `REJECTED "${file.name}": ${file.size}B exceeds the per-image cap`);
        showImageNote(`"${file.name}" exceeds the ${formatMb(MAX_IMAGE_BYTES)} image limit and was not attached.`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length === 0) {
      diag('composer.addFiles', 'nothing accepted');
      return;
    }

    // Read current counts/bytes directly from the mirror (not inside
    // a setState updater, so no side effects in updaters). The mirror is
    // always current, so this callback need not be recreated on every
    // attachment change.
    const currentEntries = attachmentsRef.current;
    const currentCount = currentEntries.length;
    const currentBytes = currentEntries.reduce((s, e) => s + e.image.size, 0);
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
        showImageNote(`Total image size limit (${formatMb(MAX_TOTAL_IMAGE_BYTES)}) reached; remaining images not added.`);
        break;
      }
      projectedBytes += file.size;
      toProcess.push(file);
    }

    if (toProcess.length === 0) {
      diag('composer.addFiles', 'nothing left to process after the count/size pre-clamp');
      return;
    }

    const capturedGen = attachGenRef.current;

    for (const file of toProcess) {
      const previewUrl = URL.createObjectURL(file);

      const reader = new FileReader();

      const cleanup = () => URL.revokeObjectURL(previewUrl);

      activeReadersRef.current.push({ reader, startedAt: Date.now() });
      diag('composer.read', `reading "${file.name}" (${file.type}, ${file.size}B)`);

      /** Drop the reader from the in-flight list and settle the counter. */
      const settleRead = (): boolean => {
        activeReadersRef.current = activeReadersRef.current.filter((r) => r.reader !== reader);
        // The read still belongs to the current generation only if nothing
        // was cleared meanwhile — otherwise it was cancelled on purpose.
        return attachGenRef.current === capturedGen;
      };

      reader.onload = (ev) => {
        const isCurrent = settleRead();
        const result = ev.target?.result as string | undefined;
        if (!isCurrent) {
          diag('composer.read', `read of "${file.name}" discarded — attachments were cleared meanwhile`);
          cleanup();
          return;
        }
        if (!result) {
          diag('composer.read', `read of "${file.name}" produced no data`);
          showImageNote(`Could not read "${file.name}" — try the 📎 button or another file.`);
          cleanup();
          return;
        }
        const commaIdx = result.indexOf(',');
        const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        diag('composer.read', `read of "${file.name}" ok — ${data.length} base64 chars`);
        // Append the image and its previewUrl atomically. The attach step
        // re-checks the count/byte caps, so concurrent reads completing
        // together can't overshoot the limits — the pre-clamp above is the
        // fast path, this is the safety net.
        applyAttach({
          type: 'append',
          entry: {
            image: { data, mimeType: file.type as AttachedImage['mimeType'], fileName: file.name, size: file.size },
            previewUrl,
          },
        });
      };

      reader.onerror = () => {
        const isCurrent = settleRead();
        diag('composer.read', `read of "${file.name}" FAILED`);
        if (isCurrent) {
          showImageNote(`Could not read "${file.name}" — try the 📎 button or another file.`);
        }
        cleanup();
      };

      reader.onabort = () => {
        // An abort is always internal here (a send, a model switch, the
        // unmount, the stuck-read timeout) — there is no user cancel control
        // for an in-flight read. The reason is always explained by the call
        // site, so the abort itself stays silent: a note here would overwrite
        // the message that actually explains what happened.
        settleRead();
        diag('composer.read', `read of "${file.name}" aborted`);
        cleanup();
      };

      reader.readAsDataURL(file);
    }
  }, [applyAttach, cancelPendingReads, showImageNote, diag]);

  const handleSend = useCallback(() => {
    const text = textRef.current?.value.trim() ?? '';
    // Send what is attached *now* — the mirror is updated by the reducer, so
    // an image added since the last render is included instead of being
    // silently dropped from the prompt.
    const currentEntries = attachmentsRef.current;
    const currentImages: AttachedImage[] = currentEntries.map((e) => e.image);
    if ((!text && currentImages.length === 0) || disabled) return;

    // An image whose FileReader is still running is not in the attachments
    // yet. Sending now would ship the prompt without it — and the attachment
    // would be discarded by the generation bump below, so the image would be
    // lost without a trace. Hold the send instead and tell the user to retry.
    //
    // Each read carries its own start time: a read that is still making
    // progress keeps the prompt waiting, while a read that has clearly hung
    // is dropped instead of blocking the composer forever.
    const now = Date.now();
    const inFlight = activeReadersRef.current;
    const stillLoading = inFlight.filter((r) => now - r.startedAt < PENDING_READ_TIMEOUT_MS);
    const hung = inFlight.filter((r) => now - r.startedAt >= PENDING_READ_TIMEOUT_MS);
    if (stillLoading.length > 0) {
      diag('composer.send', `BLOCKED — ${stillLoading.length} image read(s) still in flight`);
      showImageNote('Still loading the attached image — press Enter again in a moment.');
      return;
    }
    if (hung.length > 0) {
      diag(
        'composer.send',
        `${hung.length} image read(s) did not finish in time — dropping them`,
      );
      // Bump the generation before aborting, so the abort callback sees a
      // stale generation and stays silent.
      attachGenRef.current += 1;
      for (const { reader } of hung) {
        try {
          reader.abort();
        } catch {
          // The reader may already be done — nothing to abort.
        }
      }
      activeReadersRef.current = [];
    }

    // Known slash commands never carry image attachments — the command text is
    // expanded by pi before the LLM sees it, and images would be misleading.
    // isSlashCommand() returns true only for commands present in the known
    // commands list (non-builtIn); unknown slash tokens and absolute paths
    // are not treated as commands and images are sent normally with them.
    // If images are currently attached and a slash command is being sent,
    // show a brief note but keep the attachments so the user can send them
    // with their next regular prompt (no silent data loss).
    const isCmd = isSlashCommand(text, commands);
    if (isCmd && currentImages.length > 0) {
      showImageNote('Images are not sent with slash commands — attachments kept for your next prompt.');
    }
    const sendImages = isCmd ? undefined : (currentImages.length > 0 ? currentImages : undefined);
    diag(
      'composer.send',
      `sending images=${sendImages?.length ?? 0} textLen=${text.length} isCmd=${isCmd}`,
    );
    if (hung.length > 0) {
      // Say what actually happened: the images that were ready did go out.
      showImageNote(
        sendImages && sendImages.length > 0
          ? 'An attached image did not finish loading — the prompt was sent with the image(s) that were ready.'
          : 'The attached image did not finish loading — sending the text without it.',
      );
    }
    onSend(text, sendImages);
    if (textRef.current) { textRef.current.value = ''; autoResize(); }
    // Only clear attachments after a regular (non-slash) send.
    if (!isCmd) {
      // `applyAttach` empties the mirror synchronously, so a second Enter in
      // the same turn cannot resend the same attachments. Zeroing the mirror
      // here as well would hide the list from `applyAttach` — and the preview
      // URLs it has to revoke would leak.
      attachGenRef.current += 1;
      cancelPendingReads();
      applyAttach({ type: 'clear' });
    }
    setSlashFilter(null);
  }, [commands, disabled, onSend, showImageNote, diag, applyAttach, cancelPendingReads]);

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
    if (!items) {
      diag('composer.paste', 'clipboardData.items is unavailable');
      return;
    }

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }

    // Ordinary text pastes are the hot path — they leave no trace in the
    // output channel. Only the image pipeline is worth a line.
    if (imageItems.length === 0) return;

    diag(
      'composer.paste',
      `${items.length} clipboard item(s), ${imageItems.length} image item(s): ` +
      imageItems.map((item) => `${item.kind}/${item.type || 'no type'}`).join(', '),
    );

    // Prevent the default paste behavior (which would insert a file reference
    // into the textarea) whenever image items are present.
    e.preventDefault();

    // Modality gate — ignore image paste on text-only models.
    if (!supportsImages) {
      diag('composer.paste', 'active model does not accept images — paste ignored');
      showImageNote(
        `${modelName ?? 'This model'} doesn't accept images.`,
      );
      return;
    }

    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) {
      // The clipboard holds something that looks like an image, but the
      // browser refused to hand it over as a file. Say so — a silent drop
      // here is what makes "the model never saw my image" unexplainable.
      diag('composer.paste', 'image items present, but getAsFile() yielded no file');
      showImageNote('Could not read the image from the clipboard — attach the file with the 📎 button instead.');
      return;
    }
    diag('composer.paste', `getAsFile() yielded ${files.length} file(s) from ${imageItems.length} image item(s)`);
    addFiles(files);
  }, [supportsImages, modelName, addFiles, showImageNote, diag]);

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
    diag('composer.drop', `dropped ${e.dataTransfer?.files?.length ?? 0} file(s)`);
    if (!supportsImages) {
      showImageNote(`${modelName ?? 'This model'} doesn't accept images.`);
      return;
    }
    addFiles(e.dataTransfer.files);
  }, [supportsImages, modelName, addFiles, showImageNote, diag]);

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
    applyAttach({ type: 'remove', idx });
  }, [applyAttach]);

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
