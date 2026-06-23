/**
 * Zustand store — accumulates pi RPC events into typed chat state.
 *
 * All mutation goes through `dispatchEvents(events[])` which is called
 * from the animation-frame coalescer in App.tsx, never on every raw delta.
 */

import { create } from 'zustand';
import type { RpcEvent } from '../../../src/agent/transport';
import type { PiCommand } from '../../../src/shared/messages';

// ─── Domain types ─────────────────────────────────────────────────────────────

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; collapsed: boolean };

export interface UserItem {
  itemKind: 'user';
  id: string;
  text: string;
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

// ─── Store shape ──────────────────────────────────────────────────────────────

interface ChatState {
  items: ChatItem[];
  isStreaming: boolean;
  /** id of the AssistantItem currently being streamed (null when idle). */
  _currentAssistantId: string | null;
  /** Slash commands available in this session (from get_commands). */
  commands: PiCommand[];
}

interface ChatActions {
  /** Append a user message immediately when the user presses Send. */
  addUserMessage: (text: string) => void;
  /** Collapse / expand a thinking block. */
  toggleThinking: (itemId: string, blockIndex: number) => void;
  /** Set a diff error on a tool card (from host diffError message). */
  setDiffError: (toolCallId: string, message: string) => void;
  /** Replace the current slash commands list. */
  setCommands: (commands: PiCommand[]) => void;
  /**
   * Clear the rendered transcript and per-turn state when the session is
   * replaced by a fresh, empty one. The slash command list is left intact
   * (it is project-scoped and managed separately via setCommands).
   */
  resetSession: () => void;
  /**
   * Process a batch of raw pi RPC events in one store update.
   * Called from the rAF coalescer — never call per-delta.
   */
  dispatchEvents: (events: RpcEvent[]) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  addUserMessage: (text) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          itemKind: 'user',
          id: nextId(),
          text,
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

  setCommands: (commands: PiCommand[]) => set(() => ({ commands })),

  resetSession: () =>
    set(() => ({ items: [], isStreaming: false, _currentAssistantId: null })),

  dispatchEvents: (events) =>
    set((state) => {
      // Mutate a draft copy so we make one `set` call for the whole batch.
      const draft: ChatState = {
        items: [...state.items],
        isStreaming: state.isStreaming,
        _currentAssistantId: state._currentAssistantId,
        commands: state.commands,
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
