/**
 * App — root component for Phases 2 + 3.
 *
 * Replaces the Phase 1 dev console with:
 *  - A virtualized MessageList driven by the Zustand store.
 *  - A Composer with abort support.
 *  - rAF-coalesced dispatch of streaming deltas (never re-renders per delta).
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { HostMessage, PiStatus } from '@shared/messages';
import { vscode } from './vscodeApi';
import { useChatStore } from './store';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import type { RpcEvent } from '../../src/agent/transport';
import './App.css';

// Prompt-rejected labels (same as Phase 1).
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
  const [promptError, setPromptError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Zustand store bindings.
  const items = useChatStore((s) => s.items);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const commands = useChatStore((s) => s.commands);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const dispatchEvents = useChatStore((s) => s.dispatchEvents);
  const setDiffError = useChatStore((s) => s.setDiffError);
  const setCommands = useChatStore((s) => s.setCommands);
  const resetSession = useChatStore((s) => s.resetSession);

  // rAF coalescer: buffer incoming agentEvent messages and flush per frame.
  const pendingEvents = useRef<RpcEvent[]>([]);
  const rafId = useRef<number | undefined>(undefined);

  const flushEvents = useCallback(() => {
    rafId.current = undefined;
    const batch = pendingEvents.current;
    if (batch.length === 0) return;
    pendingEvents.current = [];
    dispatchEvents(batch);
  }, [dispatchEvents]);

  const scheduleFlush = useCallback(() => {
    if (rafId.current === undefined) {
      rafId.current = requestAnimationFrame(flushEvents);
    }
  }, [flushEvents]);

  useEffect(() => {
    return () => {
      if (rafId.current !== undefined) cancelAnimationFrame(rafId.current);
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // Host message listener.
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

        case 'agentEvent':
          pendingEvents.current.push(msg.event as RpcEvent);
          scheduleFlush();
          break;

        case 'promptRejected': {
          const label = PROMPT_REJECTED_LABELS[msg.reason] ?? 'Prompt rejected.';
          setPromptError(label);
          if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => {
            errorTimerRef.current = undefined;
            setPromptError(null);
          }, 3_000);
          break;
        }

        case 'diffError':
          setDiffError(msg.toolCallId, msg.message);
          break;

        case 'commandsList':
          setCommands(msg.commands);
          break;

        case 'sessionReset':
          // Drop any buffered (old-session) events so a pending rAF flush does
          // not repopulate the transcript we are about to clear.
          pendingEvents.current = [];
          if (rafId.current !== undefined) {
            cancelAnimationFrame(rafId.current);
            rafId.current = undefined;
          }
          resetSession();
          setPromptError(null);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [scheduleFlush]);

  // Forward the New Session shortcut (Cmd/Ctrl+Alt+N) to the host. VS Code
  // keybindings do not reach the extension while the webview iframe has focus,
  // so the package.json keybinding only fires when the view frame (not its
  // content) is focused; this covers the common case of typing in the composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        vscode.postMessage({ type: 'newSession' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSend = useCallback((text: string) => {
    addUserMessage(text);
    vscode.postMessage({ type: 'sendPrompt', text });
  }, [addUserMessage]);

  // Measure the available height for the virtualized list.
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [listWidth, setListWidth] = useState(300);

  useEffect(() => {
    const measure = () => {
      if (!containerRef.current || !composerRef.current) return;
      const total = containerRef.current.getBoundingClientRect().height;
      const composerH = composerRef.current.getBoundingClientRect().height;
      const bannerEls = containerRef.current.querySelectorAll<HTMLElement>('.status-banner');
      let bannerH = 0;
      bannerEls.forEach((el) => { bannerH += el.getBoundingClientRect().height; });
      const w = containerRef.current.getBoundingClientRect().width;
      setListHeight(Math.max(100, total - composerH - bannerH - 16));
      // w is the border-box width; subtract .app horizontal padding (2 × 12px),
      // mirroring the 16px vertical padding subtracted from the height above.
      // Without this the virtualized list overflows .app's content box and the
      // right edge gets clipped by overflow:hidden (no right padding).
      setListWidth(Math.max(100, w - 24));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    if (composerRef.current) ro.observe(composerRef.current);
    return () => ro.disconnect();
  }, [piStatus, agentDown]);

  return (
    <div className="app" ref={containerRef}>
      <PiStatusBanner status={piStatus} />

      {agentDown && piStatus?.kind !== 'not-found' && (
        <div className="status-banner status-banner--warning" role="alert">
          <strong>pi stopped.</strong> {agentDown}
        </div>
      )}

      <MessageList items={items} height={listHeight} width={listWidth} />

      <div ref={composerRef}>
        <Composer
          isStreaming={isStreaming}
          piStatus={piStatus}
          promptError={promptError}
          commands={commands}
          onSend={handleSend}
        />
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
