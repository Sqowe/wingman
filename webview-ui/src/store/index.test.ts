/**
 * Unit tests for the Zustand chat store reducer (dispatchEvents + actions).
 *
 * This is the heart of Phase 2/3 rendering: it folds pi's raw RPC event
 * stream into typed chat items. Event field names are asserted against pi's
 * documented contract (rpc.md / json.md, pi 0.79.x):
 *   - message_update carries `assistantMessageEvent` (text/thinking deltas)
 *   - tool_execution_* correlate by `toolCallId`; `partialResult`/`result`
 *     content is an accumulated array of { type:'text', text } blocks
 *   - tool `result.details` (incl. `patch`) is preserved for the Phase 4 diff
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, normalizeShowViewDiffButton } from './index';
import type {
  AssistantItem,
  ChatItem,
  QuestionCardItem,
  SystemItem,
  ToolRunItem,
  UserItem,
} from './index';
import type { UiDialogMessage, SessionStats } from '../../../src/shared/messages';

// ─── Helpers ────────────────────────────────────────────────────────────────

type Ev = { type: string; [key: string]: unknown };

/** Dispatch one or more raw events through the reducer in a single batch. */
function dispatch(...events: Ev[]): void {
  // Cast: the store types events as RpcEvent ({ type: string; [k]: unknown }).
  useChatStore.getState().dispatchEvents(events as never);
}

function items(): ChatItem[] {
  return useChatStore.getState().items;
}

function onlyTool(): ToolRunItem {
  const tools = items().filter((i): i is ToolRunItem => i.itemKind === 'tool');
  expect(tools).toHaveLength(1);
  return tools[0];
}

function onlyAssistant(): AssistantItem {
  const a = items().filter((i): i is AssistantItem => i.itemKind === 'assistant');
  expect(a).toHaveLength(1);
  return a[0];
}

const textContent = (text: string) => [{ type: 'text', text }];

// Reset the singleton store before each test.
beforeEach(() => {
  useChatStore.setState({
    items: [],
    isStreaming: false,
    _currentAssistantId: null,
    uiStatuses: [],
    uiWidgets: [],
    uiTitle: null,
    uiEditorText: null,
    toolCardExpanded: {},
    pendingDialogAnswers: [],
  });
});

// ─── Actions ──────────────────────────────────────────────────────────────────

describe('actions', () => {
  it('addUserMessage appends a user item with the given text', () => {
    useChatStore.getState().addUserMessage('hello there');
    const [item] = items();
    expect(item.itemKind).toBe('user');
    expect((item as UserItem).text).toBe('hello there');
  });

  it('toggleThinking flips a thinking block collapsed flag', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
    );
    const a = onlyAssistant();
    expect(a.blocks[0]).toMatchObject({ kind: 'thinking', collapsed: true });

    useChatStore.getState().toggleThinking(a.id, 0);
    const after = onlyAssistant().blocks[0];
    expect(after).toMatchObject({ kind: 'thinking', collapsed: false });
  });

  it('resetSession clears the transcript and streaming state but keeps commands', () => {
    // Seed a streaming session with items and a command list.
    dispatch({ type: 'agent_start' });
    useChatStore.getState().addUserMessage('hello');
    useChatStore.getState().setCommands([{ name: '/foo', description: 'bar' }]);
    expect(items().length).toBeGreaterThan(0);
    expect(useChatStore.getState().isStreaming).toBe(true);

    useChatStore.getState().resetSession();

    const state = useChatStore.getState();
    expect(state.items).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state._currentAssistantId).toBeNull();
    // Commands are project-scoped and managed separately — must survive a reset.
    expect(state.commands).toEqual([{ name: '/foo', description: 'bar' }]);
  });
});

// ─── Agent / streaming lifecycle ────────────────────────────────────────────────

describe('agent lifecycle', () => {
  it('agent_start / agent_end toggle isStreaming', () => {
    dispatch({ type: 'agent_start' });
    expect(useChatStore.getState().isStreaming).toBe(true);
    dispatch({ type: 'agent_end' });
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});

// ─── Assistant message streaming ────────────────────────────────────────────────

describe('assistant message streaming', () => {
  it('assembles streamed text deltas, then text_end is authoritative', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant', timestamp: 111 } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
    );
    expect(onlyAssistant().blocks).toEqual([{ kind: 'text', text: 'Hello' }]);

    // text_end overwrites the streamed value with pi's full content.
    dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'Hello world' } });
    expect(onlyAssistant().blocks).toEqual([{ kind: 'text', text: 'Hello world' }]);
  });

  it('captures thinking deltas and thinking_end content', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'reason' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', thinking: 'reasoned fully' } },
    );
    expect(onlyAssistant().blocks).toEqual([
      { kind: 'thinking', text: 'reasoned fully', collapsed: true },
    ]);
  });

  it('does not start an assistant item for a non-assistant message_start', () => {
    dispatch({ type: 'message_start', message: { role: 'user' } });
    expect(items()).toHaveLength(0);
  });

  it('ignores message_update with no active assistant item', () => {
    dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
    expect(items()).toHaveLength(0);
  });

  it('message_end marks complete and rebuilds blocks from authoritative content', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'because' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    );
    const a = onlyAssistant();
    expect(a.isComplete).toBe(true);
    expect(a.blocks).toEqual([
      { kind: 'thinking', text: 'because', collapsed: true },
      { kind: 'text', text: 'final answer' },
    ]);
  });

  it('message_end resets the current assistant id so the next message starts fresh', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_end', message: { role: 'assistant', content: textContent('one') } },
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } },
    );
    const assistants = items().filter((i): i is AssistantItem => i.itemKind === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[1].blocks).toEqual([{ kind: 'text', text: 'two' }]);
  });
});

// ─── Tool execution ─────────────────────────────────────────────────────────────

describe('tool execution', () => {
  it('tool_execution_start creates an incomplete tool item with args', () => {
    dispatch({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls -la' },
    });
    const t = onlyTool();
    expect(t).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls -la' },
      isComplete: false,
      isError: false,
      finalOutput: null,
      details: null,
    });
  });

  it('tool_execution_update replaces (not appends) partial output', () => {
    dispatch(
      { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: {} },
      { type: 'tool_execution_update', toolCallId: 'c', partialResult: { content: textContent('line 1\n') } },
      { type: 'tool_execution_update', toolCallId: 'c', partialResult: { content: textContent('line 1\nline 2\n') } },
    );
    // Accumulated output from pi is a full snapshot — must replace, not concatenate.
    expect(onlyTool().partialOutput).toBe('line 1\nline 2\n');
  });

  it('tool_execution_end sets finalOutput, preserves details.patch, marks complete', () => {
    const patch = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
    dispatch(
      { type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { filePath: '/x.ts' } },
      {
        type: 'tool_execution_end',
        toolCallId: 'e',
        result: { content: textContent('done'), details: { patch } },
        isError: false,
      },
    );
    const t = onlyTool();
    expect(t.isComplete).toBe(true);
    expect(t.finalOutput).toBe('done');
    expect(t.details).toEqual({ patch });
  });

  it('propagates isError from tool_execution_end', () => {
    dispatch(
      { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: {} },
      { type: 'tool_execution_end', toolCallId: 'x', result: { content: textContent('boom') }, isError: true },
    );
    expect(onlyTool().isError).toBe(true);
  });

  it('correlates events by toolCallId across concurrent tools', () => {
    dispatch(
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: {} },
      { type: 'tool_execution_update', toolCallId: 'b', partialResult: { content: textContent('B-only') } },
    );
    const tools = items().filter((i): i is ToolRunItem => i.itemKind === 'tool');
    expect(tools.find((t) => t.toolCallId === 'a')!.partialOutput).toBe('');
    expect(tools.find((t) => t.toolCallId === 'b')!.partialOutput).toBe('B-only');
  });

  it('ignores update / end for an unknown toolCallId without throwing', () => {
    expect(() =>
      dispatch(
        { type: 'tool_execution_update', toolCallId: 'ghost', partialResult: { content: textContent('x') } },
        { type: 'tool_execution_end', toolCallId: 'ghost', result: { content: textContent('y') }, isError: false },
      ),
    ).not.toThrow();
    expect(items()).toHaveLength(0);
  });

  it('initialises diffError to null on tool_execution_start', () => {
    dispatch({ type: 'tool_execution_start', toolCallId: 'd', toolName: 'edit', args: {} });
    expect(onlyTool().diffError).toBeNull();
  });
});

// ─── Diff error (Phase 4) ───────────────────────────────────────────────────────

describe('setDiffError', () => {
  it('sets a diff error message on the matching tool card', () => {
    dispatch({ type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: {} });
    useChatStore.getState().setDiffError('e', 'could not apply edit');
    expect(onlyTool().diffError).toBe('could not apply edit');
  });

  it("clears the error (empty string) so the inline banner hides on retry", () => {
    dispatch({ type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: {} });
    useChatStore.getState().setDiffError('e', 'boom');
    useChatStore.getState().setDiffError('e', '');
    expect(onlyTool().diffError).toBe('');
  });

  it('only affects the tool card with the matching toolCallId', () => {
    dispatch(
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'edit', args: {} },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'edit', args: {} },
    );
    useChatStore.getState().setDiffError('b', 'only b failed');
    const tools = items().filter((i): i is ToolRunItem => i.itemKind === 'tool');
    expect(tools.find((t) => t.toolCallId === 'a')!.diffError).toBeNull();
    expect(tools.find((t) => t.toolCallId === 'b')!.diffError).toBe('only b failed');
  });

  it('is a no-op for an unknown toolCallId', () => {
    dispatch({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'edit', args: {} });
    expect(() => useChatStore.getState().setDiffError('ghost', 'x')).not.toThrow();
    expect(onlyTool().diffError).toBeNull();
  });
});

describe('setToolCardExpanded', () => {
  const expanded = () => useChatStore.getState().toolCardExpanded;

  it('records a manual expand/collapse override keyed by toolCallId', () => {
    useChatStore.getState().setToolCardExpanded('a', true);
    expect(expanded()).toEqual({ a: true });
    useChatStore.getState().setToolCardExpanded('a', false);
    expect(expanded()).toEqual({ a: false });
  });

  it('keeps overrides for other cards independent', () => {
    useChatStore.getState().setToolCardExpanded('a', true);
    useChatStore.getState().setToolCardExpanded('b', false);
    expect(expanded()).toEqual({ a: true, b: false });
  });

  it('survives a transcript update (the remount-resilience guarantee)', () => {
    useChatStore.getState().setToolCardExpanded('a', true);
    dispatch({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} });
    // Override is not wiped by event dispatch (it lives outside `items`).
    expect(expanded()).toEqual({ a: true });
  });

  it('is cleared when a session is restored via setMessages', () => {
    useChatStore.getState().setToolCardExpanded('a', true);
    useChatStore.getState().setMessages([]);
    expect(expanded()).toEqual({});
  });
});

// ─── System notices ─────────────────────────────────────────────────────────────

describe('system notices', () => {
  it('compaction_start then compaction_end replaces the notice with the summary', () => {
    dispatch({ type: 'compaction_start' });
    expect((items()[0] as SystemItem).text).toBe('Compacting conversation…');

    dispatch({ type: 'compaction_end', result: { summary: 'kept the gist' } });
    const sys = items().filter((i): i is SystemItem => i.itemKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toBe('Compacted: kept the gist');
  });

  it('compaction_end aborted reports an aborted notice', () => {
    dispatch({ type: 'compaction_start' }, { type: 'compaction_end', aborted: true });
    const sys = items().filter((i): i is SystemItem => i.itemKind === 'system');
    expect(sys[sys.length - 1].text).toBe('Compaction aborted.');
  });

  it('auto_retry_start adds a warning; failed auto_retry_end adds an error', () => {
    dispatch({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5 });
    dispatch({ type: 'auto_retry_end', success: false, finalError: 'rate limited' });
    const sys = items().filter((i): i is SystemItem => i.itemKind === 'system');
    expect(sys[0]).toMatchObject({ level: 'warning', text: 'Retrying (attempt 2 of 5)…' });
    expect(sys[1]).toMatchObject({ level: 'error', text: 'Failed after retries: rate limited' });
  });

  it('successful auto_retry_end adds no error item', () => {
    dispatch({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 });
    dispatch({ type: 'auto_retry_end', success: true });
    const sys = items().filter((i): i is SystemItem => i.itemKind === 'system');
    expect(sys).toHaveLength(1); // only the "Retrying…" warning
  });
});

// ─── Immutability (React change detection) ──────────────────────────────────────

describe('immutability for React change detection', () => {
  it('replaces the items array and clones mutated items on each batch', () => {
    dispatch({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: {} });
    const arrBefore = items();
    const toolBefore = onlyTool();

    dispatch({ type: 'tool_execution_update', toolCallId: 'c', partialResult: { content: textContent('out') } });

    expect(items()).not.toBe(arrBefore); // new array reference
    expect(onlyTool()).not.toBe(toolBefore); // cloned item reference
    expect(toolBefore.partialOutput).toBe(''); // original left untouched
    expect(onlyTool().partialOutput).toBe('out');
  });

  it('clones the assistant item and its blocks array when a delta arrives', () => {
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
    );
    const assistantBefore = onlyAssistant();
    const blocksBefore = assistantBefore.blocks;

    dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } });

    expect(onlyAssistant()).not.toBe(assistantBefore);
    expect(onlyAssistant().blocks).not.toBe(blocksBefore);
    expect(onlyAssistant().blocks).toEqual([{ kind: 'text', text: 'ab' }]);
  });
});

// ─── UI protocol state (Phase 6) ────────────────────────────────────────────────
//
// These reducers fold pi's fire-and-forget extension UI methods (setStatus /
// setWidget / setTitle / set_editor_text) into renderable state. Field
// semantics are asserted against pi's rpc.md "Extension UI Protocol":
//   - setStatus/setWidget are keyed; sending null text/lines clears that key
//   - setTitle is a single subtitle; set_editor_text is a one-shot prefill

describe('UI protocol state', () => {
  it('setUiStatus adds a new status entry', () => {
    useChatStore.getState().setUiStatus('ext-a', 'Turn 3 running…');
    expect(useChatStore.getState().uiStatuses).toEqual([
      { key: 'ext-a', text: 'Turn 3 running…' },
    ]);
  });

  it('setUiStatus updates an existing key in place (no duplicate, order preserved)', () => {
    const s = useChatStore.getState();
    s.setUiStatus('a', 'first');
    s.setUiStatus('b', 'second');
    s.setUiStatus('a', 'updated');
    expect(useChatStore.getState().uiStatuses).toEqual([
      { key: 'a', text: 'updated' },
      { key: 'b', text: 'second' },
    ]);
  });

  it('setUiStatus with null removes the entry for that key only', () => {
    const s = useChatStore.getState();
    s.setUiStatus('a', 'x');
    s.setUiStatus('b', 'y');
    s.setUiStatus('a', null);
    expect(useChatStore.getState().uiStatuses).toEqual([{ key: 'b', text: 'y' }]);
  });

  it('setUiStatus null for an unknown key is a harmless no-op', () => {
    useChatStore.getState().setUiStatus('ghost', null);
    expect(useChatStore.getState().uiStatuses).toEqual([]);
  });

  it('setUiWidget adds a widget block with lines and placement', () => {
    useChatStore.getState().setUiWidget('w', ['line 1', 'line 2'], 'belowEditor');
    expect(useChatStore.getState().uiWidgets).toEqual([
      { key: 'w', lines: ['line 1', 'line 2'], placement: 'belowEditor' },
    ]);
  });

  it('setUiWidget updates an existing widget in place (lines + placement)', () => {
    const s = useChatStore.getState();
    s.setUiWidget('w', ['old'], 'aboveEditor');
    s.setUiWidget('w', ['new', 'lines'], 'belowEditor');
    expect(useChatStore.getState().uiWidgets).toEqual([
      { key: 'w', lines: ['new', 'lines'], placement: 'belowEditor' },
    ]);
  });

  it('setUiWidget with null lines removes the widget for that key', () => {
    const s = useChatStore.getState();
    s.setUiWidget('w', ['x'], 'aboveEditor');
    s.setUiWidget('w', null, 'aboveEditor');
    expect(useChatStore.getState().uiWidgets).toEqual([]);
  });

  it('setUiTitle sets the subtitle', () => {
    useChatStore.getState().setUiTitle('pi — my project');
    expect(useChatStore.getState().uiTitle).toBe('pi — my project');
  });

  it('setUiEditorText sets the pending prefill and clears it with null', () => {
    useChatStore.getState().setUiEditorText('prefill me');
    expect(useChatStore.getState().uiEditorText).toBe('prefill me');
    useChatStore.getState().setUiEditorText(null);
    expect(useChatStore.getState().uiEditorText).toBeNull();
  });

  it('setUiEditorText treats empty string as a valid (non-null) value', () => {
    useChatStore.getState().setUiEditorText('');
    expect(useChatStore.getState().uiEditorText).toBe('');
  });

  it('resetSession clears all UI protocol state', () => {
    const s = useChatStore.getState();
    s.setUiStatus('a', 'x');
    s.setUiWidget('w', ['y'], 'aboveEditor');
    s.setUiTitle('title');
    s.setUiEditorText('text');

    useChatStore.getState().resetSession();

    const after = useChatStore.getState();
    expect(after.uiStatuses).toEqual([]);
    expect(after.uiWidgets).toEqual([]);
    expect(after.uiTitle).toBeNull();
    expect(after.uiEditorText).toBeNull();
  });

  it('dispatchEvents preserves UI protocol state (it only folds agent events)', () => {
    // Regression guard: the dispatchEvents draft must carry UI fields through
    // unchanged — otherwise a single agent event would wipe active status /
    // widget / title / prefill state mid-turn.
    const s = useChatStore.getState();
    s.setUiStatus('a', 'x');
    s.setUiWidget('w', ['y'], 'aboveEditor');
    s.setUiTitle('title');
    s.setUiEditorText('text');

    dispatch({ type: 'agent_start' });

    const after = useChatStore.getState();
    expect(after.uiStatuses).toEqual([{ key: 'a', text: 'x' }]);
    expect(after.uiWidgets).toEqual([{ key: 'w', lines: ['y'], placement: 'aboveEditor' }]);
    expect(after.uiTitle).toBe('title');
    expect(after.uiEditorText).toBe('text');
  });
});

describe('setMessages (session restore)', () => {
  function setMessages(messages: unknown[]): void {
    useChatStore.getState().setMessages(messages);
  }

  it('restores user and assistant text/thinking', () => {
    setMessages([
      { role: 'user', content: 'hello', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'hi there' },
        ],
        timestamp: 2,
      },
    ]);
    const list = items();
    expect(list).toHaveLength(2);
    expect((list[0] as UserItem).text).toBe('hello');
    const a = list[1] as AssistantItem;
    expect(a.itemKind).toBe('assistant');
    expect(a.isComplete).toBe(true);
    expect(a.blocks).toEqual([
      { kind: 'thinking', text: 'pondering', collapsed: true },
      { kind: 'text', text: 'hi there' },
    ]);
  });

  it('accepts user content as an array of text blocks', () => {
    setMessages([{ role: 'user', content: textContent('from array'), timestamp: 1 }]);
    expect((items()[0] as UserItem).text).toBe('from array');
  });

  it('reconstructs a tool card from a toolCall block + its toolResult', () => {
    setMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running it' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: textContent('file.txt'),
        isError: false,
        timestamp: 2,
      },
    ]);
    const list = items();
    // assistant bubble + one tool card, in order
    expect(list.map((i) => i.itemKind)).toEqual(['assistant', 'tool']);
    const tool = list[1] as ToolRunItem;
    expect(tool.toolCallId).toBe('call_1');
    expect(tool.toolName).toBe('bash');
    expect(tool.args).toEqual({ command: 'ls' });
    expect(tool.finalOutput).toBe('file.txt');
    expect(tool.isError).toBe(false);
    expect(tool.isComplete).toBe(true);
  });

  it('does not emit an empty assistant bubble for a tool-only message', () => {
    setMessages([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
        timestamp: 1,
      },
      { role: 'toolResult', toolCallId: 'c1', content: textContent('data'), timestamp: 2 },
    ]);
    const list = items();
    expect(list).toHaveLength(1);
    expect(list[0].itemKind).toBe('tool');
  });

  it('preserves toolResult details (e.g. edit patch) and error flag', () => {
    setMessages([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { filePath: '/x.ts' } }],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'e1',
        content: textContent('boom'),
        details: { patch: '--- a\n+++ b\n' },
        isError: true,
        timestamp: 2,
      },
    ]);
    const tool = onlyTool();
    expect(tool.details).toEqual({ patch: '--- a\n+++ b\n' });
    expect(tool.isError).toBe(true);
  });

  it('renders a bashExecution message as a completed bash card', () => {
    setMessages([
      { role: 'bashExecution', command: 'npm test', output: 'ok', exitCode: 0, timestamp: 1 },
      { role: 'bashExecution', command: 'false', output: 'nope', exitCode: 1, timestamp: 2 },
    ]);
    const tools = items().filter((i): i is ToolRunItem => i.itemKind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolName: 'bash', finalOutput: 'ok', isError: false });
    expect(tools[0].args).toEqual({ command: 'npm test' });
    expect(tools[1]).toMatchObject({ finalOutput: 'nope', isError: true });
  });

  it('renders an orphan toolResult (no matching call) as a standalone card', () => {
    setMessages([
      { role: 'toolResult', toolCallId: 'ghost', toolName: 'read', content: textContent('x'), timestamp: 1 },
    ]);
    const tool = onlyTool();
    expect(tool.toolCallId).toBe('ghost');
    expect(tool.finalOutput).toBe('x');
    expect(tool.isComplete).toBe(true);
  });

  it('replaces any prior transcript and clears streaming state', () => {
    dispatch({ type: 'agent_start' });
    expect(useChatStore.getState().isStreaming).toBe(true);
    setMessages([{ role: 'user', content: 'fresh', timestamp: 1 }]);
    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state._currentAssistantId).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it('ignores malformed entries without throwing', () => {
    setMessages([null, 42, 'nope', { role: 'mystery' }, { role: 'user', content: 'ok', timestamp: 1 }]);
    const list = items();
    expect(list).toHaveLength(1);
    expect((list[0] as UserItem).text).toBe('ok');
  });
});

// ─── setModelState ────────────────────────────────────────────────────────────

describe('store.setModelState', () => {
  beforeEach(() => {
    useChatStore.getState().resetSession();
    useChatStore.setState({ supportsImages: false, modelName: null });
  });

  it('sets supportsImages and modelName from a full state', () => {
    useChatStore.getState().setModelState({
      modelId: 'm1', modelName: 'Vision', provider: 'anthropic',
      thinkingLevel: null, supportsImages: true,
    });
    const s = useChatStore.getState();
    expect(s.supportsImages).toBe(true);
    expect(s.modelName).toBe('Vision');
  });

  it('defaults to false/null when state is null (pi down)', () => {
    // First set to truthy values.
    useChatStore.getState().setModelState({
      modelId: 'm1', modelName: 'Vision', provider: 'anthropic',
      thinkingLevel: null, supportsImages: true,
    });
    useChatStore.getState().setModelState(null);
    const s = useChatStore.getState();
    expect(s.supportsImages).toBe(false);
    expect(s.modelName).toBeNull();
  });

  it('supportsImages false for text-only model', () => {
    useChatStore.getState().setModelState({
      modelId: 'm2', modelName: 'GPT-4', provider: 'openai',
      thinkingLevel: null, supportsImages: false,
    });
    expect(useChatStore.getState().supportsImages).toBe(false);
  });

  it('preserves supportsImages across dispatchEvents (model state not clobbered)', () => {
    useChatStore.getState().setModelState({
      modelId: 'm1', modelName: 'Vision', provider: 'anthropic',
      thinkingLevel: null, supportsImages: true,
    });
    useChatStore.getState().dispatchEvents([{ type: 'agent_start' }]);
    expect(useChatStore.getState().supportsImages).toBe(true);
    expect(useChatStore.getState().modelName).toBe('Vision');
  });
});

// ─── setChatConfig ───────────────────────────────────────────────────────────

describe('store.setChatConfig', () => {
  beforeEach(() => {
    useChatStore.getState().resetSession();
    useChatStore.setState({ showViewDiffButton: true });
  });

  it('defaults to true', () => {
    expect(useChatStore.getState().showViewDiffButton).toBe(true);
  });

  it('sets both boolean values', () => {
    useChatStore.getState().setChatConfig(false);
    expect(useChatStore.getState().showViewDiffButton).toBe(false);
    useChatStore.getState().setChatConfig(true);
    expect(useChatStore.getState().showViewDiffButton).toBe(true);
  });

  it('is preserved across dispatchEvents (config not clobbered by agent events)', () => {
    useChatStore.getState().setChatConfig(false);
    useChatStore.getState().dispatchEvents([{ type: 'agent_start' }]);
    expect(useChatStore.getState().showViewDiffButton).toBe(false);
  });

  it('is preserved across resetSession (config is not session-scoped)', () => {
    useChatStore.getState().setChatConfig(false);
    useChatStore.getState().resetSession();
    expect(useChatStore.getState().showViewDiffButton).toBe(false);
  });
});

// ─── setClaudeMemory ──────────────────────────────────────────

describe('store.setClaudeMemory', () => {
  beforeEach(() => {
    useChatStore.setState({ claudeMemory: undefined });
  });

  it('starts undefined (not yet received)', () => {
    expect(useChatStore.getState().claudeMemory).toBeUndefined();
  });

  it('sets memory info', () => {
    const info = { dir: '/mem', count: 2, files: [
      { path: '/mem/a.md', title: 'Alpha' },
      { path: '/mem/b.md', title: 'Beta' },
    ] };
    useChatStore.getState().setClaudeMemory(info);
    expect(useChatStore.getState().claudeMemory).toEqual(info);
  });

  it('clears to null (no memory folder / unreadable)', () => {
    useChatStore.getState().setClaudeMemory({ dir: '/mem', count: 0, files: [] });
    useChatStore.getState().setClaudeMemory(null);
    expect(useChatStore.getState().claudeMemory).toBeNull();
  });

  it('is preserved across resetSession (re-reported on restart, not cleared)', () => {
    const info = { dir: '/mem', count: 1, files: [{ path: '/mem/a.md', title: 'A' }] };
    useChatStore.getState().setClaudeMemory(info);
    useChatStore.getState().resetSession();
    expect(useChatStore.getState().claudeMemory).toEqual(info);
  });
});

// ─── setCodexMemory ───────────────────────────────────────────

describe('store.setCodexMemory', () => {
  beforeEach(() => {
    useChatStore.setState({ codexMemory: undefined, claudeMemory: undefined });
  });

  it('starts undefined (not yet received)', () => {
    expect(useChatStore.getState().codexMemory).toBeUndefined();
  });

  it('sets memory info independently of claudeMemory', () => {
    const info = { dir: '/codex/memories_v2', count: 2, files: [
      { path: '/codex/memories_v2/memory_summary.md', title: 'memory_summary.md' },
      { path: '/codex/memories_v2/MEMORY.md', title: 'MEMORY.md' },
    ] };
    useChatStore.getState().setCodexMemory(info);
    expect(useChatStore.getState().codexMemory).toEqual(info);
    // Claude slot untouched.
    expect(useChatStore.getState().claudeMemory).toBeUndefined();
  });

  it('clears to null (no memory store / unreadable)', () => {
    useChatStore.getState().setCodexMemory({ dir: '/codex/memories_v2', count: 0, files: [] });
    useChatStore.getState().setCodexMemory(null);
    expect(useChatStore.getState().codexMemory).toBeNull();
  });

  it('is preserved across resetSession (re-reported on restart, not cleared)', () => {
    const info = { dir: '/codex/memories_v2', count: 1, files: [
      { path: '/codex/memories_v2/MEMORY.md', title: 'MEMORY.md' },
    ] };
    useChatStore.getState().setCodexMemory(info);
    useChatStore.getState().resetSession();
    expect(useChatStore.getState().codexMemory).toEqual(info);
  });
});

// ─── normalizeShowViewDiffButton ──────────────────────────────────────────────

describe('store.normalizeShowViewDiffButton', () => {
  it('passes through explicit booleans', () => {
    expect(normalizeShowViewDiffButton(true)).toBe(true);
    expect(normalizeShowViewDiffButton(false)).toBe(false);
  });

  it.each([
    undefined,
    null,
    '',
    'false',
    0,
    42,
    { show: false },
  ])('coerces non-false / malformed values to true (%j)', (raw) => {
    expect(normalizeShowViewDiffButton(raw)).toBe(true);
  });
});

// ─── Question cards ───────────────────────────────────────────────────────────
//
// pi is BLOCKED on an open card, so the invariant these tests defend is that
// exactly one answer can ever be queued per card. Everything else (checkbox
// state, collapse) is presentation. See docs/design/in-chat-question-cards.md.

describe('question cards', () => {
  const SELECT_DIALOG: UiDialogMessage = {
    type: 'uiDialog',
    id: 'req-1',
    kind: 'select',
    question: 'How should I handle it?',
    header: 'REST API file',
    options: [
      { raw: '1. Keep — Leave it.', index: 1, headline: 'Keep', description: 'Leave it.' },
      { raw: '2. Rewrite — Replace it.', index: 2, headline: 'Rewrite', description: 'Replace it.' },
      { raw: '3. Type something.', index: 3, headline: 'Type something.' },
    ],
  };

  const MULTI_DIALOG: UiDialogMessage = {
    type: 'uiDialog',
    id: 'req-2',
    kind: 'multiSelect',
    question: 'Which files should I touch?',
    options: [
      { raw: '1. Router — Rewrite.', index: 1, headline: 'Router', description: 'Rewrite.' },
      { raw: '2. Models — Convert.', index: 2, headline: 'Models', description: 'Convert.' },
      { raw: '3. Tests — Update.', index: 3, headline: 'Tests', description: 'Update.' },
    ],
    instructions: 'Enter the numbers of all that apply.',
  };

  // The follow-up behind a sender's "Type something." row: the answer is the
  // user's own text, and the option list is reference material.
  const TEXT_DIALOG: UiDialogMessage = {
    type: 'uiDialog',
    id: 'req-3',
    kind: 'text',
    question: 'How should I handle it?',
    options: [
      { raw: '1. Keep — Leave it.', index: 1, headline: 'Keep', description: 'Leave it.' },
      { raw: '2. Rewrite — Replace it.', index: 2, headline: 'Rewrite', description: 'Replace it.' },
    ],
    instructions: 'Type your answer:',
  };

  const cards = () => items().filter((i): i is QuestionCardItem => i.itemKind === 'question');
  const onlyCard = () => {
    const found = cards();
    expect(found).toHaveLength(1);
    return found[0];
  };
  const answers = () => useChatStore.getState().pendingDialogAnswers;

  // ── Adding ────────────────────────────────────────────────────────────────

  it('addQuestionCard appends an open card to the transcript', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    const card = onlyCard();
    expect(card).toMatchObject({
      itemKind: 'question',
      id: 'req-1',
      kind: 'select',
      question: 'How should I handle it?',
      header: 'REST API file',
      status: 'open',
      selected: [],
      expanded: false,
    });
    expect(card.options).toHaveLength(3);
  });

  it('addQuestionCard keeps the card in transcript order', () => {
    useChatStore.getState().addUserMessage('do the thing');
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    expect(items().map((i) => i.itemKind)).toEqual(['user', 'question']);
  });

  it('addQuestionCard ignores a re-post of the same id', () => {
    // The host re-posts open cards when the webview reloads.
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-1', 2);
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);

    expect(cards()).toHaveLength(1);
    // Ticked state survives the re-post rather than being reset.
    expect(onlyCard().selected).toEqual([2]);
  });

  it('addQuestionCard carries instructions through for multiSelect', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    expect(onlyCard().instructions).toBe('Enter the numbers of all that apply.');
  });

  // ── Single choice ─────────────────────────────────────────────────────────

  it('answerQuestionCard queues the raw option string verbatim', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '2. Rewrite — Replace it.');

    // Verbatim: the sender parses its own encoding back out of this string.
    expect(answers()).toEqual([{ id: 'req-1', value: '2. Rewrite — Replace it.' }]);
    expect(onlyCard()).toMatchObject({ status: 'answered', answer: '2. Rewrite — Replace it.' });
  });

  it('answerQuestionCard is a no-op on an already-answered card', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    useChatStore.getState().answerQuestionCard('req-1', '2. Rewrite — Replace it.');

    // pi accepts exactly one response; a double click must not queue a second.
    expect(answers()).toHaveLength(1);
    expect(onlyCard().answer).toBe('1. Keep — Leave it.');
  });

  it('answerQuestionCard ignores an unknown id', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('nope', 'x');
    expect(answers()).toHaveLength(0);
    expect(onlyCard().status).toBe('open');
  });

  // ── Multiple choice ───────────────────────────────────────────────────────

  it('toggleQuestionOption accumulates ticks in ascending order', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-2', 3);
    useChatStore.getState().toggleQuestionOption('req-2', 1);
    expect(onlyCard().selected).toEqual([1, 3]);
  });

  it('toggleQuestionOption unticks a selected option', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-2', 2);
    useChatStore.getState().toggleQuestionOption('req-2', 2);
    expect(onlyCard().selected).toEqual([]);
  });

  it('toggleQuestionOption ignores an index the sender never offered', () => {
    // An out-of-range token makes rpiv keep the WHOLE reply as free text rather
    // than a selection, so a bad index must never reach `selected`.
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-2', 999);
    useChatStore.getState().toggleQuestionOption('req-2', 0);
    expect(onlyCard().selected).toEqual([]);
  });

  it('toggleQuestionOption ignores an unknown card id', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('nope', 1);
    expect(onlyCard().selected).toEqual([]);
  });

  it('submitQuestionSelection sends bare comma-separated indices', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-2', 1);
    useChatStore.getState().toggleQuestionOption('req-2', 3);
    useChatStore.getState().submitQuestionSelection('req-2');

    // Indices, never labels: the sender keeps the whole reply as free text if any
    // token is not an in-range index.
    expect(answers()).toEqual([{ id: 'req-2', value: '1,3' }]);
    expect(onlyCard()).toMatchObject({ status: 'answered', answer: '1,3' });
  });

  it('submitQuestionSelection sends an empty string for no selection', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().submitQuestionSelection('req-2');
    // The sender reads this as a deliberate "none of these".
    expect(answers()).toEqual([{ id: 'req-2', value: '' }]);
  });

  it('toggleQuestionOption is a no-op once the card is answered', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().toggleQuestionOption('req-2', 1);
    useChatStore.getState().submitQuestionSelection('req-2');
    useChatStore.getState().toggleQuestionOption('req-2', 2);

    expect(onlyCard().selected).toEqual([1]);
    expect(answers()).toHaveLength(1);
  });

  // ── A written answer ───────────────────────────────────────────────────────

  it('setQuestionDraft keeps the half-typed text on the card', () => {
    useChatStore.getState().addQuestionCard(TEXT_DIALOG);
    useChatStore.getState().setQuestionDraft('req-3', 'half typed');

    // The draft lives in the store: the transcript is virtualised, so a card
    // that scrolls out of view is unmounted and a local value would be lost.
    expect(onlyCard().draft).toBe('half typed');
    expect(answers()).toHaveLength(0);
  });

  it('setQuestionDraft ignores a card that is not a text card', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().setQuestionDraft('req-2', 'half typed');

    // A multiple choice without allowsCustomText has no field to type into.
    expect(onlyCard().draft).toBeUndefined();
  });

  // ── Multiple choice with own text ──

  it('submitQuestionSelection appends own text after the separator', () => {
    useChatStore.getState().addQuestionCard({ ...MULTI_DIALOG, allowsCustomText: true });
    useChatStore.getState().toggleQuestionOption('req-2', 1);
    useChatStore.getState().toggleQuestionOption('req-2', 3);
    useChatStore.getState().setQuestionDraft('req-2', 'and the README');
    useChatStore.getState().submitQuestionSelection('req-2');

    expect(answers()).toEqual([{ id: 'req-2', value: '1,3; and the README' }]);
  });

  it('submitQuestionSelection sends own text alone with an empty index part', () => {
    useChatStore.getState().addQuestionCard({ ...MULTI_DIALOG, allowsCustomText: true });
    useChatStore.getState().setQuestionDraft('req-2', 'none of these');
    useChatStore.getState().submitQuestionSelection('req-2');
    expect(answers()).toEqual([{ id: 'req-2', value: '; none of these' }]);
  });

  it('submitQuestionSelection drops a blank own text', () => {
    useChatStore.getState().addQuestionCard({ ...MULTI_DIALOG, allowsCustomText: true });
    useChatStore.getState().toggleQuestionOption('req-2', 2);
    useChatStore.getState().setQuestionDraft('req-2', '   ');
    useChatStore.getState().submitQuestionSelection('req-2');
    expect(answers()).toEqual([{ id: 'req-2', value: '2' }]);
  });

  it('addQuestionCard carries allowsCustomText through', () => {
    useChatStore.getState().addQuestionCard({ ...MULTI_DIALOG, allowsCustomText: true });
    expect(onlyCard().allowsCustomText).toBe(true);
  });

  it('setQuestionReferenceExpanded opens and closes the reference list', () => {
    useChatStore.getState().addQuestionCard(TEXT_DIALOG);
    expect(onlyCard().referenceExpanded).toBeUndefined();

    useChatStore.getState().setQuestionReferenceExpanded('req-3', true);
    expect(onlyCard().referenceExpanded).toBe(true);

    useChatStore.getState().setQuestionReferenceExpanded('req-3', false);
    expect(onlyCard().referenceExpanded).toBe(false);
  });

  it('setQuestionReferenceExpanded ignores a card that is not a text card', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().setQuestionReferenceExpanded('req-2', true);

    expect(onlyCard().referenceExpanded).toBeUndefined();
  });

  it('submitQuestionText sends the typed text verbatim', () => {
    useChatStore.getState().addQuestionCard(TEXT_DIALOG);
    useChatStore.getState().submitQuestionText('req-3', 'my own answer');

    // The text is the answer itself: not reformatted, not relabelled.
    expect(answers()).toEqual([{ id: 'req-3', value: 'my own answer' }]);
    expect(onlyCard()).toMatchObject({ status: 'answered', answer: 'my own answer' });
  });

  it('submitQuestionText refuses a blank answer', () => {
    // A blank reply is not an answer: the sender behind a "Type something." row
    // reads it as "go back to the options" and re-asks the question.
    useChatStore.getState().addQuestionCard(TEXT_DIALOG);
    useChatStore.getState().submitQuestionText('req-3', '   ');

    expect(answers()).toHaveLength(0);
    expect(onlyCard().status).toBe('open');
  });

  it('submitQuestionText ignores a card that is not a text card', () => {
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().submitQuestionText('req-2', 'my own answer');

    expect(answers()).toHaveLength(0);
    expect(onlyCard().status).toBe('open');
  });

  it('submitQuestionText is a no-op once the card is answered', () => {
    useChatStore.getState().addQuestionCard(TEXT_DIALOG);
    useChatStore.getState().submitQuestionText('req-3', 'first');
    useChatStore.getState().submitQuestionText('req-3', 'second');

    // pi accepts exactly one response per request.
    expect(answers()).toEqual([{ id: 'req-3', value: 'first' }]);
  });

  // ── Dismissal and withdrawal ──────────────────────────────────────────────

  it('dismissQuestionCard queues a cancellation', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().dismissQuestionCard('req-1');

    expect(answers()).toEqual([{ id: 'req-1', cancelled: true }]);
    expect(onlyCard().status).toBe('dismissed');
  });

  it('dismissQuestionCard is a no-op on a settled card', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    useChatStore.getState().dismissQuestionCard('req-1');

    expect(answers()).toHaveLength(1);
    expect(onlyCard().status).toBe('answered');
  });

  it('withdrawQuestionCard records the reason and sends nothing', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().withdrawQuestionCard('req-1', 'timeout');

    // The host already settled the request; replying would double-respond.
    expect(answers()).toHaveLength(0);
    expect(onlyCard()).toMatchObject({ status: 'withdrawn', withdrawnReason: 'timeout' });
  });

  it('withdrawQuestionCard leaves an answered card as answered', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    useChatStore.getState().withdrawQuestionCard('req-1', 'sessionReset');

    // A late withdrawal must not rewrite the record of what the user chose.
    expect(onlyCard()).toMatchObject({ status: 'answered', answer: '1. Keep — Leave it.' });
    expect(onlyCard().withdrawnReason).toBeUndefined();
  });

  // ── Presentation ──────────────────────────────────────────────────────────

  it('setQuestionCardExpanded toggles the answered card record', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    expect(onlyCard().expanded).toBe(false);

    useChatStore.getState().setQuestionCardExpanded('req-1', true);
    expect(onlyCard().expanded).toBe(true);
  });

  it('setQuestionCardExpanded ignores an unknown card id', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    expect(() => useChatStore.getState().setQuestionCardExpanded('nope', true)).not.toThrow();
    expect(onlyCard().expanded).toBe(false);
  });

  it('answerQuestionCard accepts an empty value on a select card', () => {
    // Not a shape the current senders produce, but the store must record and
    // queue whatever it is given rather than treating '' as "no answer" and
    // leaving pi blocked.
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '');
    expect(answers()).toEqual([{ id: 'req-1', value: '' }]);
    expect(onlyCard().status).toBe('answered');
  });

  it('does not alias the options array from the host message', () => {
    const dialog: UiDialogMessage = {
      ...SELECT_DIALOG,
      options: [...SELECT_DIALOG.options],
    };
    useChatStore.getState().addQuestionCard(dialog);
    const before = onlyCard().options.length;
    // Mutating the caller's array must not reach into store state.
    dialog.options.push({ raw: '9. Injected', index: 9, headline: 'Injected' });
    expect(onlyCard().options).toHaveLength(before);
  });

  // ── Outbox ────────────────────────────────────────────────────────────────

  it('flushDialogAnswers empties the queue', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');
    expect(answers()).toHaveLength(1);

    useChatStore.getState().flushDialogAnswers();
    expect(answers()).toHaveLength(0);
    // Flushing is about delivery only — the transcript record stays.
    expect(onlyCard().status).toBe('answered');
  });

  it('queues answers for two cards independently', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().addQuestionCard(MULTI_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '3. Type something.');
    useChatStore.getState().toggleQuestionOption('req-2', 2);
    useChatStore.getState().submitQuestionSelection('req-2');

    expect(answers()).toEqual([
      { id: 'req-1', value: '3. Type something.' },
      { id: 'req-2', value: '2' },
    ]);
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────

  it('resetSession clears cards and the outbox', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().answerQuestionCard('req-1', '1. Keep — Leave it.');

    useChatStore.getState().resetSession();

    expect(cards()).toHaveLength(0);
    // A queued answer refers to a request the host already settled on reset.
    expect(answers()).toHaveLength(0);
  });

  it('setMessages clears cards from the previous session', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    useChatStore.getState().setMessages([
      { role: 'user', content: 'hello', timestamp: 1 },
    ]);
    expect(cards()).toHaveLength(0);
    expect(answers()).toHaveLength(0);
  });

  it('dispatchEvents leaves an open card untouched', () => {
    useChatStore.getState().addQuestionCard(SELECT_DIALOG);
    dispatch(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
    );
    // A card never arrives through the event stream, and streaming must not
    // disturb one that is open.
    expect(onlyCard().status).toBe('open');
    expect(answers()).toHaveLength(0);
  });
});

// ─── setSessionStatsSettled (chat footer card) ──────────────────────────────
describe('store.setSessionStatsSettled', () => {
  beforeEach(() => {
    useChatStore.getState().resetSession();
  });

  it('appends one summary item after the rest of the transcript', () => {
    const stats: SessionStats = {
      tokens: { input: 100_000, output: 25_000, cacheRead: 80_000, cacheWrite: 5_000 },
      totalCost: 0.45,
      startedAt: Date.now() - 690_000,
      totalTokens: 0,
      totalMessages: 0,
    };
    useChatStore.getState().setSessionStatsSettled(stats);

    const items = useChatStore.getState().items;
    const summaries = items.filter((i) => i.itemKind === 'summary');
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    if (s?.itemKind !== 'summary') throw new Error('expected summary');
    expect(s.id).toBe('summary-final');
    expect(s.stats.totalCost).toBe(0.45);
  });

  it('replaces the prior summary in place (one footer per transcript)', () => {
    const first: SessionStats = {
      tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null },
      totalCost: 0.10,
      startedAt: undefined,
      totalTokens: 0,
      totalMessages: 0,
    };
    const second: SessionStats = {
      ...first,
      totalCost: 0.99,
      tokens: { input: 200, output: null, cacheRead: null, cacheWrite: null },
    };
    useChatStore.getState().setSessionStatsSettled(first);
    useChatStore.getState().setSessionStatsSettled(second);

    const summaries = useChatStore.getState().items.filter((i) => i.itemKind === 'summary');
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    if (s?.itemKind !== 'summary') throw new Error('expected summary');
    expect(s.stats.totalCost).toBe(0.99);
    // And it's the LAST item in the transcript.
    const last = useChatStore.getState().items.at(-1);
    expect(last?.itemKind).toBe('summary');
  });

  it('a snapshot with no renderable line appends nothing (and drops a stale prior summary)', () => {
    // No elapsed (no startedAt/elapsedMs), no buckets, sub-threshold cost:
    // formatChatFooterLine returns null. The store must not append an item
    // that renders null yet still occupies a row in the message list.
    const empty: SessionStats = {
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      totalCost: 0,
      startedAt: undefined,
      totalTokens: 0,
      totalMessages: 0,
    };
    useChatStore.getState().setSessionStatsSettled(empty);
    expect(useChatStore.getState().items.some((i) => i.itemKind === 'summary')).toBe(false);

    // A renderable summary followed by an empty snapshot: the empty one
    // must remove the stale footer rather than leave it contradicting the
    // freshest (empty) reading.
    useChatStore.getState().setSessionStatsSettled({
      tokens: { input: 10, output: null, cacheRead: null, cacheWrite: null },
      totalCost: 0.05,
      startedAt: undefined,
      totalTokens: 0,
      totalMessages: 0,
    });
    expect(useChatStore.getState().items.some((i) => i.itemKind === 'summary')).toBe(true);
    useChatStore.getState().setSessionStatsSettled(empty);
    expect(useChatStore.getState().items.some((i) => i.itemKind === 'summary')).toBe(false);
  });

  it('resetSession clears the summary along with the transcript', () => {
    useChatStore.getState().setSessionStatsSettled({
      tokens: { input: 1, output: null, cacheRead: null, cacheWrite: null },
      totalCost: 0,
      startedAt: undefined,
      totalTokens: 0,
      totalMessages: 0,
    });
    expect(useChatStore.getState().items.some((i) => i.itemKind === 'summary')).toBe(true);
    useChatStore.getState().resetSession();
    expect(useChatStore.getState().items.some((i) => i.itemKind === 'summary')).toBe(false);
  });

  it('addUserMessage drops the prior summary so it does not float mid-transcript at turn 2', () => {
    // Round 1: user → settled → summary at the tail.
    useChatStore.getState().addUserMessage('first prompt', 0);
    useChatStore.getState().setSessionStatsSettled({
      tokens: { input: 10, output: null, cacheRead: null, cacheWrite: null },
      totalCost: 0.01,
      startedAt: undefined,
      totalTokens: 0,
      totalMessages: 0,
    });
    expect(useChatStore.getState().items.filter((i) => i.itemKind === 'summary')).toHaveLength(1);

    // Round 2: user sends another prompt — the prior summary MUST be gone
    // before the new user message lands, so the user message is the last
    // item and the next agent_settled will land cleanly below it.
    useChatStore.getState().addUserMessage('second prompt', 0);

    const items = useChatStore.getState().items;
    expect(items.some((i) => i.itemKind === 'summary')).toBe(false);
    const last = items.at(-1);
    expect(last?.itemKind).toBe('user');
  });
});
