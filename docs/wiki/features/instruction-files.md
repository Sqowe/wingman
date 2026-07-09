<!-- sources: README.md, docs/design/instruction-files.md, pi-extensions/instruction-report/, src/webview/provider.ts, webview-ui/src/App.tsx, docs/chats/implementing-instruction-file-reporting-feature-2026-07-02.md -->

# Instruction file visibility

## What it is / when to use it

Unlike a single fixed instructions file, pi can load several instruction files at once — some
that inject context (like `AGENTS.md` / `CLAUDE.md`) and some that override or append to the
system prompt (`SYSTEM.md` / `APPEND_SYSTEM.md`), from both global and project scopes. It's
easy to lose track of which ones are actually shaping the current session.

Wingman surfaces this in the status banner. It shows how many instruction files pi loaded for
the session, and opens a popover listing each file with its scope and role — for example
`AGENTS.md (global)` or `CLAUDE.md (project)`. This is ground truth: the data comes from pi
itself, through a small bundled pi extension, not a filesystem guess. Use it when you want to
confirm what rules the agent is operating under.

## How to use it

1. Look at the status banner in the Chat view — it shows the count of loaded instruction
   files for the session.
2. Click it to open the popover and see each file with its scope (global / project) and role.

If you edit an instruction file, use [Reload pi Agent](reload-agent.md) to have pi re-read it.

> ⚠️ TODO (human): screenshot of the instruction-files popover.

---
[← All docs](../index.md)
