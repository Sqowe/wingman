/**
 * Shared markdown rendering for the chat surface.
 *
 * Extracted from AssistantBlock so every surface that renders model- or
 * extension-authored markdown — assistant messages and question-card option
 * previews — applies the identical safety rules. Duplicating them would mean two
 * places to keep in step, and the link interception below is a security control,
 * not styling.
 *
 * Two guarantees, both defence-in-depth:
 *  - Raw HTML is disabled (`skipHtml`), so untrusted content cannot inject markup.
 *  - Every link is intercepted, scheme-checked here, and handed to the host as an
 *    `openExternal` message. The host validates the scheme again. Nothing can
 *    navigate the webview, and no `javascript:` / `data:` URI is ever followed.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { CopyButton } from './CopyButton';
import { vscode } from '../vscodeApi';

/** Schemes the webview will forward to the host openExternal handler. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);



/** Intercept all links: validate scheme webview-side, then post to host for safe external opening. */
export const markdownComponents: Components = {
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
   * Fenced code blocks get a hover-reveal copy button.
   *
   * The work is split between `code` and `pre` because of where clean source text
   * is reachable. react-markdown sets `className="language-*"` on a
   * language-tagged fence, and here `children` is still a plain string — so the
   * copy text can be taken without backtick fences or the language tag. Those
   * cases are wrapped with their copy button here.
   *
   * A plain fence (no language) has no className, so it is indistinguishable from
   * inline code at this point; it falls through to the default `<code>` and is
   * wrapped by the `pre` override below, which extracts the text from its child
   * element instead. Inline code is left untouched by both.
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
export const MemoMarkdown = React.memo(function MemoMarkdown({ text }: { text: string }) {
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

