/**
 * Component tests for the Composer's image-attachment path.
 *
 * The composer is the first hop of the image pipeline (webview → host → pi),
 * and a file that is rejected there leaves no trace at all: no chip, no
 * warning, and a prompt that silently reaches the model without the image.
 * These tests pin the behaviour that must be observable:
 *
 *  - a supported image reaches `onSend` (the pipeline's happy path),
 *  - an unsupported MIME type is rejected *and reported* to the user,
 *  - pressing Enter while the image is still being read does not send a
 *    prompt without the attachment (and does not throw the attachment away).
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const posted: unknown[] = [];

vi.mock('../vscodeApi', () => ({
  vscode: {
    postMessage: (m: unknown) => { posted.push(m); },
    getState: () => undefined,
    setState: (s: unknown) => s,
  },
}));

import { Composer } from './Composer';
import type { AttachedImage } from '@shared/messages';

// ── Environment stubs ──────────────────────────────────────────────────────

// jsdom has no object-URL support — stub it, and restore whatever was there.
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const revokeObjectURL = vi.fn();

beforeAll(() => {
  (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:mock';
  (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
});

afterAll(() => {
  (URL as unknown as Record<string, unknown>).createObjectURL = realCreateObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = realRevokeObjectURL;
});

/** A 1x1 PNG, base64-encoded. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeFile(name: string, type: string, bytes = PNG_B64): File {
  const bin = atob(bytes);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], name, { type });
}

/** Render the composer with a captured `onSend`. */
function renderComposer(overrides?: { supportsImages?: boolean }) {
  const { sends } = renderComposerWithRerender(overrides);
  return { sends };
}

/** Render the composer and expose a `rerender` that can flip `supportsImages`. */
function renderComposerWithRerender(overrides?: { supportsImages?: boolean }) {
  const sends: Array<{ text: string; images?: AttachedImage[] }> = [];
  const element = (supportsImages: boolean) => (
    <Composer
      isStreaming={false}
      piStatus={{ kind: 'found', path: '/x', version: '1' }}
      promptError={null}
      commands={[]}
      supportsImages={supportsImages}
      modelName="TestModel"
      onSend={(text, images) => { sends.push({ text, images }); }}
    />
  );
  const { rerender } = render(element(overrides?.supportsImages ?? true));
  return { sends, rerender: (supportsImages: boolean) => rerender(element(supportsImages)) };
}

/** Fake a paste carrying one clipboard item of the given type. */
function pasteImage(file: File) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
  const items = [{ kind: 'file', type: file.type, getAsFile: () => file }];
  fireEvent.paste(textarea, { clipboardData: { items } });
}

function typeAndSend(text: string) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = text;
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Composer — image attachment', () => {
  beforeEach(() => { posted.length = 0; });
  afterEach(() => { document.body.innerHTML = ''; });

  it('sends a pasted image with the prompt', async () => {
    const { sends } = renderComposer();
    pasteImage(makeFile('shot.png', 'image/png'));

    await waitFor(() => {
      expect(document.querySelector('.composer__chip')).toBeTruthy();
    });

    typeAndSend('what is this?');

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe('what is this?');
    expect(sends[0].images).toHaveLength(1);
    expect(sends[0].images?.[0].mimeType).toBe('image/png');
    expect(sends[0].images?.[0].data).toBe(PNG_B64);
  });

  it('reports an unsupported image type instead of dropping it silently', async () => {
    const { sends } = renderComposer();
    pasteImage(makeFile('scan.tiff', 'image/tiff'));

    // The user must be told — a silent drop is what made "the model never saw
    // my image" impossible to diagnose.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('not a supported image type');
    });
    expect(document.querySelector('.composer__chip')).toBeFalsy();

    typeAndSend('hello');
    expect(sends).toHaveLength(1);
    expect(sends[0].images).toBeUndefined();
  });

  it('does not send while an image is still being read', async () => {
    // Replace FileReader with one that never completes on its own, so the
    // read is still in flight when Enter is pressed.
    const realReader = globalThis.FileReader;
    class StuckFileReader {
      onload: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      result: string | null = null;
      readAsDataURL() { /* never fires — the read stays pending */ }
      abort() { this.onabort?.(); }
    }
    (globalThis as unknown as Record<string, unknown>).FileReader = StuckFileReader;

    try {
      const { sends } = renderComposer();
      pasteImage(makeFile('shot.png', 'image/png'));

      // The read starts synchronously inside the paste handler, so Enter is
      // pressed while it is still in flight.
      typeAndSend('too early');

      // The prompt must not be sent: the image would be lost with it.
      expect(sends).toHaveLength(0);
      // The user is told why, and the text stays in the box so they can just
      // press Enter again.
      expect(screen.getByRole('status').textContent).toContain('Still loading the attached image');
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('too early');
    } finally {
      (globalThis as unknown as Record<string, unknown>).FileReader = realReader;
    }
  });

  it('ignores a paste that carries no image', () => {
    const { sends } = renderComposer();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] } });

    typeAndSend('plain text');
    expect(sends).toHaveLength(1);
    expect(sends[0].images).toBeUndefined();
  });

  it('reports a clipboard image that cannot be read as a file', async () => {
    const { sends } = renderComposer();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    // The clipboard looks like it holds an image, but the browser refuses to
    // hand it over as a file — the user must be told, not left guessing.
    const items = [{ kind: 'file', type: 'image/png', getAsFile: () => null }];
    fireEvent.paste(textarea, { clipboardData: { items } });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Could not read the image from the clipboard');
    });

    typeAndSend('hello');
    expect(sends).toHaveLength(1);
    expect(sends[0].images).toBeUndefined();
  });

  it('sends every attachment, not just the ones from the last render', async () => {
    const { sends } = renderComposer();
    pasteImage(makeFile('one.png', 'image/png'));
    await waitFor(() => {
      expect(document.querySelectorAll('.composer__chip')).toHaveLength(1);
    });
    pasteImage(makeFile('two.png', 'image/png'));
    await waitFor(() => {
      expect(document.querySelectorAll('.composer__chip')).toHaveLength(2);
    });

    typeAndSend('both please');

    expect(sends).toHaveLength(1);
    expect(sends[0].images).toHaveLength(2);
    expect(sends[0].images?.map((i) => i.fileName)).toEqual(['one.png', 'two.png']);
  });

  it('releases the preview URL of a sent attachment', async () => {
    revokeObjectURL.mockClear();
    const { sends } = renderComposer();
    pasteImage(makeFile('one.png', 'image/png'));
    await waitFor(() => {
      expect(document.querySelector('.composer__chip')).toBeTruthy();
    });

    typeAndSend('send it');
    expect(sends).toHaveLength(1);

    // The blob URL must be revoked when the attachment is cleared — otherwise
    // every sent image leaks its preview for the lifetime of the webview.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('does not resend the same attachment with the next prompt', async () => {
    const { sends } = renderComposer();
    pasteImage(makeFile('one.png', 'image/png'));
    await waitFor(() => {
      expect(document.querySelector('.composer__chip')).toBeTruthy();
    });

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'twice';
    // Both key presses land inside one act() block, so React has not
    // re-rendered (and the reducer has not cleared the attachments) between
    // them — the case where the same attachment could travel twice.
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    expect(sends).toHaveLength(1);
    expect(sends[0].images).toHaveLength(1);
  });

  it('reports a file that could not be read', async () => {
    const realReader = globalThis.FileReader;
    class FailingFileReader {
      onload: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      result: string | null = null;
      error: unknown = null;
      readAsDataURL() { this.onerror?.(); }
      abort() { this.onabort?.(); }
    }
    (globalThis as unknown as Record<string, unknown>).FileReader = FailingFileReader;

    try {
      renderComposer();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = makeFile('broken.png', 'image/png');
      const fileList = { length: 1, 0: file, item: () => file } as unknown as FileList;
      fireEvent.change(input, { target: { files: fileList } });

      // The failure must be visible — a rejected attachment must never
      // vanish without a word.
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toContain('Could not read "broken.png"');
      });
      expect(document.querySelector('.composer__chip')).toBeFalsy();
    } finally {
      (globalThis as unknown as Record<string, unknown>).FileReader = realReader;
    }
  });

  it('does not block the next prompt after the attachments were cleared', async () => {
    const realReader = globalThis.FileReader;
    let aborted = false;
    class StuckFileReader {
      onload: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      result: string | null = null;
      readAsDataURL() { /* never completes on its own */ }
      abort() { aborted = true; this.onabort?.(); }
    }
    (globalThis as unknown as Record<string, unknown>).FileReader = StuckFileReader;

    try {
      const { sends, rerender } = renderComposerWithRerender();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = makeFile('stuck.png', 'image/png');
      const fileList = { length: 1, 0: file, item: () => file } as unknown as FileList;
      fireEvent.change(input, { target: { files: fileList } });

      // The model switches to one that cannot take images: the attachments
      // are cleared, which must also abort the read that is still running.
      rerender(false);
      await waitFor(() => {
        expect(aborted).toBe(true);
      });

      // A plain text prompt must not be blocked by the orphaned read.
      typeAndSend('just text');
      expect(sends).toHaveLength(1);
      expect(sends[0].text).toBe('just text');

      // The abort is internal — it must not explain itself with a note that
      // would overwrite the message the user actually needs.
      expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('was cancelled');
    } finally {
      (globalThis as unknown as Record<string, unknown>).FileReader = realReader;
    }
  });

  it('sends the text without the image when a read never finishes', async () => {
    const realReader = globalThis.FileReader;
    class StuckFileReader {
      onload: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      result: string | null = null;
      readAsDataURL() { /* never completes on its own */ }
      abort() { this.onabort?.(); }
    }
    (globalThis as unknown as Record<string, unknown>).FileReader = StuckFileReader;
    vi.useFakeTimers();

    try {
      const { sends } = renderComposer();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = makeFile('stuck.png', 'image/png');
      const fileList = { length: 1, 0: file, item: () => file } as unknown as FileList;
      fireEvent.change(input, { target: { files: fileList } });

      // The read is stuck. Waiting must not block the prompt forever.
      vi.advanceTimersByTime(11_000);
      typeAndSend('text only');

      expect(sends).toHaveLength(1);
      expect(sends[0].text).toBe('text only');
      expect(sends[0].images).toBeUndefined();
      expect(screen.getByRole('status').textContent).toContain('did not finish loading');
    } finally {
      vi.useRealTimers();
      (globalThis as unknown as Record<string, unknown>).FileReader = realReader;
    }
  });

  it('sends the images that were ready when another read hangs', async () => {
    const realReader = globalThis.FileReader;
    /** Completes for the first file, hangs for the second. */
    class MixedFileReader {
      onload: ((e: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      result: string | null = null;
      private static calls = 0;
      readAsDataURL() {
        MixedFileReader.calls += 1;
        if (MixedFileReader.calls === 1) {
          this.result = `data:image/png;base64,${PNG_B64}`;
          this.onload?.({ target: { result: this.result } });
        }
        // the second read never completes
      }
      abort() { this.onabort?.(); }
    }
    (globalThis as unknown as Record<string, unknown>).FileReader = MixedFileReader;
    vi.useFakeTimers();

    try {
      const { sends } = renderComposer();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      // First file: the read completes synchronously in the stub.
      const first = makeFile('ready.png', 'image/png');
      fireEvent.change(input, {
        target: { files: { length: 1, 0: first, item: () => first } as unknown as FileList },
      });
      // No waitFor here: fake timers would stall it, and the read already
      // completed synchronously.
      expect(document.querySelector('.composer__chip')).toBeTruthy();

      // Second file: the read hangs.
      const second = makeFile('hung.png', 'image/png');
      fireEvent.change(input, {
        target: { files: { length: 1, 0: second, item: () => second } as unknown as FileList },
      });

      vi.advanceTimersByTime(11_000);
      typeAndSend('text with one image');

      // The image that was ready must go out; the note must say so.
      expect(sends).toHaveLength(1);
      expect(sends[0].images).toHaveLength(1);
      expect(sends[0].images?.[0].fileName).toBe('ready.png');
      expect(screen.getByRole('status').textContent).toContain('sent with the image(s) that were ready');
    } finally {
      vi.useRealTimers();
      (globalThis as unknown as Record<string, unknown>).FileReader = realReader;
    }
  });
});
