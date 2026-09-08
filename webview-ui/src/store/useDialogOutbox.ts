/**
 * useDialogOutbox — delivers queued question-card answers to the extension host.
 *
 * The store deliberately does not call `postMessage`: keeping the reducer pure
 * makes it testable without a host and matches how the rest of the webview sends
 * outbound messages. The consequence is that something has to carry a settled
 * answer from the store to the host, and that is this hook.
 *
 * It lives at app level rather than inside the card component on purpose. pi is
 * *blocked* on an open question, so delivery must not depend on the card still
 * being mounted — react-window unmounts rows that scroll out of the viewport, and
 * answering a card changes its height, which can trigger exactly that. Draining
 * here is independent of the transcript's virtualisation.
 *
 * Extracted from App.tsx so the delivery tests exercise the real code rather than
 * a copy of it.
 */
import { useEffect } from 'react';
import { useChatStore } from './index';
import { vscode } from '../vscodeApi';

export function useDialogOutbox(): void {
  const pendingDialogAnswers = useChatStore((s) => s.pendingDialogAnswers);
  const flushDialogAnswers = useChatStore((s) => s.flushDialogAnswers);

  useEffect(() => {
    if (pendingDialogAnswers.length === 0) return;
    for (const answer of pendingDialogAnswers) {
      vscode.postMessage(
        'cancelled' in answer
          ? { type: 'uiDialogAnswer', id: answer.id, cancelled: true }
          : { type: 'uiDialogAnswer', id: answer.id, value: answer.value },
      );
    }
    // Clears the whole queue, which is safe because the effect runs after React
    // has applied the update that queued these: what was rendered is what was
    // just sent. An answer settled later arrives as a new array and re-runs this.
    flushDialogAnswers();
  }, [pendingDialogAnswers, flushDialogAnswers]);
}
