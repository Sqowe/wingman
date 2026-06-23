# Sqowe Wingman

A VS Code client for the [pi coding agent](https://github.com/earendil-works/pi).

Sqowe Wingman is a graphical front-end ("skin") over the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent ("pi"). The extension host spawns `pi --mode rpc` as a child process, renders pi's
agent event stream natively in a webview, and wires pi's `edit` tool into VS Code's diff
editor. It reuses the same `~/.pi/agent/` global config and per-project `.pi/` resources as
the pi CLI — it is a different front-end over the same brain.

> **Status: early development — MVP complete (Phases 0–4).** The extension activates, locates
> pi, spawns `pi --mode rpc`, and renders the full chat loop: streaming assistant text and
> thinking, collapsible tool cards, and native diff (View Diff / Apply) for `edit` patches.
> Commands, sessions, and packaging land in later phases. See
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the phased roadmap.

## Prerequisites

pi is **not bundled** — you must install it yourself (it keeps its native bits in its own
install, which lets Wingman ship as a single universal VSIX):

```sh
npm install -g @earendil-works/pi-coding-agent
```

Wingman resolves the executable from the `sqoweWingman.piExecutablePath` setting, then `pi`
on your `PATH`, then common install locations (npm global, Homebrew, Volta). Tested against
pi **0.79.9**; older versions warn but are not blocked.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sqoweWingman.piExecutablePath` | `""` | Path to the `pi` executable (a leading `~` is expanded). Empty = auto-detect. |

## Install from source

Wingman isn't on the Marketplace yet, so install it from this repo. You need **Node ≥ 20**,
**npm**, and [pi installed](#prerequisites).

```sh
git clone https://github.com/sqowe/sqowe-wingman.git
cd sqowe-wingman
npm run install:all   # install host + webview dependencies
npm run build         # bundle host (esbuild) + webview (Vite) into dist/
```

Then pick one:

### Option A — Run in an Extension Development Host (recommended for trying it out)

Open the folder in VS Code and press **F5** (or *Run ▸ Run Extension*). The bundled
`.vscode/launch.json` builds the project and opens a second VS Code window with Wingman
loaded; its icon appears in the activity bar. This is the fastest way to test changes — edit
code, then reload the dev-host window with **Cmd/Ctrl+R**.

### Option B — Package a VSIX and install it into your daily VS Code

```sh
npm run vsce:package                       # produces wingman-0.0.1.vsix
code --install-extension wingman-0.0.1.vsix
```

Or in VS Code: **Extensions** view ▸ **⋯** menu ▸ *Install from VSIX…* ▸ pick the file, then
reload when prompted.

## Development

```sh
npm run install:all   # install host + webview dependencies
npm run build         # bundle the extension host (esbuild) + webview (Vite)
npm run typecheck     # type-check the extension host
```

Iterate with `npm run watch:host` and `npm run watch:webview` in separate terminals, then
launch the **Run Extension** debug target.

The repo is split into two build targets:

- `src/` — the extension host (Node / TypeScript), bundled with **esbuild** into `dist/extension.js`.
- `webview-ui/` — the React + Vite + Zustand webview, built into `dist/webview/`.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the `AI_*.md` files for the coding contracts.

## Credits & license

Sqowe Wingman is released under the [MIT License](LICENSE). It is a client for pi, which is
an independent MIT-licensed project by Mario Zechner; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for pi's copyright and license notice.
"Sqowe Wingman" is a Sqowe product name and is not affiliated with or endorsed by the pi
project.
