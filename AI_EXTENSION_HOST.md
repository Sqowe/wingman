# AI rules — Extension Host (Node / TypeScript)

Scope: `src/**` — the VS Code extension host process. This is a Node.js process (the same role
Electron's main process plays in Sqowe Pilot). See [ARCHITECTURE.md](ARCHITECTURE.md) for where it
sits; this file is the coding contract. RPC protocol rules live in [AI_PI_RPC.md](AI_PI_RPC.md).

## Language & build

- TypeScript with `strict` on. No implicit `any`; put explicit return types on exported functions.
- Bundle with **esbuild** (`esbuild.mjs`): `platform: "node"`, `format: "cjs"`,
  `external: ["vscode"]`. Never bundle the `vscode` module — the host provides it at runtime.
- Don't use Node/VS Code APIs newer than the supported range without bumping `engines.vscode` in
  `package.json` first.

## VS Code API

- Push every disposable (commands, providers, listeners, watchers, status-bar items) to
  `context.subscriptions` so it is cleaned up in `deactivate`.
- Declare contributions in `package.json` `contributes.*`; runtime ids (commands, views, view
  containers, settings keys) must match the manifest exactly.
- Never block the host event loop. All agent and I/O work is async; heavy work lives in the pi
  child process, not the host.
- Read settings from the `sqoweWingman.*` namespace via `workspace.getConfiguration`.

## Transport boundary

- All agent access goes through the `AgentTransport` interface (`src/agent/transport.ts`). The RPC
  sidecar (`rpc-transport.ts`) is the only implementation for v1; an in-process SDK adapter may be
  added later. UI and command code depend on the **interface**, never on the concrete transport.
- Spawn pi with `cwd` = the active workspace folder and **no** `--agent-dir` / `--session-dir`
  overrides (config is shared with the pi CLI by default).
- pi is **not bundled** — the user must have it installed. Resolve the executable via
  `pi-locator`: `sqoweWingman.piExecutablePath` → `pi` on `PATH` (also probe common npm-global /
  Homebrew bin dirs, because GUI-launched VS Code may not inherit the login-shell `PATH`). Run a
  `pi --version` check and **warn without blocking** when below the declared minimum; show a clear
  install prompt when nothing resolves. One pi process per active workspace folder.

### Model / thinking state across sessions

- pi's RPC **cannot persist a model or thinking selection.** `set_model` and `set_thinking_level`
  carry no `persist` field, and pi's handler calls `session.setModel(model)` with no options — so
  the `persist: true` write to `defaultModel` / `defaultThinkingLevel` that pi's own TUI performs
  is unreachable over RPC. Never assume `get_state` reflects a choice pi will re-apply later.
- `new_session` tears the runtime down and rebuilds it, re-resolving the model and thinking level
  from CLI flags and then pi's global `settings.json`. `switch_session`, `fork` and `clone` are
  **not** affected — pi restores those from the transcript
  (`getSessionContextSettings` replays `model_change` / `thinking_level_change`). So
  `restoreModelChoice()` is called from `new_session` **only**; calling it after the others would
  discard the real session's own recorded choice.
- The memory itself lives in `src/agent/model-memory.ts` (pure, no `vscode` import) and is stored
  in `context.workspaceState` under `sqoweWingman.modelMemory` — per workspace, not global, since
  pi already runs one process per workspace folder. It is written from the commands where the user
  makes an explicit choice (Set Model, Cycle Model, Set / Cycle Thinking Level) and seeded once
  from the first `get_state`, so it is only ever seeded when empty and is never overwritten by a
  session switch or by the default a new session resolves to.
- Sequence new_session + the re-apply inside `runSuppressingModelRefresh()`. `new_session` is in
  `MODEL_AFFECTING_COMMANDS`, so an unguarded send fires a `get_state` that pushes pi's default
  into the status bar and webview, only for the restore to overwrite it a moment later. The restore
  issues a single `get_state` at the end.
- **`restoreModelChoice()` must re-apply unconditionally — never skip on "already matches".**
  Because the refresh is suppressed, `_lastModelState` inside the restore is still the *previous*
  session's value, so a skip-if-matches check short-circuits in precisely the common case (the user
  is on their remembered model, presses New Session, the cache looks like a match) and the trailing
  `get_state` then publishes pi's default. The whole feature silently no-ops. Same trap for any
  future "compare against the cache" optimization here: the cache is stale by construction inside
  this window.
- A rejected re-apply is **non-fatal**: pi has already created the session, so `newSession()`
  warns and still calls `onNewSession({ clearTranscript: true })` rather than reporting a
  "new session failed" that never happened and leaving a stale transcript behind. The memory is
  deliberately *not* cleared on rejection — a transient failure should not cost the user their
  choice, and the warning says why it did not stick.
- The suppress window must be **balanced by exactly one `get_state`**, so
  `restoreModelChoice()` refreshes even when the memory is empty or a re-apply throws (the
  refresh sits in a `finally`). Returning early instead leaves `onModelState` publishing the
  *previous* session's model — which also drives the webview's `supportsImages` gate — because
  the suppressed refresh was never replaced.
- `_commitMemory` **serializes** its writes through `_memoryWrite`. `cycleModel` records the
  model and the level with two back-to-back commits, and two unawaited `update()` calls on one key
  can land out of order, leaving the model-only snapshot on disk and restoring a stale level
  after a reload.
- `runSuppressingModelRefresh()` uses a **depth counter**, never a save/restore boolean. VS Code
  command handlers overlap (a command that awaits, e.g. New Session), so two *non-nested* windows
  make a boolean latch: the first to finish restores the `false` it read on entry, the second
  restores the `true` it read, and suppression is stuck on — after which **no**
  `MODEL_AFFECTING` command refreshes the model state again and the status bar goes stale for the
  rest of the session.
- `_refreshModelState` is already superseded-guarded: it takes `++this._modelStateSeq` on entry
  and bails on `seq !== this._modelStateSeq` *before* touching `_lastModelState` or firing
  `_onModelState`. A late `get_state` therefore cannot undo a newer restore. Don't add a second
  nonce; there isn't a missing one.

## Bundled pi extensions

- Each bundled pi extension lives in its own folder at the repo root: `pi-extensions/<name>/`
  (sibling to `src/`, `webview-ui/`, `media/` — not nested under any of them). One extension per
  folder.
- Every extension folder has its own `README.md` — what it does, the command/status-key names it
  uses, and why it exists.
- Plain JavaScript, not TypeScript — no build step; `esbuild.mjs` never touches `pi-extensions/`.
  `.vscodeignore` does not exclude the folder, so it ships in the VSIX unchanged.
- Always loaded via `-e <path>` when spawning `pi --mode rpc`, alongside the existing trust/session
  args — never rely on the user installing it separately. Resolve the runtime path with
  `context.asAbsolutePath('pi-extensions/<name>/index.js')` and thread it into the transport args.

## Diff service

- On `tool_execution_end` for the `edit` tool, drive VS Code's native diff from
  `result.details.patch` (a unified diff). Preview via a `TextDocumentContentProvider` + virtual
  URIs + `vscode.diff`. pi's `edit` tool has **already written the file to disk**, so the patch is
  a record (`baseContent → newContent`), not pending work: the on-disk file is the "after", and
  the "before" is reconstructed by inverting the patch (`invertPatch`). There is no apply step.
- Don't re-implement diff rendering in the host — VS Code owns it.

## Security & robustness

- Honor pi's **project-trust** gate before loading project `.pi/` resources.
- No secrets in logs or the bundle. Auth lives in pi's `~/.pi/agent/auth.json`, owned by pi.
- When pi is missing or the wrong version, fail with a clear, actionable onboarding message —
  never a silent crash.
