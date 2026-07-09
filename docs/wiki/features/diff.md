<!-- sources: README.md, src/diff/, docs/chats/implementing-vs-code-diff-editor-for-tool-results-2026-06-22.md, contributes.settings[editToolActions] -->

# Native diff

## What it is / when to use it

When the agent edits a file, you want to see exactly what changed before you accept it.
Wingman routes pi's `edit` tool results into VS Code's real diff editor, so file changes get
the same syntax highlighting, side-by-side toggle, and navigation you already use for git
diffs — no plain-text patch to squint at.

Each completed edit card gives you two actions:

- **View Diff** — open the change in the diff editor to inspect it.
- **Apply** — apply the edit as a pending Source Control change, so it shows up in your
  git working tree for you to review, stage, or discard.

Use View Diff when you just want to look; use Apply when you're ready to bring the change
into your working copy.

## How to use it

1. When the agent finishes an `edit`, find its tool card in the transcript.
2. Click View Diff to open the change in the diff editor, or Apply to stage it as a pending
   change.
3. Review, then keep or discard it through normal VS Code / Source Control controls.

You can control which buttons appear with the `sqoweWingman.editToolActions` setting — handy
if you always want to skip straight to Apply, or only ever want to look via View Diff.

> ⚠️ TODO (human): screenshot of an edit tool card and the resulting diff editor.

## Commands & settings

| Setting | Default | What it does |
| --- | --- | --- |
| `sqoweWingman.editToolActions` | `both` | Which buttons show on completed `edit` cards: `both` = View Diff + Apply, `diffOnly` = hide Apply, `applyOnly` = hide View Diff, `none` = hide both. Changes apply to the running chat immediately. |

---
[← All docs](../index.md)
