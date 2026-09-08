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
| `sqoweWingman.showViewDiffButton` | `true` | Show the **View Diff** button on completed `edit` tool cards. The diff editor is a read-only before↔after preview — pi has already written the change to disk, so there is no separate Apply step. Changing this updates the running chat immediately. |
| `sqoweWingman.shareClaudeMemory` | `true` | Share Claude Code's project memory (read-only) with the pi agent. When on, Wingman injects the facts Claude Code recorded for the project into pi's system prompt and lists them in the status banner. Only has an effect when a Claude Code memory folder exists for the project. Toggling reloads the agent to apply. See [Claude Code memory sharing](../features/claude-memory.md). |
| `sqoweWingman.maxStdoutBufferMb` | `64` | Maximum size, in MB, of the buffer that holds a single line of pi's RPC output while Wingman waits for its terminating newline. A whole turn is delivered as one line whose size grows with the conversation (several MB at a 1M-token context, larger with pasted images). If a line exceeds this cap, the pi process is terminated to bound memory use, so raise it for very large sessions (allowed range 16–1024). Takes effect when the agent next starts — reload the agent to apply. |
| `sqoweWingman.dialogStyle` | `auto` | Where a question from an agent extension appears. `auto` shows it as a card in the chat when its options are too long for a quick-pick row — they wrap in full there, previews render as code blocks, and multiple choice gets checkboxes — and keeps short prompts (allow / deny) on the faster native quick-pick. `quickPick` always uses the native widget; `chat` always uses the card. Applies to the next question asked. See [Questions and dialogs](../features/dialogs.md). |

---
[← All docs](../index.md)
