<!-- sources: README.md, ARCHITECTURE.md, src/agent/pi-locator.ts, package.json#contributes -->

# Getting started

Sqowe Wingman is a VS Code client for the pi coding agent. Because it reuses pi's own setup,
you install and authenticate pi first, then open the Wingman panel and start chatting.

## Install pi

pi is not bundled with Wingman — install it yourself:

```sh
npm install -g @earendil-works/pi-coding-agent
```

Requires Node 20 or newer. Wingman is tested against pi 0.80.x and later; older versions
show a warning but still run.

## Log in once

Authenticate with the pi CLI. Wingman reuses the saved credentials, so you only do this
once:

```sh
pi          # then run /login in the pi TUI and follow the prompts
```

## Install Wingman

Wingman isn't on the Marketplace yet, so install it from source. You need Node 20+, npm, and
pi already installed.

```sh
git clone https://github.com/sqowe/wingman.git
cd sqowe-wingman
npm run install:all   # install host + webview dependencies
npm run build         # bundle host (esbuild) + webview (Vite) into dist/
```

Then either run it in an Extension Development Host (press F5 in VS Code) or package and
install a VSIX:

```sh
npm run vsce:package                       # produces sqowe-wingman-0.1.8.vsix
code --install-extension sqowe-wingman-0.1.8.vsix
```

Or in VS Code: Extensions view → ⋯ menu → Install from VSIX… → pick the file, then reload.


## First run

1. Open a workspace folder. The agent needs an open folder to run in.
2. Click the Sqowe Wingman icon in the activity bar. Two views appear: Chat and Sessions.
3. Type a prompt in the composer and press Enter (Shift+Enter for a newline).
4. When pi edits a file, use View Diff or Apply on the tool card to review the change.

Type `/` in the composer to browse pi's commands.

![First Run view](assets/first-run.png)

> Tip: drag the Wingman view to the secondary (right) side bar so Source Control stays
> visible on the left.

## Where configuration lives

Almost everything you'd want to change — login, model providers and defaults, skills,
extensions, themes, system prompts, trust defaults — lives in pi's configuration, not in VS
Code settings. Set it up once with pi and it applies to both the CLI and Wingman. Wingman's
own VS Code settings are intentionally minimal; see [Settings](reference/settings.md).

---
[← All docs](index.md)
