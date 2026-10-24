// Renders App itself: the ordering lives in its host-message listener, not in the store.
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HostMessage, UiDialogMessage } from '@shared/messages';
import App from './App';
import { useChatStore } from './store';

const postMessage = vi.fn();
vi.mock('./vscodeApi', () => ({
  vscode: { postMessage: (m: unknown) => postMessage(m) },
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

// jsdom has no object-URL support — stub it, and restore whatever was there.
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  postMessage.mockClear();
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
  (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:mock';
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => undefined;
  useChatStore.setState({
    items: [],
    isStreaming: false,
    _currentAssistantId: null,
    pendingDialogAnswers: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  (URL as unknown as Record<string, unknown>).createObjectURL = realCreateObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = realRevokeObjectURL;
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

describe('App — the new-session shortcut', () => {
  it('asks the host for a new session and keeps the chord away from VS Code', () => {
    render(<App />);

    // VS Code listens on the frame's window, one step past `document`.
    const vscodeListener = vi.fn();
    window.addEventListener('keydown', vscodeListener);

    try {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'n',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(postMessage).toHaveBeenCalledWith({ type: 'newSession' });
      // If the chord reached VS Code, its own keybinding would run the command
      // a second time and two sessions would be created for one keystroke.
      expect(vscodeListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', vscodeListener);
    }
  });

  it('does not ask for a new session again while the key is held down', () => {
    render(<App />);

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        code: 'KeyN',
        metaKey: true,
        altKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(postMessage).not.toHaveBeenCalledWith({ type: 'newSession' });
  });
});

describe('App — image attachments dropped by the host', () => {
  /** Attach a PNG through the composer's file input and send the prompt. */
  async function sendPromptWithImage(): Promise<void> {
    const bin = atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    );
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], 'shot.png', { type: 'image/png' });
    const fileList = { length: 1, 0: file, item: () => file } as unknown as FileList;

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: fileList } });
    await waitFor(() => {
      expect(document.querySelector('.composer__chip')).toBeTruthy();
    });

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'what is this?';
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  }

  it('warns the user when the host forwarded fewer images than were sent', async () => {
    render(<App />);
    await sendPromptWithImage();

    const sent = postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'sendPrompt');
    expect(sent).toBeTruthy();
    expect((sent![0] as { images?: unknown[] }).images).toHaveLength(1);

    // The host dropped the image (the active model is text-only).
    postFromHost({ type: 'promptAccepted', imagesSent: 0, imagesDropped: 1, dropReason: 'modality' });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('1 image not sent');
    });
    expect(screen.getByRole('alert').textContent).toContain('does not accept image input');
  });

  it('blames the file, not the model, when the payload was rejected', async () => {
    render(<App />);
    await sendPromptWithImage();

    postFromHost({ type: 'promptAccepted', imagesSent: 0, imagesDropped: 1, dropReason: 'validation' });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('could not be prepared');
    });
    expect(screen.getByRole('alert').textContent).not.toContain('does not accept image input');
  });

  it('does not blame the model when its capabilities are not known yet', async () => {
    render(<App />);
    await sendPromptWithImage();

    postFromHost({ type: 'promptAccepted', imagesSent: 0, imagesDropped: 1, dropReason: 'model-unknown' });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('capabilities are not known yet');
    });
    expect(screen.getByRole('alert').textContent).not.toContain('does not accept image input');
  });

  it('stays silent when every image was forwarded', async () => {
    render(<App />);
    await sendPromptWithImage();

    postFromHost({ type: 'promptAccepted', imagesSent: 1, imagesDropped: 0, dropReason: null });

    expect(screen.queryByRole('alert')).toBeFalsy();
  });
});
