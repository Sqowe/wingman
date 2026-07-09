<!-- sources: README.md, docs/design/image-attachments.md, src/shared/limits.ts, webview-ui/src/components/Composer.tsx, docs/chats/implementing-image-attachments-feature-2026-06-24.md -->

# Attaching images

## What it is / when to use it

When you're working with a model that accepts image input (for example Claude Sonnet or
GPT-4o), you can send images to the agent right from the composer — useful for screenshots,
diagrams, mockups, or error dialogs you'd rather show than describe.

Wingman gates this on the active model's abilities. If the current model doesn't accept
images, the attach button is disabled and pasted or dropped images are ignored with a brief
note naming the model, so you're never left wondering why nothing happened.

## How to use it

There are three ways to attach:

- **＋ button** — opens a file picker for PNG, JPEG, GIF, or WebP.
- **Paste** — paste an image from the clipboard directly into the composer.
- **Drag and drop** — drop image files onto the composer text area.

Attached images appear as thumbnail chips above the input. Click the × on a chip to remove it
before sending. You can send images with no text (image-only prompts).

[Attach Images](../assets/image-attach.png)

## Limits

These are enforced in both the webview and the extension host:

| Limit | Value |
| --- | --- |
| Max size per image | 5 MB decoded |
| Max total image payload per prompt | 20 MB decoded |
| Max images per prompt | 10 |
| Accepted formats | PNG, JPEG, GIF, WebP |
| Max prompt text size | 32 KB (UTF-8) |

---
[← All docs](../index.md)
