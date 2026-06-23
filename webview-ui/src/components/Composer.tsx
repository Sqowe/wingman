/**
 * Composer — prompt input with send + abort buttons and a `/` slash menu.
 *
 * - Enter sends, Shift+Enter inserts newline.
 * - When isStreaming is true, shows an Abort button instead of Send.
 * - Typing `/` (or `/prefix`) opens an autocomplete dropdown from the
 *   commands list; Enter or click injects the command and sends it.
 * - Disabled when pi is not found.
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PiStatus, PiCommand } from '@shared/messages';
import { vscode } from '../vscodeApi';

interface Props {
  isStreaming: boolean;
  piStatus: PiStatus | null;
  promptError: string | null;
  commands: PiCommand[];
  /** Text to pre-fill in the textarea (from pi's set_editor_text / pasteToEditor). */
  prefillText?: string | null;
  /** Called once after the pre-fill has been applied so the store can clear it. */
  onPrefillConsumed?: () => void;
  onSend: (text: string) => void;
}

export function Composer({ isStreaming, piStatus, promptError, commands, prefillText, onPrefillConsumed, onSend }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // The textarea is intentionally uncontrolled (no `value` prop, driven by ref).
  // This avoids React re-rendering on every keystroke and makes imperative
  // mutations (prefill, slash-menu injection) straightforward.
  const disabled = piStatus?.kind === 'not-found';

  // Slash-menu state.
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  // Filtered command list derived from the current input prefix.
  const filteredCommands: PiCommand[] = slashFilter === null
    ? []
    : commands.filter((c) =>
        c.name.toLowerCase().startsWith(slashFilter.toLowerCase()),
      );

  const isMenuOpen = filteredCommands.length > 0;

  // Recompute slash filter from textarea value.
  const updateSlashFilter = useCallback((value: string) => {
    // Only activate when the entire value is a slash command prefix
    // (starts with `/`, no embedded whitespace yet).
    const match = /^(\/\S*)$/.exec(value);
    if (match) {
      setSlashFilter(match[1]);
      setMenuIndex(0);
    } else {
      setSlashFilter(null);
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = textRef.current?.value.trim() ?? '';
    if (!text || disabled) return;
    onSend(text);
    if (textRef.current) textRef.current.value = '';
    setSlashFilter(null);
  }, [disabled, onSend]);

  const handleAbort = useCallback(() => {
    vscode.postMessage({ type: 'abortTurn' });
  }, []);

  /** Insert the chosen command name into the textarea and send. */
  const selectCommand = useCallback((cmd: PiCommand) => {
    if (!textRef.current) return;
    textRef.current.value = cmd.name;
    textRef.current.focus();
    setSlashFilter(null);
    // Send immediately — slash commands are self-contained.
    onSend(cmd.name);
    textRef.current.value = '';
  }, [onSend]);

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
        if (chosen && textRef.current) {
          textRef.current.value = chosen.name;
          setSlashFilter(chosen.name);
          setMenuIndex(0);
        }
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
  }, [updateSlashFilter]);

  // Apply pre-fill text from pi's set_editor_text() / pasteToEditor().
  // Runs when prefillText changes; after writing to the textarea we notify the
  // parent so the store entry is cleared (prevents re-applying on re-render).
  // Guard on null/undefined only — empty string is a valid intentional clear.
  useEffect(() => {
    if (prefillText == null || !textRef.current) return;
    textRef.current.value = prefillText;
    // Dispatch a synthetic input event so any DOM listeners (e.g. autoresize)
    // pick up the change, and update the slash-filter state to match.
    textRef.current.dispatchEvent(new Event('input', { bubbles: true }));
    textRef.current.focus();
    updateSlashFilter(prefillText);
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

  return (
    <div className="composer">
      {promptError && (
        <p className="composer__error" role="alert">
          {promptError}
        </p>
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
                // Use mousedown so the textarea doesn't lose focus before we act.
                e.preventDefault();
                selectCommand(cmd);
              }}
              onMouseEnter={() => setMenuIndex(i)}
            >
              <span className="composer__slash-name">{cmd.name}</span>
              {cmd.description && (
                <span className="composer__slash-desc">{cmd.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="composer__row">
        <textarea
          ref={textRef}
          className="composer__input"
          placeholder={
            isStreaming
              ? 'Agent is working…'
              : 'Send a prompt… (/ for commands, Enter to send)'
          }
          rows={3}
          disabled={disabled || isStreaming}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          aria-label="Prompt input"
          aria-autocomplete={commands.length > 0 ? 'list' : 'none'}
          aria-expanded={isMenuOpen}
          aria-haspopup={commands.length > 0 ? 'listbox' : undefined}
        />
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
  );
}
