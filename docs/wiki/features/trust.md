<!-- sources: README.md, src/trust/, docs/chats/implementing-phase-8-configtrust-features-2026-06-24.md, contributes.commands[trustProject,selectFolder] -->

# Project trust & multi-root

## What it is / when to use it

A project can carry its own `.pi/` resources — settings, extensions, skills, prompt
templates, themes, or system-prompt files. Those can change how the agent behaves, so
loading them from a folder you don't fully trust is a risk. Wingman honors pi's project-trust
gate: the first time you open a project with trust-gated `.pi/` resources and no saved
decision, it shows a native Trust / Don't Trust prompt.

Trusting loads the project's `.pi/` resources; declining skips them. Your choice is saved to
pi's shared `~/.pi/agent/trust.json`, so it's remembered and shared with the pi CLI. You can
re-run the decision any time.

If you work in a multi-root workspace, the agent runs in one folder at a time. Use Select
Workspace Folder to choose which one.

## How to use it

1. Open a project with `.pi/` resources. If there's no saved decision, answer the Trust /
   Don't Trust prompt.
2. To change your mind later, run Trust Project (.pi/ Resources) from the Command Palette.
3. In a multi-root workspace, run Select Workspace Folder (also in the Chat `⋯` menu when
   more than one folder is open) to pick the agent's working folder.

> ⚠️ TODO (human): screenshot of the Trust / Don't Trust prompt.

## Commands & settings

| Command | How to run |
| --- | --- |
| Trust Project (.pi/ Resources) | Command Palette → Sqowe Wingman: Trust Project |
| Select Workspace Folder | Command Palette → Select Workspace Folder, or Chat `⋯` menu (shown when the workspace has more than one folder) |

---
[← All docs](../index.md)
