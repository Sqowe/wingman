# Sqowe Wingman — Implementation Plan

A standalone VS Code extension that is a graphical front-end ("skin") over the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
SDK ("pi"). It renders pi's agent event stream natively, surfaces pi's user slash
commands in the chat input, promotes pi's built-in commands to native VS Code UI, and
wires pi's `edit` tool into VS Code's real diff editor.

> Status: planning. Date: 2026-06-21.
> Brand: a sibling to the **Sqowe Pilot** desktop app — *Pilot* flies solo on the
> desktop; *Wingman* rides alongside you in the editor.

---

## 0. Settled decisions

| Topic | Decision |
| --- | --- |
| Product / `displayName` | **Sqowe Wingman** |
| Marketplace `publisher` | `sqowe` (must be registered on the VS Code Marketplace — reserve early) |
| Extension `name` | `wingman` |
| Unique extension ID | `sqowe.wingman` |
| Command category (palette prefix) | "Sqowe Wingman" → e.g. "Sqowe Wingman: New Session" |
| Settings namespace | `sqoweWingman.*` |
| Git repo name | `sqowe-wingman` (or `wingman` if hosted under a `sqowe` GitHub org) |
| Branding / IP | Brand is **Sqowe-only**. pi is credited **descriptively** ("A VS Code client for the pi coding agent"), never absorbed into the product name. pi is MIT-licensed (author Mario Zechner, `github.com/earendil-works/pi`); ship pi's MIT copyright + license notice in the distribution. Do **not** reuse pi's logo or `pi.dev` branding. MIT grants no trademark rights, so keep "pi" out of the brand name. |
| Transport to pi | **RPC sidecar** — spawn `pi --mode rpc` as a child process. Kept behind an `AgentTransport` interface so an in-process SDK adapter can be added later. |
| pi acquisition | Detect a globally-installed `pi` → fall back to a bundled, pinned version → allow override via `sqoweWingman.piExecutablePath`. |
| Webview UI stack | React + Vite + Zustand (mirrors the Sqowe Pilot / Open Cowork renderer). |
| UI surface / placement | A **`WebviewView`** in a dedicated **activity-bar** view container (Cline / Continue model), **not** an editor-tab `WebviewPanel`. Dockable: defaults to the primary (left) side bar; the user can drag it to the secondary (right) side bar or the bottom panel. Onboarding suggests moving it to the right side bar so Source Control (git) stays visible on the left. A bottom-panel default (`contributes.viewsContainers.panel`) is the fallback if zero-setup dual-view matters more than chat height. |
| Marketplace target | A single **universal VSIX** (the RPC sidecar means no native binaries are bundled, so no per-platform builds are required). |

### Why RPC sidecar (not in-process SDK) is the default

- pi is pre-1.0 with frequent breaking changes; its **JSON RPC protocol is a more stable
  contract** than the TypeScript SDK surface.
- Process isolation — agent work cannot block or crash the VS Code extension host.
- **Zero native-dependency bundling** in the VSIX (see §7).

---

## 1. Goal & scope

**Goal.** A VS Code extension that reuses the same `~/.pi/agent/` global config and
per-project `.pi/` resources as the pi CLI, renders the full agent event stream natively,
and gives the two GUI affordances the terminal cannot: **collapsible / native diff views
for file changes**, and **copy buttons that yield clean source text** (not a screen-scrape).

**Non-goals (v1).** No sandbox VM, no remote channels (Feishu/Slack), no custom window
chrome. Those are desktop-app concerns that do not map to an editor extension.

---

## 2. Architecture

```
┌──────────────────── VS Code ────────────────────┐
│                                                  │
│  Extension Host (Node)          Webview (React)  │
│  ┌────────────────────┐  post   ┌─────────────┐  │
│  │ AgentController     │◄═══════►│ Chat UI     │  │
│  │  • AgentTransport   │ Message │ • MsgList   │  │
│  │  • CommandHandlers  │         │ • ToolCard  │  │
│  │  • DiffService      │         │ • Composer  │  │
│  │  • UiProtocolBridge │         │ • SlashMenu │  │
│  └─────────┬──────────┘         └─────────────┘  │
│            │ JSONL (stdin/stdout)                 │
└────────────┼─────────────────────────────────────┘
             ▼
       pi --mode rpc   (child process, cwd = workspace folder)
             │
             ▼  same ~/.pi/agent + project .pi/
        LLM providers
```

The VS Code **extension host is a Node.js process** — the same role Electron's main
process plays in Sqowe Pilot. The event shapes pi emits (`message_update`,
`tool_execution_*`, etc.) are identical across the SDK and RPC, so the webview render
layer is portable from the Pilot renderer.

---

## 3. Repo layout

```
sqowe-wingman/
├── package.json              # extension manifest + contributes.*
├── esbuild.mjs               # bundles the extension host
├── src/                      # extension host (Node)
│   ├── extension.ts          # activate / deactivate
│   ├── agent/
│   │   ├── transport.ts      # AgentTransport interface
│   │   ├── rpc-transport.ts  # spawn pi, JSONL framing, request/response correlation
│   │   ├── pi-locator.ts     # find global pi / bundled / configured path
│   │   └── controller.ts     # owns session lifecycle, fans events to the webview
│   ├── commands/             # native command handlers (model, compact, new, fork…)
│   ├── diff/diff-service.ts  # patch → vscode.diff / WorkspaceEdit
│   ├── ui-protocol/bridge.ts # extension_ui_request → quick-pick / modal
│   ├── webview/provider.ts   # WebviewViewProvider + host↔webview bridge
│   └── shared/messages.ts    # typed host↔webview message contract
├── webview-ui/               # React app (Vite)
│   └── src/{components,store,main.tsx}
├── media/                    # activity-bar icon, etc.
├── .vscodeignore
├── LICENSE                   # Sqowe Wingman license
├── THIRD_PARTY_NOTICES.md    # pi MIT notice + other deps
└── README.md
```

---

## 4. Tech stack

| Concern | Choice | Why |
| --- | --- | --- |
| Host bundling | esbuild | VS Code standard; fast |
| Webview UI | React + Vite + Zustand | Mirrors Sqowe Pilot renderer; eases component reuse |
| Markdown | react-markdown + remark/rehype | Clean source preserved for copy buttons |
| Styling | VS Code theme CSS variables (`--vscode-*`) | Auto-matches the user's editor theme |
| Tests | `@vscode/test-cli` + vitest | Integration + unit |
| Packaging | `@vscode/vsce` | VSIX + Marketplace |

---

## 5. Milestones (each independently shippable)

**MVP = phases 0–4** (chat + tool cards + native diff). That alone validates the full
stack and is a compelling demo.

| Phase | Goal | Key VS Code / pi APIs | Done when |
| --- | --- | --- | --- |
| **0 — Scaffold** | Extension activates, empty sidebar view, dual build pipeline, pi located | `contributes.viewsContainers/views`, `registerWebviewViewProvider`, `asWebviewUri`, CSP | Activity-bar icon opens an empty panel; `pi --version` resolves |
| **1 — Transport** | Spawn `pi --mode rpc`, JSONL client, event→webview bridge | `child_process`, custom LF reader (no `readline`), `webview.postMessage` | Events from a manual `prompt` appear in a dev console in the webview |
| **2 — Core chat** | Composer sends prompt; stream assistant text + thinking; abort | `prompt` / `abort`; `message_update` text/thinking deltas | Full text round-trip with a stop button |
| **3 — Tool cards** | Render `tool_execution_*`; bash output; copy buttons (clean source) | tool events; `vscode.env.clipboard` | Tool runs show live output cards with working copy |
| **4 — Native diff** ⭐ | `edit` patches → real diff editor + apply as pending changes | `details.patch`, `vscode.diff`, `TextDocumentContentProvider`, `WorkspaceEdit`, `workspace.applyEdit` | Clicking an edit opens VS Code's diff editor; accept writes the file |
| **5 — Commands** | User `/` menu + built-ins as native UI | `get_commands`; `contributes.commands/keybindings/menus`; `set_model` / `cycle_model` / `compact` / `new_session` / `fork` / `export_html` / `set_thinking_level` / `get_session_stats` | `/` autocomplete works; model quick-pick, compact, new/fork in palette; token stats in status bar |
| **6 — UI protocol** | Map pi extension dialogs to native prompts | `extension_ui_request` → `showQuickPick` / `showInputBox` / `showWarningMessage`; `notify` → notifications | Permission / confirm prompts render natively |
| **7 — Sessions** | List / switch / new / fork; reconnect | `switch_session`, `get_messages`, `get_fork_messages`; tree view; `workspaceState` | Session list view; resume after window reload |
| **8 — Config / trust** | cwd = workspace folder; project-trust flow; multi-root | `workspace.workspaceFolders`; pi project trust | Project `.pi/` resources load only when trusted; multi-root folder picker |
| **9 — Packaging** | Theming polish, CSP hardening, VSIX, Marketplace, tests, docs | `vsce`, `@vscode/test-cli` | Installable VSIX; CI green |

---

## 6. Key implementation notes

### RPC framing (do this correctly)
pi's RPC is strict JSONL with **LF (`\n`) as the only delimiter**. Split stdout on `\n`
only, strip a trailing `\r`, and **do not use Node `readline`** — it also splits on
`U+2028` / `U+2029`, which are valid inside JSON strings. Correlate commands↔responses via
the optional `id` field; treat events (which carry no `id`) as the render stream. See
pi's `docs/rpc.md` for the canonical JSONL reader example.

### Native diff (the headline feature)
On `tool_execution_end` for the `edit` tool, take `result.details.patch` — a standard
unified diff. Two render modes:
- **Preview**: register a `TextDocumentContentProvider` exposing before/after as virtual
  URIs, then `vscode.commands.executeCommand('vscode.diff', before, after, 'edit: file.ts')`.
  VS Code's diff editor provides syntax highlighting, inline/side-by-side toggle, and
  native copy for free.
- **Apply**: build a `WorkspaceEdit` and `workspace.applyEdit()` so changes appear as real
  pending edits in the Source Control panel with Accept/Discard.

This directly solves the terminal pain points: a collapsible/native diff for file changes,
plus navigation and apply.

### Commands split
- **User slash commands** (extension commands, prompt templates, skills): enumerate via the
  `get_commands` RPC call, render a `/` autocomplete menu in the composer, and invoke by
  sending `/name` through `prompt`. This is a true 1:1 duplicate of the CLI's command menu,
  including project-specific commands (shared `.pi/`).
- **Built-in TUI commands** (`/settings`, `/model`, `/new`, …) are **inert over RPC by
  design** (pi's docs note they only run in interactive mode). Reimplement their behavior
  as native `contributes.commands` wired to the matching RPC call:

  | TUI command | RPC / SDK equivalent |
  | --- | --- |
  | `/model` | `set_model` / `cycle_model` / `get_available_models` |
  | `/compact` | `compact` |
  | `/new` | `new_session` |
  | `/resume` | `switch_session` |
  | `/fork`, `/clone` | `fork`, `clone` |
  | `/export` | `export_html` |
  | thinking level | `set_thinking_level` / `cycle_thinking_level` |
  | token/cost stats | `get_session_stats` |
  | `/login` | AuthStorage / OAuth flows (SDK) |

### Config sharing with the CLI
Spawn pi with the child process `cwd` set to the active workspace folder and **no**
`--agent-dir` / `--session-dir` overrides. pi then reads the same `~/.pi/agent/`
(login/`auth.json`, `models.json`, themes, global skills/extensions/prompts, `AGENTS.md`)
and project `.pi/` the CLI uses, and writes to the shared `sessions/` directory. The
extension is a different front-end over the same brain and config. Honor pi's
**project-trust** gate before project-level `.pi/` resources (extensions, themes) load.

### Extension UI protocol
In RPC mode pi raises `extension_ui_request` events for `select` / `confirm` / `input` /
`editor` (blocking; reply with `extension_ui_response`) and fire-and-forget `notify` /
`setStatus` / `setWidget` / `setTitle`. Map blocking dialogs to `showQuickPick` /
`showInputBox` / `showWarningMessage`, and fire-and-forget ones to notifications / status
bar / webview banners. This is how permission prompts render natively instead of as
terminal selectors.

### UI surface & placement
The chat lives in a **`WebviewView`** registered in a dedicated **activity-bar** view container
(`contributes.viewsContainers.activitybar` + `contributes.views` + `registerWebviewViewProvider`) — the
Cline / Continue model — **not** an editor-area `WebviewPanel`. Rationale: a side-bar/panel view keeps
the **editor area free for the native diffs** (the headline feature) instead of competing with them, and
a `WebviewView` can be docked in the primary (left) side bar, the **secondary (right) side bar**, or the
bottom panel, whereas a `WebviewPanel` is confined to editor tabs.

A single side bar shows one view container at a time, so the left bar is git **or** Wingman — not both.
To keep Source Control visible alongside the chat, the user drags the Wingman view to the **secondary
(right) side bar** (left = git, right = Wingman). Note: an extension **cannot** pre-place a view in the
secondary side bar — per the VS Code UX docs it is an auxiliary location populated only by user drag
(which then persists) — so onboarding should *suggest* the move rather than assume it. If zero-setup
dual-view is preferred over chat height, default the container to the **bottom panel**
(`contributes.viewsContainers.panel`) instead, which leaves git in the left side bar untouched.

### Webview hardening
Strict CSP with a nonce; load all assets via `asWebviewUri`; set `retainContextWhenHidden`
for session continuity; **virtualize** the message list for long sessions; coalesce
`message_update` deltas per animation frame to avoid host↔webview message storms.

---

## 7. pi packaging facts (why a universal VSIX works)

Verified against `@earendil-works/pi-coding-agent` (v0.79.x):

- **No compile-on-install** anywhere — zero `binding.gyp` / node-gyp. pi's recommended
  install is `npm install --ignore-scripts`.
- The few native `.node` files are **prebuilt, per-platform, optional, and lazy-loaded**:
  - `@mariozechner/clipboard-*` — an **optionalDependency**; not needed (use
    `vscode.env.clipboard`).
  - `pi-tui/native/*` (`darwin-modifiers`, `win32-console-mode`) — **TUI-only**, loaded in
    a guarded `try/catch` that degrades to a no-op; never used by a webview/RPC client.
- `@silvia-odwyer/photon-node` ships **WASM** (`.wasm`), which is portable — no ABI.

Because the RPC sidecar keeps all of pi's native bits inside pi's own install, the VSIX
carries no platform binaries → a single universal VSIX, no per-platform builds, and **no
ABI rebuild step** (unlike the Sqowe Pilot Electron app, which must rebuild `better-sqlite3`
against Electron's ABI).

---

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| pi pre-1.0 API churn | Use RPC (stabler than the SDK); pin a tested pi version; isolate behind `AgentTransport` |
| pi not installed / wrong version | `pi-locator`: detect global → bundled pinned fallback → `sqoweWingman.piExecutablePath`; clear onboarding error |
| Multi-root workspace ambiguity | Explicit folder picker; one agent process per active folder |
| Concurrent CLI + extension writes | Sessions are separate files (safe); rely on pi's `proper-lockfile`; avoid simultaneous settings writes |
| Long sessions / large diffs | List virtualization; lazy-render big patches; cap inline diff size, offer "open in diff editor" |
| Webview ↔ host message storms (streaming deltas) | Batch / coalesce `message_update` deltas per animation frame |

---

## 9. Testing

- **Unit**: RPC JSONL framing (partial chunks, `\r\n`, embedded newlines), patch→diff
  mapping, command mapping table.
- **Integration**: `@vscode/test-cli` harness — activation, webview round-trip, command
  registration, native diff open/apply.
- **Manual smoke**: shared-config check (a session started in the CLI appears in the
  extension and vice versa); project-trust gating; multi-root folder switch.

---

## 10. References

pi documentation ships inside the npm package under its `docs/` directory:

- `rpc.md` — JSON RPC protocol: commands, events, extension UI sub-protocol, JSONL reader.
- `sdk.md` — `createAgentSession()` and run modes (for the future in-process adapter).
- `json.md` — the `AgentSessionEvent` / `AgentEvent` shapes the webview renders.
- `tui.md`, `themes.md` — terminal UI/theming (not used by the webview, but useful context).
- `skills.md`, `extensions.md`, `settings.md`, `sessions.md`, `security.md` — resource
  discovery, project trust, and the `.pi/` + `~/.pi/agent/` layout shared with the CLI.

Key VS Code APIs: `WebviewViewProvider`, `webview.postMessage` / `onDidReceiveMessage`,
`asWebviewUri`, `contributes.{commands,viewsContainers,views,keybindings,menus,configuration}`,
`commands.executeCommand('vscode.diff', …)`, `TextDocumentContentProvider`, `WorkspaceEdit`
/ `workspace.applyEdit`, `window.{createStatusBarItem,showQuickPick,showInputBox}`,
`workspace.workspaceFolders`, `ExtensionContext.{workspaceState,globalState}`.
