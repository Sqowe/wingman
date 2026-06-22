/**
 * CopyButton — icon button that copies `text` to the clipboard via the host.
 * Briefly shows a "Copied" confirmation then resets.
 *
 * Enforces MAX_CLIPBOARD_BYTES client-side to avoid posting an oversized
 * payload that the host would silently drop (preventing a confusing broken-copy UX).
 */
import React, { useState, useCallback } from 'react';
import { vscode } from '../vscodeApi';
import { MAX_CLIPBOARD_BYTES } from '@shared/limits';

interface Props {
  text: string;
  label?: string;
  className?: string;
}

const encoder = new TextEncoder();

export function CopyButton({ text, label = 'Copy', className = '' }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleClick = useCallback(() => {
    // Guard: don't post an oversized payload the host would silently drop.
    if (encoder.encode(text).byteLength > MAX_CLIPBOARD_BYTES) {
      setState('error');
      setTimeout(() => setState('idle'), 2_000);
      return;
    }
    vscode.postMessage({ type: 'copyToClipboard', text });
    setState('copied');
    setTimeout(() => setState('idle'), 1_500);
  }, [text]);

  const display = state === 'copied' ? '✓' : state === 'error' ? '✗' : '⎘';
  const ariaLabel =
    state === 'copied' ? 'Copied!' : state === 'error' ? 'Too large to copy' : label;

  return (
    <button
      className={`copy-btn${state === 'error' ? ' copy-btn--error' : ''}${
        className ? ` ${className}` : ''
      }`}
      onClick={handleClick}
      title={ariaLabel}
      aria-label={ariaLabel}
      type="button"
    >
      {display}
    </button>
  );
}
