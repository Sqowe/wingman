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
  SystemItem,
  ToolRunItem,
  UserItem,
} from './index';

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
