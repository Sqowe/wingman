<!-- sources: README.md, CHANGELOG.md#0.1.8, docs/design/context-window-indicator.md, src/status-bar.ts, src/commands/show-stats.ts, contributes.commands[showStats] -->

# Session stats & context window

## What it is / when to use it

A long conversation slowly fills the model's context window, and once it's full the agent
has to compact or you lose room to work. Wingman keeps an always-visible status bar item so
you can see how much of the window you've used at a glance, without opening anything.

The status bar shows your context usage as `tokens used / window · percent · message count`
— for example `12.4k tok / 200k tok · 6% · 85 msg`. The denominator updates as soon as you
switch models, so it always reflects the active model's window. Right after pi compacts a
session there's a brief moment where the token count isn't known yet; during that window it
shows a `— / window · — · messages` placeholder so you still see the model's window size.

Hover the item for a two-line tooltip, or click it to open the Show Session Stats popup with
the fuller breakdown.

## How to use it

1. Look at the Wingman status bar item while you chat — it updates as the conversation grows.
2. Hover for the tooltip (`Context: … · Messages: N`).
3. Click the item, or run Show Session Stats, to open the stats popup.

If usage is getting high, use Compact Session (see [Commands](commands.md)) to shrink the
context.

![Session Stats](../assets/session-stats.png)

## Commands & settings

| Command | How to run |
| --- | --- |
| Show Session Stats | Command Palette → Sqowe Wingman: Show Session Stats, or click the status bar item |

---
[← All docs](../index.md)
