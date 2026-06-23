# Wingman scratch workspace

This folder is opened automatically by the **Run Extension** debug target
(see [`.vscode/launch.json`](../.vscode/launch.json)) so the pi agent has a
working directory in the Extension Development Host — pi needs an open
workspace folder before it can spawn.

It is intentionally separate from the extension's own source so that test
prompts and `edit` → **Apply** actions don't touch Wingman's code. Everything
in this folder *except this README* is gitignored, so feel free to let the
agent create and edit files here.

## Try it

1. Press **F5** (or *Run ▸ Run Extension*); a dev-host window opens on this folder.
2. Open the Wingman view from the activity bar.
3. Ask it to create or edit a file here, e.g. *"create hello.ts that prints the
   current time"*.
4. On the resulting `edit` tool card, click **View Diff** (opens the native diff
   editor) and **Apply** (writes the change; it shows as an unsaved edit / in
   Source Control once saved).
