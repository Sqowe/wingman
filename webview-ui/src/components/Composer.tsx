/**
 * Composer — prompt input with send + abort buttons.
 *
 * - Enter sends, Shift+Enter inserts newline.
 * - When isStreaming is true, shows an Abort button instead of Send.
 * - Disabled when pi is not found.
 */
import React, { useRef } from 'react';
import type { PiStatus } from '@shared/messages';
import { vscode } from '../vscodeApi';

interface Props {
  isStreaming: boolean;
  piStatus: PiStatus | null;
  promptError: string | null;
  onSend: (text: string) => void;
}

export function Composer({ isStreaming, piStatus, promptError, onSend }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const disabled = piStatus?.kind === 'not-found';

  const handleSend = () => {
    const text = textRef.current?.value.trim() ?? '';
    if (!text || disabled) return;
    onSend(text);
    if (textRef.current) textRef.current.value = '';
  };

  const handleAbort = () => {
    vscode.postMessage({ type: 'abortTurn' });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  };

  return (
    <div className="composer">
      {promptError && (
        <p className="composer__error" role="alert">
          {promptError}
        </p>
      )}
      <div className="composer__row">
        <textarea
          ref={textRef}
          className="composer__input"
          placeholder={
            isStreaming
              ? 'Agent is working…'
              : 'Send a prompt… (Enter to send, Shift+Enter for newline)'
          }
          rows={3}
          disabled={disabled || isStreaming}
          onKeyDown={handleKeyDown}
          aria-label="Prompt input"
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
