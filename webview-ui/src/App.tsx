/**
 * Phase 1 — Transport dev console.
 *
 * Renders pi events as pretty-printed JSON in a scrollable console,
 * and adds a minimal prompt input so manual prompts can be fired.
 * This entire panel will be replaced by the real chat UI in Phase 2.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { HostMessage, PiStatus } from '@shared/messages';
import { vscode } from './vscodeApi';
import './App.css';

const MAX_EVENTS = 50;
/** Max total bytes retained in the dev console (UTF-8 byte count). */
const MAX_EVENT_CONSOLE_BYTES = 2_097_152; // 2 MB
/** Max bytes for a single entry before truncation. */
const MAX_ENTRY_BYTES = 65_536; // 64 KB

/** UTF-8 byte length of a string — uses TextEncoder for accuracy in the webview. */
const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).byteLength;

const PROMPT_REJECTED_LABELS: Record<string, string> = {
  'rate-limited': 'Sending too fast — please wait a moment.',
  'in-flight':    'A prompt is already in progress.',
  'too-large':    'Prompt is too large.',
  'busy':         'The agent is working — wait for it to finish.',
  'error':        'Send failed — the agent may have stopped. Try again.',
};

export default function App() {
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);
  const [agentDown, setAgentDown] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Clear both timers on unmount.
  useEffect(() => {
    return () => {
      if (sendTimerRef.current !== undefined) clearTimeout(sendTimerRef.current);
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    };
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });

    const handler = (event: MessageEvent<HostMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'piStatus':
          setPiStatus(msg.status);
          break;

        case 'agentStatus':
          setAgentDown(msg.running ? null : (msg.reason ?? 'The agent stopped.'));
          break;

        case 'agentEvent': {
          let entry = JSON.stringify(msg.event, null, 2);
          // Truncate oversized individual entries (byte-accurate).
          if (byteLength(entry) > MAX_ENTRY_BYTES) {
            // Trim until under the per-entry limit.
            while (byteLength(entry) > MAX_ENTRY_BYTES && entry.length > 0) {
              entry = entry.slice(0, Math.floor(entry.length * 0.9));
            }
            entry += '\n… [truncated]';
          }
          setEvents((prev) => {
            const next = [...prev, entry];
            // Drop oldest until within count and byte limits.
            let totalBytes = next.reduce((sum, e) => sum + byteLength(e), 0);
            while (
              next.length > MAX_EVENTS ||
              totalBytes > MAX_EVENT_CONSOLE_BYTES
            ) {
              const dropped = next.shift();
              if (dropped) totalBytes -= byteLength(dropped);
            }
            return next;
          });
          break;
        }

        case 'promptRejected': {
          const label = PROMPT_REJECTED_LABELS[msg.reason] ?? 'Prompt rejected.';
          setPromptError(label);
          setSending(false);
          if (sendTimerRef.current !== undefined) {
            clearTimeout(sendTimerRef.current);
            sendTimerRef.current = undefined;
          }
          // Auto-clear the error after 3 s.
          if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => {
            errorTimerRef.current = undefined;
            setPromptError(null);
          }, 3_000);
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-scroll the dev console to the bottom on new events (instant, not
  // smooth, to avoid continuous layout/paint work during streaming).
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [events]);

  const handleSend = () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setPromptError(null);
    setSending(true);
    vscode.postMessage({ type: 'sendPrompt', text });
    setPrompt('');
    // Re-enable after a short debounce. The host will send promptRejected if
    // the message is rejected, which also re-enables the button.
    sendTimerRef.current = setTimeout(() => {
      sendTimerRef.current = undefined;
      setSending(false);
    }, 500);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="app">
      <PiStatusBanner status={piStatus} />

      {agentDown && piStatus?.kind !== 'not-found' && (
        <div className="status-banner status-banner--warning" role="alert">
          <strong>pi stopped.</strong> {agentDown}
          <br />
          Send a prompt to restart it.
        </div>
      )}

      {/* ── Dev console ── */}
      <div className="dev-console" aria-label="Agent event stream" role="log" aria-live="polite">
        {events.length === 0 ? (
          <p className="dev-console__empty">
            No events yet — send a prompt to start.
          </p>
        ) : (
          events.map((entry, i) => (
            <pre key={i} className="dev-console__entry">
              {entry}
            </pre>
          ))
        )}
        <div ref={consoleEndRef} />
      </div>

      {/* ── Prompt error feedback ── */}
      {promptError && (
        <p className="composer__error" role="alert">
          {promptError}
        </p>
      )}

      {/* ── Prompt composer (Phase 1 minimal version) ── */}
      <div className="composer">
        <textarea
          className="composer__input"
          placeholder="Send a prompt to pi… (Enter to send, Shift+Enter for newline)"
          value={prompt}
          rows={3}
          disabled={piStatus?.kind === 'not-found'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Prompt input"
        />
        <button
          className="composer__send"
          onClick={handleSend}
          disabled={!prompt.trim() || sending || piStatus?.kind === 'not-found'}
          aria-label="Send prompt"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function PiStatusBanner({ status }: { status: PiStatus | null }) {
  if (status === null) {
    return <div className="status-banner status-banner--idle">Locating pi…</div>;
  }

  if (status.kind === 'not-found') {
    return (
      <div className="status-banner status-banner--error">
        <strong>pi not found.</strong>
        <br />
        Install with: <code>npm install -g @earendil-works/pi-coding-agent</code>
      </div>
    );
  }

  if (status.kind === 'version-warning') {
    return (
      <div className="status-banner status-banner--warning">
        <strong>pi {status.version}</strong> — below tested minimum ({status.minimum}).
        Consider updating.
        <div className="status-banner__path" title={status.path}>{status.path}</div>
      </div>
    );
  }

  return (
    <div className="status-banner status-banner--ok">
      <strong>pi {status.version}</strong> ready
      <div className="status-banner__path" title={status.path}>{status.path}</div>
    </div>
  );
}
