/**
 * Security tests for the shared markdown renderer.
 *
 * `MemoMarkdown` renders content authored outside the webview — model output in
 * assistant messages, and extension-authored question text and option previews.
 * Two controls make that safe, and both are asserted here rather than assumed:
 *
 *  1. Raw HTML is not rendered (`skipHtml`), so untrusted content cannot inject
 *     markup or an event-handler attribute.
 *  2. Every link is intercepted. The scheme is checked in the webview and the URL
 *     is handed to the host as an `openExternal` message (which validates it
 *     again). Nothing navigates the webview, and no `javascript:` / `data:` URI
 *     is ever followed.
 *
 * These live in their own file because the component is shared: a regression here
 * would affect every markdown surface at once, so the guarantees are pinned to
 * the component itself rather than to one of its callers.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoMarkdown } from './Markdown';
import { vscode } from '../vscodeApi';

vi.mock('../vscodeApi', () => ({
  vscode: { postMessage: vi.fn() },
}));

const postMessage = vscode.postMessage as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  postMessage.mockClear();
});

describe('MemoMarkdown — raw HTML is not rendered', () => {
  it('does not render an injected img with an onerror handler', () => {
    const { container } = render(
      <MemoMarkdown text={'Before\n\n<img src=x onerror="alert(1)">\n\nAfter'} />,
    );

    // The tag must not become an element...
    expect(container.querySelector('img')).toBeNull();
    // ...and no handler attribute survives anywhere.
    expect(container.innerHTML).not.toContain('onerror');
    // The surrounding markdown still renders.
    expect(screen.getByText(/Before/)).toBeInTheDocument();
    expect(screen.getByText(/After/)).toBeInTheDocument();
  });

  it('does not render an injected script tag', () => {
    const { container } = render(<MemoMarkdown text={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
  });

  it('does not render an injected iframe', () => {
    const { container } = render(
      <MemoMarkdown text={'<iframe src="https://example.com"></iframe>'} />,
    );
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('leaves HTML inside a fenced code block as visible text', () => {
    // A code sample is content, not markup: it must be shown, not executed.
    const { container } = render(
      <MemoMarkdown text={'```html\n<img src=x onerror="alert(1)">\n```'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
  });
});

describe('MemoMarkdown — links are intercepted', () => {
  it('posts openExternal instead of navigating for an http link', () => {
    render(<MemoMarkdown text={'[docs](https://example.com/page)'} />);

    const link = screen.getByRole('link', { name: 'docs' });
    const clicked = fireEvent.click(link);

    // preventDefault() was called, so the webview does not navigate.
    expect(clicked).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openExternal',
      url: 'https://example.com/page',
    });
  });

  it('forwards a mailto link', () => {
    render(<MemoMarkdown text={'[mail](mailto:someone@example.com)'} />);
    fireEvent.click(screen.getByRole('link', { name: 'mail' }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openExternal',
      url: 'mailto:someone@example.com',
    });
  });

  it('does not forward a javascript: URI', () => {
    render(<MemoMarkdown text={'[click me](javascript:alert(1))'} />);

    const link = screen.queryByRole('link', { name: 'click me' });
    // react-markdown may drop the href entirely; if it renders, clicking it must
    // still post nothing. Either outcome is safe — assert the outcome, not the
    // mechanism.
    if (link) fireEvent.click(link);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not forward a data: URI', () => {
    render(<MemoMarkdown text={'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'} />);

    const link = screen.queryByRole('link', { name: 'x' });
    if (link) fireEvent.click(link);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not forward a vscode: URI', () => {
    // Only http / https / mailto are allowed; anything else stays unopened.
    render(<MemoMarkdown text={'[cmd](vscode://some/command)'} />);

    const link = screen.queryByRole('link', { name: 'cmd' });
    if (link) fireEvent.click(link);

    expect(postMessage).not.toHaveBeenCalled();
  });
});
