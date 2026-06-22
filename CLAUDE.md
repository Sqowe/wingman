# Sqowe Wingman

A standalone VS Code extension that is a graphical front-end ("skin") over the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent ("pi"). The extension host spawns `pi --mode rpc` as a child process, renders pi's agent
event stream natively in a webview, and wires pi's `edit` tool into VS Code's diff editor.

> Status: **planning / pre-Phase-0.** There is no application code yet.
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is the authoritative design source.

## Read before making changes

1. [ARCHITECTURE.md](ARCHITECTURE.md) — system structure, components, stability zones.
2. The relevant `AI_*.md` file(s) for the code you are touching — coding rules (see below).
3. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — phased plan, settled decisions, key
   implementation notes.
4. `docs/chats/` — prior design conversations that produced the plan.

## Coding rules live in `AI_*.md` (do not duplicate them here)

| File | Scope |
| --- | --- |
| [AI_EXTENSION_HOST.md](AI_EXTENSION_HOST.md) | Extension host (Node / TypeScript): VS Code API, esbuild, transport, diff service |
| [AI_WEBVIEW.md](AI_WEBVIEW.md) | Webview UI (React + Vite + Zustand): CSP, theming, host↔webview messaging |
| [AI_PI_RPC.md](AI_PI_RPC.md) | The pi RPC contract: JSONL framing, command/event split, extension-UI sub-protocol |

`ARCHITECTURE.md` and the `AI_*.md` files must not redefine or duplicate each other's content.

## Working agreement

- **Confirm before acting.** Never create, edit, or delete files, run state-changing commands,
  or write to external systems without explicit user approval. First explain the situation,
  propose specifics (which files, what changes, what commands), then wait for a clear "yes."
  Read-only work (reading, searching, analyzing, answering) needs no confirmation.
  Exception: if the user says "just do it" / "go ahead," proceed directly.
- **Don't commit unprompted.** Run `git add` / `git commit` / `git push` only when the user
  explicitly asks for it — never as an unrequested side-effect of another task.
- **Stop and ask** if anything is unclear or contradictory.

## Tooling

- Node + npm. The extension host is bundled with **esbuild**; the webview is built with **Vite**.
- Packaging via `@vscode/vsce` — a single universal VSIX (no native binaries are bundled, because
  pi runs as an RPC sidecar and keeps its native bits in its own install).
- No Python, Docker, or backend services are part of this project.
