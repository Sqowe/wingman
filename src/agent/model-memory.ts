/**
 * model-memory — per-workspace memory of the user's model + thinking choice.
 *
 * ## Why this exists
 *
 * pi rebuilds the whole agent runtime on `new_session` (see
 * `AgentSessionRuntime.newSession` → `createRuntime` in pi's `main.js`), and that
 * re-resolves the model and thinking level from scratch: CLI flags first, then
 * `defaultProvider` / `defaultModel` from pi's global `settings.json`. It does
 * NOT carry over the live session's selection.
 *
 * pi *can* persist a selection — `setModel` / `setThinkingLevel` take a
 * `persist: true` option and then write `defaultModel` / `defaultThinkingLevel`
 * to global settings — but the RPC surface does not expose it: `set_model` and
 * `set_thinking_level` carry no `persist` field, and pi's RPC handler calls
 * `session.setModel(model)` with no options. So a Wingman-side memory plus an
 * explicit re-apply after `new_session` is the only route available.
 *
 * Deliberately scoped to `context.workspaceState`, not global state: the user
 * expects each workspace to keep its own pair, and pi already runs one process
 * per workspace folder.
 *
 * This module is pure and free of `import 'vscode'` so it is unit-testable
 * without the VS Code module mock. `MementoLike` is structurally satisfied by
 * `vscode.Memento` (`context.workspaceState`).
 */

/** Storage key for the remembered pair in `context.workspaceState`. */
export const MODEL_MEMORY_KEY = 'sqoweWingman.modelMemory';

/**
 * The subset of `vscode.Memento` this module needs. Declared structurally so
 * the real `vscode.Memento` satisfies it without an import.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * A remembered model + thinking choice. Both halves are optional because the
 * two are recorded independently: the model picker writes `provider`/`modelId`,
 * the thinking commands write `thinkingLevel`, and `rememberModelChoice`
 * backfills the level from the live session so the pair is usually complete.
 */
export interface ModelMemory {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/**
 * Coerce an arbitrary stored value into a `ModelMemory`, dropping anything that
 * is not a non-empty string. Returns `undefined` when no usable field survives,
 * so a hand-edited or corrupted memento degrades to "nothing remembered"
 * instead of sending garbage to pi.
 */
export function normalizeModelMemory(raw: unknown): ModelMemory | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  // Trim rather than only testing the trimmed value: a padded id must not be
  // persisted and then handed to set_model / set_thinking_level verbatim.
  const str = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const memory: ModelMemory = {};
  const provider = str(o['provider']);
  const modelId = str(o['modelId']);
  const thinkingLevel = str(o['thinkingLevel']);
  if (provider) memory.provider = provider;
  if (modelId) memory.modelId = modelId;
  if (thinkingLevel) memory.thinkingLevel = thinkingLevel;
  return Object.keys(memory).length > 0 ? memory : undefined;
}

/** True when the memory carries enough of a model to send `set_model`. */
export function hasModelRef(memory: ModelMemory | undefined): memory is ModelMemory & {
  provider: string;
  modelId: string;
} {
  return !!memory?.provider && !!memory?.modelId;
}

/**
 * Overlay `patch` onto `prev`, ignoring empty/undefined fields so a partial
 * write (e.g. only a thinking level) never erases the model half. Returns
 * `undefined` when the merge would be empty.
 */
export function mergeModelMemory(
  prev: ModelMemory | undefined,
  patch: ModelMemory,
): ModelMemory | undefined {
  const merged: ModelMemory = { ...(prev ?? {}) };
  if (patch.provider) merged.provider = patch.provider;
  if (patch.modelId) merged.modelId = patch.modelId;
  if (patch.thinkingLevel) merged.thinkingLevel = patch.thinkingLevel;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Read + normalize the remembered pair. Returns undefined when unset/invalid. */
export function readModelMemory(memento: MementoLike | undefined): ModelMemory | undefined {
  if (!memento) return undefined;
  try {
    return normalizeModelMemory(memento.get<unknown>(MODEL_MEMORY_KEY));
  } catch {
    // A throwing memento must not break session creation.
    return undefined;
  }
}

/** Persist a merged memory. Fire-and-forget: a storage failure is not fatal. */
export async function writeModelMemory(
  memento: MementoLike | undefined,
  memory: ModelMemory | undefined,
): Promise<void> {
  if (!memento) return;
  try {
    await memento.update(MODEL_MEMORY_KEY, memory);
  } catch {
    // Best-effort — losing the memory only costs a re-pick next time.
  }
}
