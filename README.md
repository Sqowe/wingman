# Sqowe Wingman

A VS Code client for the [pi coding agent](https://github.com/earendil-works/pi) — pi's full
agent loop, rendered natively in your editor.

Sqowe Wingman is a graphical front-end ("skin") over
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
("pi"). The extension host spawns `pi --mode rpc` as a child process, renders pi's agent event
stream natively in a webview, and wires pi's `edit` tool into VS Code's diff editor. Crucially,
it **reuses pi's own configuration** — the same `~/.pi/agent/` global config and per-project
`.pi/` resources the pi CLI uses. Wingman is a different front-end over the same brain, not a
separate tool with its own settings.

> **Status — `0.1.10` preview.** Phases 0–8 are complete: native chat, tool cards, native diff,
> commands, the extension-UI protocol bridge, sessions, and config/trust are all built and
> tested. Phase 9 (packaging / Marketplace) is in progress, so for now you install from source
> (see below). See [CHANGELOG.md](CHANGELOG.md) for what's new in each release, and the
> [user docs](https://github.com/sqowe/wingman/blob/main/docs/wiki/index.md) for end-user guides.

## Features

- **Native chat** — streaming assistant text and thinking, mid-turn abort, markdown rendering
  with safe link handling.
- **Tool cards** — a collapsible card for every tool call, with live output and copy buttons
  that yield clean source text (not a screen scrape).
- **Native diff** — `edit` results open in VS Code's real diff editor (*View Diff*) as a read-only
  before↔after preview, with syntax highlighting and side-by-side toggle for free. (pi's `edit`
  tool has already written the change to disk, so there's no separate apply step.)
- **Slash + native commands** — pi's user slash commands appear as `/` autocomplete in the
  composer (with argument hints for prompt templates that declare them, e.g. `<PR-URL>`);
  selecting one inserts `/name ` so you can add arguments before sending. pi's built-ins (model,
  thinking level, compact, new / fork / clone, export, session stats) are surfaced as native VS
  Code commands, menu items, and an always-visible status bar item.
- **Context-window indicator** — the session-stats status bar item shows live context usage as
  `tokens used / window · percent · message count` (e.g. `12.4k tok / 200k tok · 6% · 85 msg`).
  Hover for a tooltip; click to open the Show Stats popup.
- **Native dialogs** — pi's permission prompts and inputs render as VS Code quick-picks, modals,
  and input boxes instead of terminal selectors.
- **Sessions** — an activity-bar tree of your pi sessions for the open workspace, with switch /
  resume and full-fidelity transcript restore.
- **Project trust & multi-root** — honors pi's project-trust gate before loading project `.pi/`
  resources, with a folder picker for multi-root workspaces.
- **Instruction file visibility** — the status banner shows how many instruction files pi loaded
  for the session and opens a popover listing each file with its scope and role (e.g.
  `AGENTS.md (global)`, `CLAUDE.md (project)`). Data comes from pi itself via a bundled pi
  extension (`pi-extensions/instruction-report/`) — not a filesystem guess.
- **Reload pi Agent** — restarts the pi sidecar in place from the chat view-title `⋯` menu or
  Command Palette. Re-resolves the pi binary on every reload and preserves the current
  conversation by resuming the saved session file.
- **Collapsible long prompts** — long user messages in the transcript collapse to a bounded
  height with a soft fade and a *Show more / Show less* toggle, so a wall-of-text prompt no
  longer pushes the assistant's reply out of view. Short messages are unaffected.

## Prerequisites

pi is **not bundled** — install it yourself (it keeps its native bits in its own install, which
lets Wingman ship as a single universal VSIX):

```sh
npm install -g @earendil-works/pi-coding-agent
```

Then authenticate **once** with the pi CLI — Wingman reuses the saved credentials:

```sh
pi          # then run /login in the pi TUI and follow the prompts
```

Tested against pi **0.80.x**; older versions warn but are not blocked. Requires **Node ≥ 20**.

## Configuration

> **Configure pi, not the extension.** Wingman is a thin GUI over pi and shares pi's
> configuration files. Almost everything you'd want to change — your login / credentials, model
> providers and defaults, skills, extensions, themes, system prompts, and trust defaults — lives
> in **pi's** configuration, not in VS Code settings. Set it up once with pi (CLI or config
> files) and it applies to both the CLI and Wingman.

### VS Code settings (intentionally minimal)

The extension exposes only Wingman-side GUI settings; everything else belongs to pi:

| Setting | Default | Description |
| --- | --- | --- |
| `sqoweWingman.piExecutablePath` | `""` | Path to the `pi` executable (a leading `~` is expanded). Empty = auto-detect from `PATH`, npm-global, Homebrew, and Volta. |
| `sqoweWingman.showViewDiffButton` | `true` | Show the *View Diff* button on completed `edit` tool cards (read-only before↔after preview). Set to `false` to hide it. Changes apply to the running chat immediately. |

### pi's configuration (shared with the CLI)

Wingman spawns pi with its working directory set to your workspace folder and **no** config
overrides, so pi reads exactly the same files as your terminal `pi`:

| What you want to change | Where it lives | How to change it |
| --- | --- | --- |
| Login / credentials | `~/.pi/agent/` (e.g. `auth.json`) | `pi` → `/login` |
| Model providers & defaults | `~/.pi/agent/settings.json`, `models.json` | pi config — see pi's `models.md` / `providers.md` |
| Global skills, extensions, prompt templates, themes | `~/.pi/agent/` | pi config — see pi's `skills.md` / `extensions.md` / `themes.md`. Community pi extensions: [github.com/Sqowe/wingman](https://github.com/Sqowe/wingman) |
| Global agent instructions | `~/.pi/agent/AGENTS.md` | edit the file |
| Project-local settings & resources | `<project>/.pi/`, `<project>/AGENTS.md` | edit per project (loaded only once the project is trusted) |
| Default project-trust behavior | `defaultProjectTrust` in `~/.pi/agent/settings.json` (`"ask"` / `"always"` / `"never"`) | pi config, or `/settings` in the pi TUI |
| Sessions | `~/.pi/agent/sessions/` | shared automatically |

Because the configuration is shared, a session you start in the CLI shows up in Wingman (and
vice versa), and you only have to log in once. For the authoritative reference, see pi's own
`docs/` directory (`settings.md`, `models.md`, `providers.md`, `skills.md`, `extensions.md`,
`security.md`), which ships inside the npm package.

The in-editor commands (**Set Model**, **Set Thinking Level**, **Compact**, …) drive the
*running* pi session over RPC — convenient for the current conversation — but persistent
defaults still come from pi's configuration above.

### Project trust

When a project contains trust-gated `.pi/` resources (settings, extensions, skills, prompt
templates, themes, or system-prompt files) and has no saved decision, Wingman shows a native
**Trust / Don't Trust** prompt and saves your choice to pi's shared `~/.pi/agent/trust.json`.
Trusting loads the project's `.pi/` resources; declining skips them. Re-run the decision any
time with **Sqowe Wingman: Trust Project** from the command palette. In a multi-root workspace,
use **Sqowe Wingman: Select Workspace Folder** to choose which folder the agent runs in.

## Install from source

Wingman isn't on the Marketplace yet, so install it from this repo. You need **Node ≥ 20**,
**npm**, and [pi installed](#prerequisites).

```sh
git clone https://github.com/sqowe/wingman.git
cd sqowe-wingman
npm run install:all   # install host + webview dependencies
npm run build         # bundle host (esbuild) + webview (Vite) into dist/
```

Then pick one:

### Option A — Run in an Extension Development Host (recommended for trying it out)

Open the folder in VS Code and press **F5** (or *Run ▸ Run Extension*). The bundled
`.vscode/launch.json` builds the project and opens a second VS Code window with Wingman loaded;
its icon appears in the activity bar. This is the fastest way to test changes — edit code, then
reload the dev-host window with **Cmd/Ctrl+R**.

The dev host opens the `sample-workspace/` scratch folder so pi has a working directory (the
agent needs an open workspace folder to spawn). To test against the extension's own source
instead, point the trailing arg in `.vscode/launch.json` at `${workspaceFolder}`.

### Option B — Package a VSIX and install it into your daily VS Code

```sh
npm run vsce:package                       # produces sqowe-wingman-0.1.10.vsix
code --install-extension sqowe-wingman-0.1.10.vsix
```

Or in VS Code: **Extensions** view ▸ **⋯** menu ▸ *Install from VSIX…* ▸ pick the file, then
reload when prompted.

## Usage

Open a workspace folder and click the **Sqowe Wingman** icon in the activity bar. Two views
appear: **Chat** (composer + transcript) and **Sessions** (your pi sessions for this workspace).
Type a prompt and press **Enter** (**Shift+Enter** for a newline); type `/` to browse commands.
When pi changes a file, use **View Diff** on the tool card to see a read-only before↔after
preview (pi has already written the change to disk).

### Attaching images

When the active model supports image input (e.g. Claude claude-sonnet-4-5, GPT-4o), you can send
images alongside your prompt:

- **＋ button** — opens a file picker (PNG, JPEG, GIF, WebP).
- **Paste** — paste an image from the clipboard directly into the composer.
- **Drag and drop** — drag image files onto the composer textarea.

Attached images appear as thumbnail chips above the input; click **×** to remove one before
sending. Sending is allowed with images and no text (image-only prompts).

If the active model does not accept images the ＋ button is disabled and pasted/dropped images
are ignored with a brief note naming the model.

**Limits** (enforced on both the webview and the extension host):

| Limit | Value |
| --- | --- |
| Max size per image | 5 MB decoded |
| Max total image payload per prompt | 20 MB decoded |
| Max images per prompt | 10 |
| Accepted formats | PNG, JPEG, GIF, WebP |
| Max prompt text size | 32 KB (UTF-8) |

> Tip: drag the Wingman view to the **secondary (right) side bar** so Source Control stays
> visible on the left.

## Development

```sh
npm run install:all     # install host + webview dependencies
npm run build           # bundle the extension host (esbuild) + webview (Vite)
npm run typecheck       # type-check the extension host
npm test                # unit tests (host vitest + webview vitest)
npm run test:integration # integration tests in a real VS Code host (@vscode/test-cli)
```

Iterate with `npm run watch:host` and `npm run watch:webview` in separate terminals, then launch
the **Run Extension** debug target.

The repo is split into two build targets:

- `src/` — the extension host (Node / TypeScript), bundled with **esbuild** into
  `dist/extension.js`.
- `webview-ui/` — the React + Vite + Zustand webview, built into `dist/webview/`.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the `AI_*.md` files for the coding contracts.

## Credits & license

Sqowe Wingman is released under the [MIT License](LICENSE). It is a client for pi, which is an
independent MIT-licensed project by Mario Zechner; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for pi's copyright and license notice. "Sqowe
Wingman" is a Sqowe product name and is not affiliated with or endorsed by the pi project.
