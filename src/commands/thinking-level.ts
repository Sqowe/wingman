/**
 * thinking-level — Sqowe Wingman: Set / Cycle Thinking Level commands.
 * setThinkingLevel shows a quick-pick and calls set_thinking_level;
 * cycleThinkingLevel calls cycle_thinking_level to advance to the next level.
 *
 * The level list is NOT hardcoded. pi's canonical set is
 * off | minimal | low | medium | high | xhigh | max, but which of them a given
 * model honours is model-specific: pi's `get_available_thinking_levels` filters
 * by the model's `reasoning` flag and its `thinkingLevelMap` (a `null` entry
 * means "explicitly unsupported"; `xhigh` / `max` appear only when the map has
 * a key for them), and returns just `["off"]` for a model with no reasoning.
 * The picker therefore asks pi, at pick time, so the list follows the currently
 * selected model and re-reads after a model switch. FALLBACK_LEVELS covers the
 * case where that command is unavailable (older pi, transport error).
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

/** A pickable thinking level; `level` is the exact token sent to pi. */
interface LevelPick extends vscode.QuickPickItem {
  level: string;
}

/** Where a level list came from, so the picker can say so. */
export type LevelSource = 'model' | 'fallback';

/** A level list plus the model it describes, when pi could supply one. */
export interface LevelListing {
  levels: string[];
  /** 'model' when pi named the levels; 'fallback' when we had to guess. */
  source: LevelSource;
  /** Display name of the model the list describes, when known. */
  modelLabel?: string;
}

/**
 * pi's full level set, in pi's own order (pi's THINKING_LEVEL_OPTIONS /
 * EXTENDED_THINKING_LEVELS). Used only when `get_available_thinking_levels`
 * cannot be answered — a deliberate superset, since pi clamps a level the model
 * does not support down to the nearest one it does.
 */
export const FALLBACK_LEVELS: readonly string[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

/**
 * Human-readable blurbs for the known levels. A level pi reports that is not
 * here (a future pi release adding one) still gets a pick — just without a
 * description — so a new level is never silently hidden from the user.
 */
const LEVEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  off: 'No extended thinking',
  minimal: 'Minimal thinking budget',
  low: 'Small thinking budget',
  medium: 'Moderate thinking budget',
  high: 'Large thinking budget',
  xhigh: 'Very large thinking budget',
  max: 'Maximum thinking budget',
};

/**
 * Normalize pi's `get_available_thinking_levels` payload into a level list.
 * As with `normalizeModels`, the exact shape is not contractually fixed across
 * pi versions, so accept the common variants defensively: `{ levels: [...] }`,
 * `{ data: [...] }`, a bare array, and arrays of strings. Non-strings and
 * duplicates are dropped; pi's order is preserved (it is meaningful — the list
 * is the cycle order `cycle_thinking_level` walks).
 */
export function normalizeLevels(raw: unknown): string[] {
  const arr: unknown[] =
    Array.isArray(raw) ? raw :
    Array.isArray((raw as Record<string, unknown> | null)?.['levels']) ? (raw as Record<string, unknown>)['levels'] as unknown[] :
    Array.isArray((raw as Record<string, unknown> | null)?.['data']) ? (raw as Record<string, unknown>)['data'] as unknown[] :
    [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    const level = entry.trim();
    if (level === '' || seen.has(level)) continue;
    seen.add(level);
    out.push(level);
  }
  return out;
}

/**
 * Ask pi which levels the current model supports.
 *
 * When pi answers, the list is authoritative and `source` is 'model' — the
 * levels are exactly what this model honours. When it cannot be answered
 * (older pi without the command, transport error, an unrecognized payload) we
 * fall back to pi's full canonical set, which is a superset: pi clamps a level
 * the model does not support down to the nearest one it does. A slightly-too-
 * large list beats an empty picker, but it is NOT model-specific, so the
 * caller says so in the menu rather than passing it off as the real thing.
 */
async function fetchLevels(controller: AgentController): Promise<LevelListing> {
  const modelLabel = describeCurrentModel(controller);
  const fallback = (): LevelListing =>
    ({ levels: [...FALLBACK_LEVELS], source: 'fallback', modelLabel });
  try {
    const response = await controller.sendCommand({ type: 'get_available_thinking_levels' });
    if (!response.success) return fallback();
    const levels = normalizeLevels(response.data);
    return levels.length > 0
      ? { levels, source: 'model', modelLabel }
      : fallback();
  } catch {
    return fallback();
  }
}

/** Name the model the level list belongs to, for the picker chrome. */
function describeCurrentModel(controller: AgentController): string | undefined {
  const state = controller.lastModelState;
  if (!state) return undefined;
  const id = state.modelId ?? undefined;
  if (!id) return undefined;
  return state.modelName ? `${state.modelName} (${id})` : id;
}

/**
 * Build the picker's items. A 'model'-sourced list is the levels and nothing
 * else. A 'fallback' list gets a trailing, non-selectable separator and note
 * so the user can see at a glance that these are pi's full set rather than
 * the levels their model actually reports — otherwise a fallback is
 * indistinguishable from a real answer, which is exactly how a wrong list
 * reads as a right one.
 */
export function buildLevelItems(
  levels: readonly string[],
  source: LevelSource = 'model',
  modelLabel?: string,
): vscode.QuickPickItem[] {
  const items: vscode.QuickPickItem[] = levels.map((level) => ({
    label: level,
    description: LEVEL_DESCRIPTIONS[level],
    level,
  })) as vscode.QuickPickItem[];

  if (source === 'fallback') {
    items.push(
      {
        kind: vscode.QuickPickItemKind.Separator,
        label: 'Not specific to your model',
      } as vscode.QuickPickItem,
      {
        label: `pi could not report which levels ${modelLabel ?? 'this model'} supports`,
        description: `showing pi's full set instead — unsupported levels are clamped`,
      } as vscode.QuickPickItem,
    );
  }
  return items;
}

export async function setThinkingLevel(controller: AgentController): Promise<void> {
  // Fetched here, not cached at module load, so the list always describes the
  // model that is selected when the user opens the picker.
  const { levels, source, modelLabel } = await fetchLevels(controller);

  const items = buildLevelItems(levels, source, modelLabel);
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sqowe Wingman: Set Thinking Level',
    placeHolder: modelLabel
      ? `Extended-thinking levels for ${modelLabel} — this session only`
      : 'Choose an extended-thinking level for this session',
  });
  // A separator (or the fallback note) carries no `level`; picking one is a
  // no-op rather than a send of `undefined`.
  if (!picked || !('level' in picked)) return;
  const level = (picked as LevelPick).level;
  if (!level) return;

  try {
    const response = await controller.sendCommand({
      type: 'set_thinking_level',
      level,
    });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not set thinking level — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    // Remember the level so a later new_session restores it — pi's RPC has no
    // way to persist a selection (see agent/model-memory.ts).
    controller.rememberThinkingLevel(level);
    void vscode.window.showInformationMessage(
      `Sqowe Wingman: thinking level set to "${level}".`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: could not set thinking level — ${String(err)}`,
    );
  }
}

/** Read the new thinking level from a cycle_thinking_level response (tolerant of shape). */
function readCurrentLevel(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const o = data as Record<string, unknown>;
  for (const key of ['level', 'thinkingLevel', 'thinking_level', 'current', 'currentLevel']) {
    if (typeof o[key] === 'string' && o[key]) return o[key] as string;
  }
  return undefined;
}

export async function cycleThinkingLevel(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'cycle_thinking_level' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not cycle thinking level — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    const level = readCurrentLevel(response.data);
    // A cycle is an explicit user choice — remember it like a pick, so the
    // next new_session lands back on the level the user cycled to.
    if (level) controller.rememberThinkingLevel(level);
    void vscode.window.showInformationMessage(
      level
        ? `Sqowe Wingman: thinking level set to "${level}".`
        : 'Sqowe Wingman: thinking level cycled.',
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Sqowe Wingman: could not cycle thinking level — ${String(err)}`,
    );
  }
}
