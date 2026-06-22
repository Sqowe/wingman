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
- Resolve the pi executable via `pi-locator`: global install → bundled pinned version →
  `sqoweWingman.piExecutablePath`. One pi process per active workspace folder.

## Diff service

- On `tool_execution_end` for the `edit` tool, drive VS Code's native diff from
  `result.details.patch` (a unified diff). Preview via a `TextDocumentContentProvider` + virtual
  URIs + `vscode.diff`; apply via `WorkspaceEdit` + `workspace.applyEdit`.
- Don't re-implement diff rendering in the host — VS Code owns it.

## Security & robustness

- Honor pi's **project-trust** gate before loading project `.pi/` resources.
- No secrets in logs or the bundle. Auth lives in pi's `~/.pi/agent/auth.json`, owned by pi.
- When pi is missing or the wrong version, fail with a clear, actionable onboarding message —
  never a silent crash.
