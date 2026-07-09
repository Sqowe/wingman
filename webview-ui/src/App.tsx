/**
 * App — root component for Phases 2 + 3.
 *
 * Replaces the Phase 1 dev console with:
 *  - A virtualized MessageList driven by the Zustand store.
 *  - A Composer with abort support.
 *  - rAF-coalesced dispatch of streaming deltas (never re-renders per delta).
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { HostMessage, PiStatus, AttachedImage, InstructionFileEntry, InstructionFilesInfo } from '@shared/messages';
import { vscode } from './vscodeApi';
import { useChatStore, normalizeShowViewDiffButton } from './store';
import type { UiWidget } from './store';
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
  const uiStatuses = useChatStore((s) => s.uiStatuses);
  const uiWidgets = useChatStore((s) => s.uiWidgets);
  const uiTitle = useChatStore((s) => s.uiTitle);
  const uiEditorText = useChatStore((s) => s.uiEditorText);
  const supportsImages = useChatStore((s) => s.supportsImages);
  const modelName = useChatStore((s) => s.modelName);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const dispatchEvents = useChatStore((s) => s.dispatchEvents);
  const setDiffError = useChatStore((s) => s.setDiffError);
  const setCommands = useChatStore((s) => s.setCommands);
  const setUiStatus = useChatStore((s) => s.setUiStatus);
  const setUiWidget = useChatStore((s) => s.setUiWidget);
  const setUiTitle = useChatStore((s) => s.setUiTitle);
  const setUiEditorText = useChatStore((s) => s.setUiEditorText);
  const resetSession = useChatStore((s) => s.resetSession);
  const setMessages = useChatStore((s) => s.setMessages);
  const setModelState = useChatStore((s) => s.setModelState);
  const setChatConfig = useChatStore((s) => s.setChatConfig);
  const instructionFiles = useChatStore((s) => s.instructionFiles);
  const setInstructionFiles = useChatStore((s) => s.setInstructionFiles);

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

        case 'sessionMessages':
          // Load messages from a switched-to session.
          pendingEvents.current = [];
          if (rafId.current !== undefined) {
            cancelAnimationFrame(rafId.current);
            rafId.current = undefined;
          }
          setMessages(msg.messages);
          break;

        case 'uiStatus':
          setUiStatus(msg.key, msg.text);
          break;

        case 'uiWidget':
          setUiWidget(msg.key, msg.lines, msg.placement);
          break;

        case 'uiTitle':
          setUiTitle(msg.title);
          break;

        case 'uiSetEditorText':
          setUiEditorText(msg.text);
          break;

        case 'modelState':
          setModelState(msg.state);
          break;

        case 'chatConfig':
          setChatConfig(normalizeShowViewDiffButton(msg.showViewDiffButton));
          break;

        case 'instructionFiles':
          setInstructionFiles(msg.info);
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

  const handleSend = useCallback((text: string, images?: AttachedImage[]) => {
    const imageCount = images?.length ?? 0;
    // Record the turn in the transcript. Pass the real text (may be empty for
    // an image-only prompt); the attached-image count renders as a badge.
    if (text || imageCount > 0) addUserMessage(text, imageCount);
    vscode.postMessage({ type: 'sendPrompt', text, ...(imageCount > 0 ? { images } : {}) });
  }, [addUserMessage]);

  // Measure the space the flex layout actually allocates to the list. The old
  // approach computed it by subtracting the composer/banners/padding from the
  // container, which missed the flex `gap` and dynamic siblings (title / status
  // strip / widgets) — leaving the list a few px too tall, so react-window's
  // scroll-to-bottom stopped short and the last line got clipped. Measuring the
  // dedicated slot directly accounts for all of it, gaps included.
  const containerRef = useRef<HTMLDivElement>(null);
  const listSlotRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [listWidth, setListWidth] = useState(300);

  useEffect(() => {
    const measure = () => {
      const slot = listSlotRef.current;
      if (!slot) return;
      const rect = slot.getBoundingClientRect();
      setListHeight(Math.max(100, rect.height));
      setListWidth(Math.max(100, rect.width));
    };
    measure();
    // Observing the slot alone is enough: when banners/widgets appear or the
    // composer grows, the flex:1 slot resizes and the observer re-fires.
    const ro = new ResizeObserver(measure);
    if (listSlotRef.current) ro.observe(listSlotRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="app" ref={containerRef}>
      <PiStatusBanner status={piStatus} instructionFiles={instructionFiles} />

      {uiTitle && (
        <div className="ui-title" aria-label="Session title">{uiTitle}</div>
      )}

      {agentDown && piStatus?.kind !== 'not-found' && (
        <div className="status-banner status-banner--warning" role="alert">
          <strong>pi stopped.</strong> {agentDown}
        </div>
      )}

      <div className="message-list-slot" ref={listSlotRef}>
        <MessageList items={items} height={listHeight} width={listWidth} />
      </div>

      {/* aboveEditor widgets sit between the message list and the composer input. */}
      {uiWidgets
        .filter((w) => w.placement === 'aboveEditor')
        .map((w) => (
          <UiWidgetBlock key={w.key} widget={w} />
        ))}

      {uiStatuses.length > 0 && (
        <div className="ui-status-strip" role="status" aria-live="polite">
          {uiStatuses.map((s) => (
            <span key={s.key} className="ui-status-strip__entry">
              <span className="ui-status-strip__key">{s.key}:</span> {s.text}
            </span>
          ))}
        </div>
      )}

      <div className="composer-dock">
        <Composer
          isStreaming={isStreaming}
          piStatus={piStatus}
          promptError={promptError}
          commands={commands}
          prefillText={uiEditorText}
          onPrefillConsumed={() => setUiEditorText(null)}
          supportsImages={supportsImages}
          modelName={modelName}
          onSend={handleSend}
        />
      </div>

      {/* belowEditor widgets sit beneath the composer. */}
      {uiWidgets
        .filter((w) => w.placement === 'belowEditor')
        .map((w) => (
          <UiWidgetBlock key={w.key} widget={w} />
        ))}
    </div>
  );
}

function PiStatusBanner({
  status,
  instructionFiles,
}: {
  status: PiStatus | null;
  instructionFiles: InstructionFilesInfo | null | undefined;
}) {
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const bannerRef = React.useRef<HTMLDivElement>(null);

  // Close popover on outside click or Escape.
  React.useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (bannerRef.current && !bannerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [popoverOpen]);

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

  // For both 'found' and 'version-warning': one-line banner + optional popover.
  const fileCount = instructionFiles?.files.length;
  const showCount = instructionFiles !== undefined && instructionFiles !== null && fileCount !== undefined;
  const countSuffix = showCount && fileCount! > 0 ? ` · ${fileCount} instruction${fileCount === 1 ? '' : 's'}` : '';

  const canOpenPopover = status.kind === 'found' || status.kind === 'version-warning';

  const bannerClass =
    status.kind === 'version-warning'
      ? 'status-banner status-banner--warning status-banner--clickable'
      : 'status-banner status-banner--ok status-banner--clickable';

  const handleClick = () => { if (canOpenPopover) setPopoverOpen((o) => !o); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
  };

  return (
    <div className={bannerClass} ref={bannerRef} style={{ position: 'relative' }}>
      <div
        className="status-banner__summary"
        role="button"
        tabIndex={0}
        aria-expanded={popoverOpen}
        aria-label={`pi ${status.version} status${countSuffix}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {status.kind === 'version-warning' ? (
          <span>
            <strong>pi {status.version}</strong>
            {' '}— below tested minimum ({status.minimum}). Consider updating.{countSuffix}
          </span>
        ) : (
          <span><strong>pi {status.version}</strong> ready{countSuffix}</span>
        )}
        <span className="status-banner__chevron" aria-hidden="true">{popoverOpen ? '▾' : '▸'}</span>
      </div>

      {popoverOpen && (
        <InstructionFilesPopover
          path={status.path}
          instructionFiles={instructionFiles}
        />
      )}
    </div>
  );
}

function InstructionFilesPopover({
  path,
  instructionFiles,
}: {
  path: string;
  instructionFiles: InstructionFilesInfo | null | undefined;
}) {
  return (
    <div className="instruction-files-popover" role="tooltip">
      <div className="instruction-files-popover__path" title={path}>{path}</div>
      <div className="instruction-files-popover__body">
        {instructionFiles === undefined ? (
          <p className="instruction-files-popover__unavailable">Loading instruction file info…</p>
        ) : instructionFiles === null ? (
          <p className="instruction-files-popover__unavailable">
            Instruction file info unavailable — check the pi version or extension
            load (see Sqowe Wingman output channel).
          </p>
        ) : instructionFiles.files.length === 0 ? (
          <p className="instruction-files-popover__unavailable">No instruction files configured.</p>
        ) : (
          <ul className="instruction-files-popover__list">
            {instructionFiles.files.map((entry, i) => (
              <li key={i} className="instruction-files-popover__entry">
                <InstructionFileLabel entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InstructionFileLabel({ entry }: { entry: InstructionFileEntry }) {
  // Split on both / and \ so Windows paths work correctly.
  const baseName = entry.path ? entry.path.split(/[\/\\]/).pop() ?? entry.path : null;

  let annotation = entry.scope ?? '';
  if (entry.role === 'systemPrompt') annotation += ', replaces default';
  else if (entry.role === 'appendSystemPrompt') annotation += ', appended';

  if (entry.role === 'customPrompt') {
    return <span className="instruction-files-popover__label">custom prompt (CLI flag, replaces default)</span>;
  }

  return (
    <span className="instruction-files-popover__label">
      <span className="instruction-files-popover__basename" title={entry.path ?? undefined}>
        {baseName ?? '(unknown)'}
      </span>
      {annotation && (
        <span className="instruction-files-popover__annotation"> ({annotation})</span>
      )}
    </span>
  );
}

/** Renders a setWidget block as a collapsible pre-formatted text panel. */
function UiWidgetBlock({ widget }: { widget: UiWidget }) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className="ui-widget" data-placement={widget.placement}>
      <button
        className="ui-widget__toggle"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand widget' : 'Collapse widget'}
      >
        {collapsed ? '▶' : '▼'} <span className="ui-widget__key">{widget.key}</span>
      </button>
      {!collapsed && (
        <pre className="ui-widget__content">{widget.lines.join('\n')}</pre>
      )}
    </div>
  );
}
