/**
 * Zustand store — accumulates pi RPC events into typed chat state.
 *
 * All mutation goes through `dispatchEvents(events[])` which is called
 * from the animation-frame coalescer in App.tsx, never on every raw delta.
 */

import { create } from 'zustand';
import type { RpcEvent } from '../../../src/agent/transport';
import type { PiCommand, ModelState, InstructionFilesInfo } from '../../../src/shared/messages';

// ─── Domain types ─────────────────────────────────────────────────────────────

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; collapsed: boolean };

export interface UserItem {
  itemKind: 'user';
  id: string;
  text: string;
  /** Attached image MIME types (for transcript display; data not stored here). */
  imageCount?: number;
  timestamp: number;
}

export interface AssistantItem {
  itemKind: 'assistant';
  /** Matches the toolCallId of tools spawned during this message's turn. */
  id: string;
  blocks: ContentBlock[];
  isComplete: boolean;
  timestamp: number;
}

export interface ToolRunItem {
  itemKind: 'tool';
  /** pi's toolCallId — used to correlate start/update/end events. */
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Accumulated partial output (replaced, not appended, on each update). */
  partialOutput: string;
  /** Set on tool_execution_end. */
  finalOutput: string | null;
  /** Raw result details (preserved for Phase 4 diff service). */
  details: Record<string, unknown> | null;
  isError: boolean;
  isComplete: boolean;
  /** Set when a diff open or apply operation fails for this tool card. */
  diffError: string | null;
}

export interface SystemItem {
  itemKind: 'system';
  id: string;
  text: string;
  level: 'info' | 'warning' | 'error';
}

export type ChatItem = UserItem | AssistantItem | ToolRunItem | SystemItem;

// ── Restoring a stored session into ChatItems ───────────────────────
//
// `get_messages` returns pi `AgentMessage` objects (see rpc.md "Message
// Types"), a different shape from the live `tool_execution_*` event stream.
// To make a restored transcript render identically to a live one, we
// reconstruct the same ChatItem shapes: assistant `toolCall` blocks become
// ToolRunItem cards, and the matching `toolResult` message fills in each
// card's output. `bashExecution` messages (from pi's `bash` RPC command)
// render as completed bash cards.

/** Build a completed ToolRunItem from an assistant `toolCall` content block. */
function toolCallBlockToItem(block: Record<string, unknown>): ToolRunItem {
  return {
    itemKind: 'tool',
    toolCallId: String(block['id'] ?? ''),
    toolName: String(block['name'] ?? ''),
    args: (block['arguments'] as Record<string, unknown>) ?? {},
    partialOutput: '',
    finalOutput: null, // filled in when the matching toolResult arrives
    details: null,
    diffError: null,
    isError: false,
    isComplete: true, // historical tool calls are always complete
  };
}

/**
 * Append the ChatItem(s) for one stored AgentMessage to `items`, threading
 * tool calls through `toolsByCallId` so a later `toolResult` message can fill
 * in the matching card's output/details. One assistant message can yield an
 * assistant bubble plus several tool cards, so this appends rather than
 * returning a single item.
 */
function appendAgentMessage(
  items: ChatItem[],
  toolsByCallId: Map<string, ToolRunItem>,
  msg: Record<string, unknown>,
): void {
  const role = msg['role'] as string | undefined;
  const timestamp = typeof msg['timestamp'] === 'number' ? (msg['timestamp'] as number) : Date.now();

  if (role === 'user') {
    const content = msg['content'];
    const text = typeof content === 'string' ? content : extractTextFromContent(content);
    items.push({ itemKind: 'user', id: nextId(), text, timestamp });
    return;
  }

  if (role === 'assistant') {
    const content = msg['content'];
    const blocks: ContentBlock[] = [];
    const toolCards: ToolRunItem[] = [];
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        const t = block['type'];
        if (t === 'text' && typeof block['text'] === 'string') {
          blocks.push({ kind: 'text', text: block['text'] as string });
        } else if (t === 'thinking' && typeof block['thinking'] === 'string') {
          blocks.push({ kind: 'thinking', text: block['thinking'] as string, collapsed: true });
        } else if (t === 'toolCall') {
          toolCards.push(toolCallBlockToItem(block));
        }
      }
    }
    // Emit an assistant bubble only when it carries visible text/thinking; a
    // message that is purely tool calls renders as its tool cards alone.
    if (blocks.length > 0) {
      items.push({ itemKind: 'assistant', id: nextId(), blocks, isComplete: true, timestamp });
    }
    for (const card of toolCards) {
      items.push(card);
      if (card.toolCallId) toolsByCallId.set(card.toolCallId, card);
    }
    return;
  }

  if (role === 'toolResult') {
    const callId = String(msg['toolCallId'] ?? '');
    const output = extractTextFromContent(msg['content']);
    const details =
      typeof msg['details'] === 'object' && msg['details'] !== null
        ? (msg['details'] as Record<string, unknown>)
        : null;
    const isError = Boolean(msg['isError']);
    const card = toolsByCallId.get(callId);
    if (card) {
      // Mutate the already-pushed card in place (same object reference).
      card.finalOutput = output;
      card.isError = isError;
      if (details) card.details = details;
    } else {
      // Orphan result with no captured call — render standalone so output
      // isn't silently dropped.
      items.push({
        itemKind: 'tool',
        toolCallId: callId,
        toolName: String(msg['toolName'] ?? ''),
        args: {},
        partialOutput: '',
        finalOutput: output,
        details,
        diffError: null,
        isError,
        isComplete: true,
      });
    }
    return;
  }

  if (role === 'bashExecution') {
    const exitCode = typeof msg['exitCode'] === 'number' ? (msg['exitCode'] as number) : 0;
    items.push({
      itemKind: 'tool',
      toolCallId: nextId(),
      toolName: 'bash',
      args: { command: msg['command'] ?? '' },
      partialOutput: '',
      finalOutput: typeof msg['output'] === 'string' ? (msg['output'] as string) : '',
      details: null,
      diffError: null,
      isError: exitCode !== 0,
      isComplete: true,
    });
    return;
  }
  // Unknown roles are ignored.
}

// ─── Store shape ──────────────────────────────────────────────────────────────

// ─── UI protocol state ────────────────────────────────────────────────────────

/** An active status entry from pi's setStatus() call. */
export interface UiStatusEntry {
  key: string;
  text: string;
}

/** An active widget block from pi's setWidget() call. */
export interface UiWidget {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

interface ChatState {
  items: ChatItem[];
  isStreaming: boolean;
  /** id of the AssistantItem currently being streamed (null when idle). */
  _currentAssistantId: string | null;
  /** Slash commands available in this session (from get_commands). */
  commands: PiCommand[];
  /** Whether the active model accepts image input (from modelState message). */
  supportsImages: boolean;
  /** Human-readable name of the active model (for UI messaging). */
  modelName: string | null;
  /** Whether to show the View Diff button on completed edit tool cards (from chatConfig message). */
  showViewDiffButton: boolean;
  /**
   * Resolved instruction files from pi's bundled extension.
   * null  = info unavailable (old pi, extension load failure, timeout).
   * undefined = not yet received (initial state before first session start).
   */
  instructionFiles: InstructionFilesInfo | null | undefined;
  /** Active status entries from pi's setStatus() calls (keyed by statusKey). */
  uiStatuses: UiStatusEntry[];
  /** Active widget blocks from pi's setWidget() calls (keyed by widgetKey). */
  uiWidgets: UiWidget[];
  /** Optional subtitle from pi's setTitle() call. */
  uiTitle: string | null;
  /** Pending pre-fill text from pi's set_editor_text() call. */
  uiEditorText: string | null;
  /**
   * Manual expand/collapse overrides for tool cards, keyed by toolCallId.
   * Absent key = follow the auto default (expanded while running, collapsed
   * once done). A boolean = the user's explicit toggle, which then sticks.
   * Held in the store (not local component state) so it survives the
   * unmount/remount react-window does as cards scroll out of the viewport
   * during streaming — otherwise auto-scroll would wipe a manual toggle.
   */
  toolCardExpanded: Record<string, boolean>;
}

interface ChatActions {
  /** Append a user message immediately when the user presses Send. */
  addUserMessage: (text: string, imageCount?: number) => void;
  /** Collapse / expand a thinking block. */
  toggleThinking: (itemId: string, blockIndex: number) => void;
  /** Set a diff error on a tool card (from host diffError message). */
  setDiffError: (toolCallId: string, message: string) => void;
  /** Record a manual expand/collapse override for a tool card (keyed by toolCallId). */
  setToolCardExpanded: (toolCallId: string, expanded: boolean) => void;
  /** Replace the current slash commands list. */
  setCommands: (commands: PiCommand[]) => void;
  /** Update model capabilities from a modelState host message. */
  setModelState: (state: ModelState | null) => void;
  /** Update the chat UI config (View Diff button visibility) from a chatConfig host message. */
  setChatConfig: (showViewDiffButton: boolean) => void;
  /** Update resolved instruction files from an instructionFiles host message. */
  setInstructionFiles: (info: InstructionFilesInfo | null) => void;
  /** Set or clear a status entry (key → text | null). */
  setUiStatus: (key: string, text: string | null) => void;
  /** Set or clear a widget block (key → lines[] | null). */
  setUiWidget: (key: string, lines: string[] | null, placement: 'aboveEditor' | 'belowEditor') => void;
  /** Set the UI subtitle from pi's setTitle(). */
  setUiTitle: (title: string) => void;
  /** Set the pending composer pre-fill text; pass null to clear after consuming. */
  setUiEditorText: (text: string | null) => void;
  /**
   * Clear the rendered transcript and per-turn state when the session is
   * replaced by a fresh, empty one. The slash command list is left intact
   * (it is project-scoped and managed separately via setCommands).
   */
  resetSession: () => void;
  /**
   * Replace the entire transcript with messages from a loaded session.
   * Called after switching sessions.
   */
  setMessages: (messages: unknown[]) => void;
  /**
   * Process a batch of raw pi RPC events in one store update.
   * Called from the rAF coalescer — never call per-delta.
   */
  dispatchEvents: (events: RpcEvent[]) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce an untrusted `showViewDiffButton` value (from the host message stream)
 * to a boolean, defaulting to `true` for anything that isn't an explicit
 * `false`. Defends against contract drift / malformed messages so the UI never
 * hides the View Diff button unintentionally.
 */
export function normalizeShowViewDiffButton(raw: unknown): boolean {
  return raw === false ? false : true;
}

let _idCounter = 0;
function nextId(): string {
  return `item-${++_idCounter}`;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text: string } => typeof c === 'object' && c !== null && 'text' in c)
    .map((c) => c.text)
    .join('');
}

function applyEvent(state: ChatState, event: RpcEvent): void {
  switch (event.type) {
    case 'agent_start':
      state.isStreaming = true;
      break;

    case 'agent_end':
      state.isStreaming = false;
      state._currentAssistantId = null;
      break;

    case 'message_start': {
      const msg = event.message as { role?: string; timestamp?: number } | undefined;
      if (msg?.role === 'assistant') {
        const id = nextId();
        state._currentAssistantId = id;
        state.items.push({
          itemKind: 'assistant',
          id,
          blocks: [],
          isComplete: false,
          timestamp: msg.timestamp ?? Date.now(),
        });
      }
      break;
    }

    case 'message_update': {
      if (!state._currentAssistantId) break;
      const item = state.items.find(
        (i): i is AssistantItem =>
          i.itemKind === 'assistant' && i.id === state._currentAssistantId,
      );
      if (!item) break;

      const delta = event.assistantMessageEvent as
        | { type: string; delta?: string; content?: string; thinking?: string }
        | undefined;

      if (!delta) break;

      switch (delta.type) {
        case 'text_start':
          item.blocks.push({ kind: 'text', text: '' });
          break;

        case 'text_delta': {
          const last = item.blocks[item.blocks.length - 1];
          if (last?.kind === 'text') {
            last.text += delta.delta ?? '';
          } else {
            item.blocks.push({ kind: 'text', text: delta.delta ?? '' });
          }
          break;
        }

        case 'text_end': {
          // Authoritative full text from pi — overwrite the streamed value.
          const last = item.blocks[item.blocks.length - 1];
          if (last?.kind === 'text' && delta.content !== undefined) {
            last.text = delta.content;
          }
          break;
        }

        case 'thinking_start':
          item.blocks.push({ kind: 'thinking', text: '', collapsed: true });
          break;

        case 'thinking_delta': {
          const last = item.blocks[item.blocks.length - 1];
          if (last?.kind === 'thinking') {
            last.text += delta.delta ?? '';
          } else {
            item.blocks.push({ kind: 'thinking', text: delta.delta ?? '', collapsed: true });
          }
          break;
        }

        case 'thinking_end': {
          const last = item.blocks[item.blocks.length - 1];
          if (last?.kind === 'thinking' && delta.thinking !== undefined) {
            last.text = delta.thinking;
          }
          break;
        }

        case 'done':
          item.isComplete = true;
          break;

        case 'error':
          item.isComplete = true;
          break;
      }
      break;
    }

    case 'message_end': {
      if (!state._currentAssistantId) break;
      const item = state.items.find(
        (i): i is AssistantItem =>
          i.itemKind === 'assistant' && i.id === state._currentAssistantId,
      );
      if (item) {
        item.isComplete = true;
        // Use the authoritative message content if we have it.
        const msg = event.message as {
          role?: string;
          content?: unknown;
          timestamp?: number;
        } | undefined;
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          // Rebuild blocks from the final message (authoritative over streamed deltas).
          const blocks: ContentBlock[] = [];
          for (const block of msg.content as Array<{ type: string; text?: string; thinking?: string }>) {
            if (block.type === 'text' && block.text !== undefined) {
              blocks.push({ kind: 'text', text: block.text });
            } else if (block.type === 'thinking' && block.thinking !== undefined) {
              blocks.push({ kind: 'thinking', text: block.thinking, collapsed: true });
            }
          }
          if (blocks.length > 0) item.blocks = blocks;
        }
        state._currentAssistantId = null;
      }
      break;
    }

    case 'tool_execution_start': {
      const run: ToolRunItem = {
        itemKind: 'tool',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        args: (event.args as Record<string, unknown>) ?? {},
        partialOutput: '',
        finalOutput: null,
        details: null,
        diffError: null,
        isError: false,
        isComplete: false,
      };
      state.items.push(run);
      break;
    }

    case 'tool_execution_update': {
      const run = state.items.find(
        (i): i is ToolRunItem =>
          i.itemKind === 'tool' && i.toolCallId === String(event.toolCallId ?? ''),
      );
      if (!run) break;
      // partialResult.content is accumulated (not a delta) — replace, not append.
      const partial = event.partialResult as { content?: unknown } | undefined;
      run.partialOutput = extractTextFromContent(partial?.content);
      break;
    }

    case 'tool_execution_end': {
      const run = state.items.find(
        (i): i is ToolRunItem =>
          i.itemKind === 'tool' && i.toolCallId === String(event.toolCallId ?? ''),
      );
      if (!run) break;
      const result = event.result as { content?: unknown; details?: Record<string, unknown> } | null;
      run.finalOutput = result ? extractTextFromContent(result.content) : null;
      run.details = result?.details ?? null;
      run.isError = Boolean(event.isError);
      run.isComplete = true;
      break;
    }

    case 'compaction_start': {
      state.items.push({
        itemKind: 'system',
        id: nextId(),
        text: 'Compacting conversation…',
        level: 'info',
      });
      break;
    }

    case 'compaction_end': {
      // Replace the "compacting" notice with the result.
      const last = state.items[state.items.length - 1];
      if (last?.itemKind === 'system' && last.text.startsWith('Compacting')) {
        state.items.pop();
      }
      const result = event.result as { summary?: string } | null;
      const aborted = Boolean(event.aborted);
      const text = aborted
        ? 'Compaction aborted.'
        : result?.summary
          ? `Compacted: ${result.summary}`
          : 'Conversation compacted.';
      state.items.push({ itemKind: 'system', id: nextId(), text, level: 'info' });
      break;
    }

    case 'auto_retry_start': {
      state.items.push({
        itemKind: 'system',
        id: nextId(),
        text: `Retrying (attempt ${String(event.attempt ?? '?')} of ${String(event.maxAttempts ?? '?')})…`,
        level: 'warning',
      });
      break;
    }

    case 'auto_retry_end': {
      if (!event.success) {
        state.items.push({
          itemKind: 'system',
          id: nextId(),
          text: `Failed after retries: ${String(event.finalError ?? 'unknown error')}`,
          level: 'error',
        });
      }
      break;
    }
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState & ChatActions>()((set) => ({
  items: [],
  isStreaming: false,
  _currentAssistantId: null,
  commands: [],
  supportsImages: false,
  modelName: null,
  showViewDiffButton: true,
  uiStatuses: [],
  uiWidgets: [],
  uiTitle: null,
  uiEditorText: null,
  toolCardExpanded: {},
  instructionFiles: undefined,

  addUserMessage: (text, imageCount) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          itemKind: 'user',
          id: nextId(),
          text,
          ...(imageCount ? { imageCount } : {}),
          timestamp: Date.now(),
        } satisfies UserItem,
      ],
    })),

  toggleThinking: (itemId, blockIndex) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.itemKind !== 'assistant' || item.id !== itemId) return item;
        const blocks = item.blocks.map((b, i) => {
          if (i !== blockIndex || b.kind !== 'thinking') return b;
          return { ...b, collapsed: !b.collapsed };
        });
        return { ...item, blocks };
      }),
    })),

  setDiffError: (toolCallId: string, message: string) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.itemKind !== 'tool' || item.toolCallId !== toolCallId) return item;
        return { ...item, diffError: message };
      }),
    })),

  setToolCardExpanded: (toolCallId: string, expanded: boolean) =>
    set((state) => ({
      toolCardExpanded: { ...state.toolCardExpanded, [toolCallId]: expanded },
    })),

  setCommands: (commands: PiCommand[]) => set(() => ({ commands })),

  setModelState: (state: ModelState | null) =>
    set(() => ({
      supportsImages: state?.supportsImages ?? false,
      modelName: state?.modelName ?? null,
    })),

  setChatConfig: (showViewDiffButton: boolean) => set(() => ({ showViewDiffButton })),

  setInstructionFiles: (info: InstructionFilesInfo | null) => set(() => ({ instructionFiles: info })),

  setUiStatus: (key, text) =>
    set((state) => {
      if (text === null) {
        return { uiStatuses: state.uiStatuses.filter((s) => s.key !== key) };
      }
      const exists = state.uiStatuses.some((s) => s.key === key);
      return {
        uiStatuses: exists
          ? state.uiStatuses.map((s) => (s.key === key ? { key, text } : s))
          : [...state.uiStatuses, { key, text }],
      };
    }),

  setUiWidget: (key, lines, placement) =>
    set((state) => {
      if (lines === null) {
        return { uiWidgets: state.uiWidgets.filter((w) => w.key !== key) };
      }
      const exists = state.uiWidgets.some((w) => w.key === key);
      return {
        uiWidgets: exists
          ? state.uiWidgets.map((w) =>
              w.key === key ? { key, lines, placement } : w,
            )
          : [...state.uiWidgets, { key, lines, placement }],
      };
    }),

  setUiTitle: (title) => set(() => ({ uiTitle: title })),

  setUiEditorText: (text) => set(() => ({ uiEditorText: text })),

  resetSession: () =>
    set((state) => ({
      // Carry over extension-scoped state (commands, model capabilities, and
      // the showViewDiffButton setting) — only session-scoped transcript + UI
      // protocol state is cleared. Spreading `state` makes this preservation
      // explicit rather than relying on Zustand's partial-merge default.
      ...state,
      items: [],
      isStreaming: false,
      _currentAssistantId: null,
      // Clear all session-scoped UI state so stale widgets/prefills don't leak into new sessions.
      uiStatuses: [],
      uiWidgets: [],
      uiTitle: null,
      uiEditorText: null,
      toolCardExpanded: {},
    })),

  setMessages: (messages: unknown[]) =>
    set(() => {
      const items: ChatItem[] = [];
      const toolsByCallId = new Map<string, ToolRunItem>();
      for (const msg of messages) {
        if (msg && typeof msg === 'object') {
          appendAgentMessage(items, toolsByCallId, msg as Record<string, unknown>);
        }
      }
      return {
        items,
        isStreaming: false,
        _currentAssistantId: null,
        toolCardExpanded: {},
        // Preserve UI protocol state across session switches.
      };
    }),

  dispatchEvents: (events) =>
    set((state) => {
      // Mutate a draft copy so we make one `set` call for the whole batch.
      const draft: ChatState = {
        items: [...state.items],
        isStreaming: state.isStreaming,
        _currentAssistantId: state._currentAssistantId,
        commands: state.commands,
        // Carry UI-protocol state through unchanged — dispatchEvents only
        // handles agent render events, never extension_ui_request.
        uiStatuses: state.uiStatuses,
        uiWidgets: state.uiWidgets,
        uiTitle: state.uiTitle,
        uiEditorText: state.uiEditorText,
        supportsImages: state.supportsImages,
        modelName: state.modelName,
        showViewDiffButton: state.showViewDiffButton,
        instructionFiles: state.instructionFiles,
        toolCardExpanded: state.toolCardExpanded,
      };
      // Deep-clone items array elements that will be mutated so React
      // detects the change correctly.
      const mutatedIds = new Set<string | number>();

      for (const event of events) {
        // Track which items are about to be mutated so we can shallow-clone them.
        _preMutate(draft, event, mutatedIds);
        applyEvent(draft, event);
      }

      return {
        items: draft.items,
        isStreaming: draft.isStreaming,
        _currentAssistantId: draft._currentAssistantId,
      };
    }),
}));

/**
 * Before mutating an item in place, replace it with a shallow clone so
 * React's reference-equality check picks up the change.
 */
function _preMutate(state: ChatState, event: RpcEvent, seen: Set<string | number>): void {
  const needsClone = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const idx = state.items.findIndex(
      (i) => (i.itemKind === 'assistant' || i.itemKind === 'tool') &&
        ((i as AssistantItem).id === id || (i as ToolRunItem).toolCallId === id),
    );
    if (idx !== -1) {
      const item = state.items[idx];
      if (item.itemKind === 'assistant') {
        state.items[idx] = { ...item, blocks: [...item.blocks] };
      } else {
        state.items[idx] = { ...item };
      }
    }
  };

  if (
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    if (state._currentAssistantId) needsClone(state._currentAssistantId);
  } else if (
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  ) {
    needsClone(String(event.toolCallId ?? ''));
  }
}
