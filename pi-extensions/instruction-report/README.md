# pi-extensions/instruction-report

Bundled pi extension that reports which instruction files pi loaded for the
current session back to Sqowe Wingman, so the status banner can show an
accurate count and annotated list.

## What it does

Registers one internal slash command (`/wingman-instruction-report`) that:

1. Calls `ctx.getSystemPromptOptions()` to read pi's resolved instruction state.
2. Derives each file's path and scope (`global` vs `project`) without ever
   forwarding file content.
3. Reports the result back via `ctx.ui.setStatus('wingman:instructionFiles', JSON)`.

Wingman's `UiProtocolBridge` intercepts the reserved status key before it reaches
the generic status strip, parses the JSON, and posts an `instructionFiles` message
to the webview, which renders it in the `PiStatusBanner` popover.

## Command

| Name | `wingman-instruction-report` |
| --- | --- |
| Visibility | Internal — excluded from the `/` autocomplete in Wingman's composer |
| Invocation | Wingman calls it automatically after each session (re)start |
| Response | None (fire-and-forget from pi's perspective; data arrives via `setStatus`) |

## Reserved status key

`wingman:instructionFiles` — intercepted by `UiProtocolBridge._handleSetStatus`
and never forwarded to the generic UI status strip.

## Why plain JavaScript

No build step is needed for a single-file pi extension. Keeping it plain JS
means the file can be loaded directly by pi via `-e <path>` without any
compilation pipeline in the VSIX build. This is the **standing convention for
all bundled pi extensions** in this repo — each gets its own folder under
`pi-extensions/<name>/` with a `README.md`.

## Fallback behaviour

- **`getSystemPromptOptions()` missing** (old pi): reports `{ unsupported: true }`.
- **Handler throws**: reports `{ error: "<message>" }`.
- Both are treated as `null` by Wingman (shows "No information" in the popover).

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Extension entry point — loaded by pi via `-e <absolute-path>` |
| `README.md` | This file |
