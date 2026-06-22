# Sqowe Wingman

A VS Code client for the [pi coding agent](https://github.com/earendil-works/pi).

Sqowe Wingman is a graphical front-end ("skin") over the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent ("pi"). The extension host spawns `pi --mode rpc` as a child process, renders pi's
agent event stream natively in a webview, and wires pi's `edit` tool into VS Code's diff
editor. It reuses the same `~/.pi/agent/` global config and per-project `.pi/` resources as
the pi CLI — it is a different front-end over the same brain.

> **Status: early development (Phase 0 — scaffold).** The extension activates, shows an
> activity-bar view, and locates pi. The chat transport and UI land in later phases. See
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
