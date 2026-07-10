<!-- sources: README.md, docs/design/collapsible-user-messages.md, CHANGELOG.md#0.1.9, webview-ui/src/components (collapsible user messages) -->

# Collapsible long prompts

## What it is / when to use it

When you paste a long message into the chat — a stack trace, a multi-paragraph brief, a long
log — the transcript now collapses it to a bounded height with a soft fade at the bottom,
and a *Show more / Show less* toggle in the corner. The assistant's reply stays in view
instead of being pushed off the fold. Short messages render unchanged.

How long is "long" is measured by how the text actually renders, not by a fixed character
count, so the cutoff feels right at any zoom level or pane width.

This is part of the chat transcript — see [Chat & tool cards](chat.md) for the surrounding
flow.

## How to use it

1. Paste or type a long message into the composer and send it as usual.
2. The message appears in the transcript collapsed to a bounded height with a soft fade.
3. Click **Show more** to expand the full text; click **Show less** to collapse it again.
   The choice is per-message and persists across the session.

![Collapsible long prompt](../assets/collapsible-long-messages.png)
> ⚠️ TODO (human): capture this → docs/wiki/assets/collapsible-long-messages.png

---
[← All docs](../index.md)
