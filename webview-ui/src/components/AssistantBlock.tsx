/**
 * AssistantBlock — renders one assistant chat item.
 * Text blocks use react-markdown; thinking blocks are collapsible.
 * A copy button on each block copies the clean source string (not rendered HTML).
 *
 * Link safety: all anchor elements are intercepted and posted to the host
 * as `openExternal` messages (scheme validation happens host-side). No
 * `javascript:` / `data:` URIs can navigate the webview.
 *
 * Performance: each text block's markdown output is memoized by content
 * so it is not re-parsed on every render during streaming of other blocks.
 */
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { AssistantItem } from '../store';
import { useChatStore } from '../store';
import { CopyButton } from './CopyButton';
import { vscode } from '../vscodeApi';

interface Props {
  item: AssistantItem;
}

/** Schemes the webview will forward to the host openExternal handler. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);



/** Intercept all links: validate scheme webview-side, then post to host for safe external opening. */
const markdownComponents: Components = {
  a({ href, children }) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (!href) return;
      // Webview-side scheme check (defense-in-depth — host also validates).
      try {
        const { protocol } = new URL(href);
        if (!ALLOWED_SCHEMES.has(protocol)) return;
      } catch {
        return; // not a valid URL
      }
      vscode.postMessage({ type: 'openExternal', url: href });
    };
    return (
      <a
        href={href}
        onClick={handleClick}
        style={{ cursor: 'pointer' }}
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },

  /**
   * Render fenced code blocks with a hover-reveal copy button.
   * Overriding `code` (not `pre`) gives direct access to the string
   * children, so the copy button copies clean source without backtick
   * fences. Inline code (no className) is left untouched.
   */
  /**
   * Block code: wrap in a div with a copy button. The copy text is
   * extracted here where `children` is still a plain string — no
   * backtick fences, no language tag.
   * react-markdown passes className="language-*" for language-tagged
   * fences. Plain fences (no language) have no className but are still
   * wrapped in <pre> by the default renderer — we let `pre` handle the
   * layout and only inject the copy button here when className is present.
   * For plain fences we fall through to the `pre` override which calls
   * back into this via nodeToText.
   */
  code({ children, className, node: _node, ...rest }) {
    const isBlock = /language-/.test(className ?? '');
    if (!isBlock) {
      // inline code or plain-fence code — render normally, let `pre` wrap it
      return <code className={className} {...rest}>{children}</code>;
    }
    const code = String(children ?? '').replace(/\n$/, '');
    return (
      <div className="code-block">
        <CopyButton text={code} label="Copy code" className="code-block__copy" />
        <pre><code className={className} {...rest}>{children}</code></pre>
      </div>
    );
  },

  /**
   * Plain-fence fallback: a <pre> whose <code> child has no language
   * className. Extract text from children (a React element tree) to
   * get clean source for the copy button.
   */
  pre({ children }) {
    // Only wrap with copy UI if the code override didn't already do it
    // (language-tagged blocks render their own wrapping div inside `code`).
    const codeText = (() => {
      if (!React.isValidElement(children)) return null;
      const child = children as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      if (/language-/.test(child.props.className ?? '')) return null; // already handled
      return String(child.props.children ?? '').replace(/\n$/, '');
    })();
    if (codeText === null) return <pre>{children}</pre>;
    return (
      <div className="code-block">
        <CopyButton text={codeText} label="Copy code" className="code-block__copy" />
        <pre>{children}</pre>
      </div>
    );
  },
};

/**
 * MemoMarkdown — memoized markdown block, only re-renders when `text` changes.
 * Raw HTML is explicitly disabled (skipHtml) as defense-in-depth against
 * XSS in assistant-provided content rendered inside the webview.
 */
const MemoMarkdown = React.memo(function MemoMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  );
});

export function AssistantBlock({ item }: Props) {
  const toggleThinking = useChatStore((s) => s.toggleThinking);

  // Build a single plain-text string for the top-level copy button
  // (copies all text blocks concatenated, not thinking).
  const fullText = useMemo(
    () =>
      item.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n\n'),
    [item.blocks],
  );

  return (
    <div className="assistant-block" aria-label="Assistant message">
      {/* Per-message copy button (top-right) */}
      {fullText.length > 0 && (
        <div className="assistant-block__actions">
          <CopyButton text={fullText} label="Copy response" />
        </div>
      )}

      {item.blocks.map((block, i) => {
        if (block.kind === 'text') {
          return (
            <div key={i} className="assistant-block__text">
              <MemoMarkdown text={block.text} />
            </div>
          );
        }

        // Thinking block
        const expanded = !block.collapsed;
        return (
          <div key={i} className="thinking-block">
            <button
              className="thinking-block__toggle"
              type="button"
              onClick={() => toggleThinking(item.id, i)}
              aria-expanded={expanded}
              aria-controls={`thinking-${item.id}-${i}`}
            >
              <span className={`thinking-block__chevron${expanded ? ' thinking-block__chevron--open' : ''}`}>
                ▶
              </span>
              Thinking
              {!expanded && block.text.length > 0 && (
                <span className="thinking-block__preview">
                  {block.text.slice(0, 80).replace(/\n/g, ' ')}
                  {block.text.length > 80 ? '…' : ''}
                </span>
              )}
            </button>

            {expanded && (
              <div
                id={`thinking-${item.id}-${i}`}
                className="thinking-block__body"
              >
                <CopyButton text={block.text} label="Copy thinking" className="thinking-block__copy" />
                <pre className="thinking-block__text">{block.text}</pre>
              </div>
            )}
          </div>
        );
      })}

      {!item.isComplete && (
        <span className="assistant-block__cursor" aria-hidden="true" />
      )}
    </div>
  );
}
