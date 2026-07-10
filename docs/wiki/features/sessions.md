<!-- sources: README.md, src/sessions/, docs/design/session-titles.md, docs/chats/implementing-phase-7-session-management-in-vs-code-extension-2026-06-23.md, docs/chats/session-list-scope-and-workspace-filtering-design-2026-06-23.md, contributes.commands[newSession,switchSession,refreshSessions,renameSession] -->

# Sessions

## What it is / when to use it

Every conversation with the agent is a pi session. The Sessions view — a tree in the Wingman
activity-bar container — lists the pi sessions for your current workspace, so you can pick up
where you left off. Because Wingman shares pi's session storage, sessions you started in the
pi CLI show up here too (and vice versa).

Switching to a session restores its full transcript, not just a summary. Sessions are scoped
to the open workspace folder, so the list stays relevant to what you're working on.

By default a session's title comes from its first user message, which is far easier to scan
than a raw `timestamp_uuid` filename. If a title isn't right, you can rename any session to
your own text.

## How to use it

1. Open the Sqowe Wingman activity-bar container and find the Sessions view.
2. Click a session to switch to it — its transcript loads into the Chat view.
3. Start a fresh conversation with New Session (Cmd+Alt+N / Ctrl+Alt+N when Chat is focused,
   or the toolbar button).
4. To rename, right-click a session → Rename Session… and type a new title.
5. Use the Refresh button in the Sessions view title if the list looks stale.

For duplicating or branching a conversation, see Fork Session and Clone Session in
[Commands](commands.md).

![Sessions List](../assets/seesions-list.png)

## Commands & settings

| Command | How to run |
| --- | --- |
| New Session | Command Palette → Sqowe Wingman: New Session (`Cmd+Alt+N` / `Ctrl+Alt+N` when Chat is focused), or the Chat toolbar |
| Switch Session | Command Palette → Switch Session, or click a session / its inline action in the Sessions tree |
| Rename Session… | Right-click a session in the Sessions tree → Rename Session… |
| Refresh Sessions | Sessions view title → Refresh |

---
[← All docs](../index.md)
