# AI rules — Webview UI (React + Vite + Zustand)

Scope: `webview-ui/**` — the React app rendered inside the VS Code webview. See
[ARCHITECTURE.md](ARCHITECTURE.md) for placement. The webview has no Node, no `vscode` module, and
no filesystem; its only channel to the host is `postMessage`.

## Stack

- React + **Vite** build, **Zustand** for state, TypeScript `strict`.
- Mirror the Sqowe Pilot / Open Cowork renderer patterns where it eases component reuse.
- Markdown via `react-markdown` + remark/rehype. Always keep the **clean source string**
  alongside the rendered output so copy buttons copy data, not rendered pixels.

## Security (non-negotiable)

- Strict **Content-Security-Policy with a per-load nonce**. No inline `<script>`/`<style>` without
  the nonce; no remote origins.
- Load every asset (JS, CSS, fonts, images) through `webview.asWebviewUri`.
- Treat the webview as untrusted UI: never `eval`, never inject unsanitized HTML.

## Theming

- Use VS Code theme CSS variables (`--vscode-*`) for all colors, fonts, and spacing so the UI
  auto-matches the user's editor theme. Do not hardcode hex colors.

## Host ↔ webview messaging

- All messages use the typed contract in `src/shared/messages.ts` (shared by host and webview).
  Add a new message type there first; never send ad-hoc, untyped payloads.
- **Coalesce streaming `message_update` deltas per animation frame** — do not re-render on every
  delta (avoids host↔webview message storms).
- **Virtualize** the message list for long sessions.

## State & persistence

- Keep the agent event stream as data in the store and render components from it. Don't store
  pre-rendered strings.
- `retainContextWhenHidden` is set host-side for continuity; still treat webview state as
  ephemeral and rehydratable from the host.
