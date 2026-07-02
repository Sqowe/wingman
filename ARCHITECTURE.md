# Architecture Overview

## 1. Purpose of This Document

This document describes the structure and runtime model of **Sqowe Wingman** — a VS Code
extension that is a graphical front-end over the pi coding agent
(`@earendil-works/pi-coding-agent`). It is the architectural source of truth: what the components
are, how they connect, and which parts are stable vs. likely to change.

> Status: **Phases 0–8 complete, Reload pi Agent feature complete** (2026-06-24 / 2026-07-01). The extension host, webview, pi locator, RPC
> transport + event→webview bridge, core chat, tool cards, native diff, native commands, the
> extension-UI protocol bridge, sessions (list / switch / resume, workspace-scoped), config / trust,
> and the Reload pi Agent action are all built and tested; Phase 9 (packaging) is next. The phases follow
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), the authoritative, detailed plan. This file is
> kept in sync with the code **as-is** as each phase lands — it does not describe unbuilt structure.

This document does **not** define coding rules — see §8.

## 2. High-Level System Overview

Sqowe Wingman renders pi's agent event stream inside VS Code and wires pi's `edit` tool into the
native diff editor. It contains no LLM or agent loop of its own: it is a different front-end over
the same "brain" and configuration the pi CLI uses (`~/.pi/agent/` global + project `.pi/`).

Three runtime pieces:

- **Extension host** (Node / TypeScript) — owns the session lifecycle, the transport to pi, native
  commands, the diff service, and the host↔webview bridge.
- **Webview** (React) — renders chat, tool cards, and diffs; sends user input back to the host.
- **pi RPC sidecar** — `pi --mode rpc`, a child process (`cwd` = workspace folder) that runs the
  actual agent and streams JSONL events.

```
┌──────────────────── VS Code ────────────────────┐
│  Extension Host (Node)          Webview (React)  │
│  ┌────────────────────┐  post   ┌─────────────┐  │
│  │ AgentController     │◄═══════►│ Chat UI     │  │
│  │  • AgentTransport   │ Message │ • ToolCard  │  │
│  │  • CommandHandlers  │         │ • Composer  │  │
│  │  • DiffService      │         │ • SlashMenu │  │
│  │  • UiProtocolBridge │         └─────────────┘  │
│  └─────────┬──────────┘                           │
│            │ JSONL (stdin/stdout)                 │
└────────────┼─────────────────────────────────────┘
             ▼
       pi --mode rpc   (child process, cwd = workspace folder)
             ▼  same ~/.pi/agent + project .pi/  →  LLM providers
```

## 3. Repository Structure

Target layout (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §3 for detail):

- `/src` — extension host (Node): `extension.ts`, plus `agent/`, `webview/`, `shared/`, `commands/`,
  `diff/`, `ui-protocol/`, `sessions/`, `trust/`, and `status-bar.ts`.
- `/webview-ui` — React app (Vite): `components/`, `store/`, `main.tsx`.
- `/media` — activity-bar icon and static assets.
- `/pi-extensions` — bundled pi extensions the host always loads via `-e` when spawning pi; one
  subfolder per extension (e.g. `pi-extensions/instruction-report/`), each with its own `README.md`.
  Coding rules: [AI_EXTENSION_HOST.md](AI_EXTENSION_HOST.md).
- `/docs` — design docs; `docs/chats/` holds prior implementation conversations.
- Root — `package.json` (manifest + `contributes.*`), `esbuild.mjs`, `IMPLEMENTATION_PLAN.md`,
  `CLAUDE.md`, the `AI_*.md` rule files, and licensing / third-party notices.

## 4. Core Components

### 4.1 Extension Host
Activation, the `AgentController` (session lifecycle; fans pi events to the webview), the
`AgentTransport` interface, native command handlers, the diff service, and the UI-protocol bridge.
Coding rules: [AI_EXTENSION_HOST.md](AI_EXTENSION_HOST.md).

### 4.2 Webview UI
The React + Zustand chat surface: message list, tool cards, composer, slash-command menu. Hosted in
a `WebviewView` inside an activity-bar view container, dockable to the secondary (right) side bar or
the bottom panel. Coding rules: [AI_WEBVIEW.md](AI_WEBVIEW.md).

### 4.3 Agent Transport / pi Sidecar
The RPC client that spawns `pi --mode rpc`, frames JSONL, correlates commands with responses, and
emits the render event stream. Implemented in Phase 1 as `RpcTransport` (id-correlated
request/response, an `onEvent` render stream, and an `onClose` signal for unexpected exits); the only
`AgentTransport` implementation for v1. Coding rules: [AI_PI_RPC.md](AI_PI_RPC.md).

### 4.4 External Integrations
- **pi** (`@earendil-works/pi-coding-agent`, MIT) — the agent engine, run as an RPC sidecar.
- **LLM providers** — reached by pi, not by the extension. Auth and model config live in
  `~/.pi/agent/` and are shared with the pi CLI.

## 5. Data Flow & Runtime Model

1. User types in the webview composer → `postMessage` → host.
2. Host sends a `prompt` (or other command) as JSONL to the pi child process.
3. pi streams events (`message_update`, `tool_execution_*`, …) back over stdout.
4. Host forwards events to the webview, which renders them; `edit` patches are routed to the diff
   service for a native diff / `WorkspaceEdit`.
5. Blocking `extension_ui_request` events become native quick-picks / inputs; the reply goes back as
   `extension_ui_response`.

Config is shared with the CLI by default (no dir overrides); sessions are written to pi's shared
`sessions/`. One pi process per active workspace folder.

## 6. Configuration & Environment Assumptions

- pi must be user-installed (not bundled); resolved via `sqoweWingman.piExecutablePath`, else the
  user's login-shell `PATH` + `which` + common/nvm bin dirs, choosing the highest version found, with
  a non-blocking version-check warning below the declared minimum.
- Extension settings under the `sqoweWingman.*` namespace.
- Shared config roots: `~/.pi/agent/` (global) and `<workspace>/.pi/` (project, gated by pi's
  project-trust flow).
- A single universal VSIX; no native binaries bundled (the sidecar keeps pi's native bits in pi's
  own install). No Python, Docker, or backend services.

## 7. Stability Zones

- **Stable** — the host↔webview message contract (`src/shared/messages.ts`) and the
  `AgentTransport` interface. Change these deliberately; many call sites depend on them.
- **Semi-stable** — webview components and native command wiring; expected to evolve with the UX.
- **Experimental** — anything depending on pi's pre-1.0 surface. The RPC protocol is treated as the
  stabler contract; pin a tested pi version and isolate churn behind `AgentTransport`.

## 8. AI Coding Rules and Behavioral Contracts

AI-assisted development in this project is governed by dedicated rule files.

**This document (ARCHITECTURE.md) does NOT redefine coding rules.**

All AI coders MUST:

- Locate and read the relevant rule files before making any changes.
- Apply those rules strictly and consistently.
- Resolve conflicts conservatively, or stop and escalate as an open question.

### Authoritative rule files

- [CLAUDE.md](CLAUDE.md) — project-global behavioral rules (confirm-before-action, never
  stage/commit, what to read first). *Fills the "global `AI.md`" role for this repo.*
- [AI_EXTENSION_HOST.md](AI_EXTENSION_HOST.md) — extension host (Node / TypeScript).
- [AI_WEBVIEW.md](AI_WEBVIEW.md) — webview UI (React + Vite + Zustand).
- [AI_PI_RPC.md](AI_PI_RPC.md) — the pi RPC contract.

### Rule precedence (highest → lowest)

1. Explicit instructions from the user in the current task.
2. Stack-specific `AI_*.md` (host / webview / pi-rpc) for the code being touched.
3. Project-global behavioral rules ([CLAUDE.md](CLAUDE.md)).
4. This `ARCHITECTURE.md` (architecture constraints only).
5. Implicit conventions inferred from the codebase.

If any rule conflicts or ambiguity is detected, **stop and ask for clarification.**
