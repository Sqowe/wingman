# AI rules — pi RPC contract

Scope: the JSONL protocol spoken to `pi --mode rpc` (`src/agent/rpc-transport.ts`). The canonical
reference is pi's own `docs/rpc.md` (ships inside the `@earendil-works/pi-coding-agent` npm
package). These rules capture the gotchas; consult `rpc.md` for the full command/event catalog.

## Framing (get this exactly right)

- pi's RPC is strict **JSONL with LF (`\n`) as the only delimiter**. Split stdout on `\n` only and
  strip a trailing `\r`.
- **Do NOT use Node `readline`** — it also splits on `U+2028` / `U+2029`, which are valid inside
  JSON strings and will corrupt frames. Use a custom LF reader.
- Buffer partial chunks across `data` events: one read may contain zero, one, or many lines, and a
  single line may span chunks.

## Commands vs events

- Outbound commands carry an optional `id`; correlate each response to its command by that `id`.
- Inbound messages **without** an `id` are the render event stream — `message_update`,
  `tool_execution_*`, `turn_*`, `agent_*`, `queue_update`, `compaction_*`, `auto_retry_*`. Forward
  them to the webview; never block on them.

## Built-in commands are inert over RPC

- pi's interactive TUI commands (`/settings`, `/model`, `/new`, …) do **not** execute over RPC.
  Reimplement their behavior with the RPC/SDK equivalents wired to native VS Code UI: `set_model` /
  `cycle_model` / `get_available_models`, `compact`, `new_session`, `switch_session`, `fork` /
  `clone`, `export_html`, `set_thinking_level` / `cycle_thinking_level`, `get_session_stats`.
- User slash commands (skills, prompt templates, extension commands) are enumerated via
  `get_commands` and invoked by sending `/name` through `prompt`. These ARE duplicated 1:1.

## Extension UI sub-protocol

- Blocking `extension_ui_request` (`select` / `confirm` / `input` / `editor`) must be answered with
  a matching `extension_ui_response`. Map them to `showQuickPick` / `showInputBox` /
  `showWarningMessage`. Never leave a blocking request unanswered.
- Fire-and-forget `notify` / `setStatus` / `setWidget` / `setTitle` map to notifications, the
  status bar, and webview banners.

## Lifecycle

- One pi process per active workspace folder; tear it down on `deactivate` / folder switch.
- Pin a tested pi version. Treat the **RPC protocol** as the stable contract — not pi's TypeScript
  SDK surface, which is pre-1.0 and churns.
