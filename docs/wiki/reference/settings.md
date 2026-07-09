<!-- sources: package.json#contributes.configuration -->

# Settings

Sqowe Wingman's VS Code settings are intentionally minimal. It's a thin GUI over pi and
shares pi's configuration files, so almost everything — login, model providers and defaults,
skills, extensions, themes, system prompts, trust defaults — lives in pi's configuration, not
here. Set that up once with pi (CLI or config files) and it applies to both the CLI and
Wingman. See [Getting started](../getting-started.md) for where pi's configuration lives.

The settings below are the only ones Wingman itself contributes. Find them in VS Code under
Settings → search "Sqowe Wingman".

| Setting | Default | What it does |
| --- | --- | --- |
| `sqoweWingman.piExecutablePath` | `""` | Path to the `pi` executable (a leading `~` is expanded to your home directory). Leave empty to auto-detect from `PATH` and common install locations (npm global, Homebrew, Volta). |
| `sqoweWingman.editToolActions` | `"both"` | Action buttons shown on completed `edit` tool cards. `both` = View Diff + Apply; `diffOnly` = hide Apply; `applyOnly` = hide View Diff; `none` = hide both. Changing this updates the running chat immediately. |

---
[← All docs](../index.md)
