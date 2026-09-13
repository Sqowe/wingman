// Renders App itself: the ordering lives in its host-message listener, not in the store.
import { render, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HostMessage, UiDialogMessage } from '@shared/messages';
import App from './App';
import { useChatStore } from './store';

vi.mock('./vscodeApi', () => ({
  vscode: { postMessage: vi.fn() },
}));

const DIALOG: UiDialogMessage = {
  type: 'uiDialog',
  id: 'req-1',
  kind: 'select',
  question: 'Which scope?',
  options: [
    { raw: '1. All — Everything.', index: 1, headline: 'All', description: 'Everything.' },
    { raw: '2. Some — Part of it.', index: 2, headline: 'Some', description: 'Part of it.' },
  ],
};

// Frames never run on their own, as in a hidden view; runFrames() delivers them.
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useChatStore.setState({
    items: [],
    isStreaming: false,
    _currentAssistantId: null,
    pendingDialogAnswers: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function postFromHost(message: HostMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

function toolStart(toolCallId: string, toolName: string): HostMessage {
  return {
    type: 'agentEvent',
    event: { type: 'tool_execution_start', toolCallId, toolName, args: {} },
  };
}

function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const cb of pending) cb(performance.now());
  });
}

function transcript(): string[] {
  return useChatStore.getState().items.map((item) =>
    item.itemKind === 'tool'
      ? `tool:${item.toolCallId}`
      : item.itemKind === 'question'
        ? `question:${item.id}`
        : item.itemKind,
  );
}

describe('App — question card placement', () => {
  it('places the card below agent events still waiting for a frame', () => {
    render(<App />);

    postFromHost(toolStart('call-1', 'read'));
    postFromHost(toolStart('call-2', 'ask_user_question'));
    postFromHost(DIALOG);

    expect(transcript()).toEqual(['tool:call-1', 'tool:call-2', 'question:req-1']);
  });

  it('still delivers later events on the next frame', () => {
    render(<App />);

    postFromHost(toolStart('call-1', 'ask_user_question'));
    postFromHost(DIALOG);
    postFromHost(toolStart('call-2', 'read'));
    runFrames();

    expect(transcript()).toEqual(['tool:call-1', 'question:req-1', 'tool:call-2']);
  });
});
