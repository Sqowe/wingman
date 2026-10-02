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
  /**
   * The level pi actually has right now. This is the only value that answers
   * "what am I on?" — the row the quick pick highlights is just the keyboard
   * cursor's starting position and says nothing about the current level.
   */
  currentLevel?: string;
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
  // Two independent asks, in parallel, each allowed to fail alone: a failed
  // get_state must not cost us the level list, and a failed level list must
  // not cost us the current level.
  const [levelsResponse, currentLevel] = await Promise.all([
    controller.sendCommand({ type: 'get_available_thinking_levels' }).catch(() => undefined),
    fetchCurrentLevel(controller),
  ]);
  const levels = levelsResponse?.success ? normalizeLevels(levelsResponse.data) : [];
  return levels.length > 0
    ? { levels, source: 'model', modelLabel, currentLevel }
    : { levels: [...FALLBACK_LEVELS], source: 'fallback', modelLabel, currentLevel };
}

/**
 * The level pi actually has right now, or undefined if it could not be asked.
 * Authoritative, in a way the picker's own highlight is not: `showQuickPick`
 * offers no way to set the active row for a single-select list (`picked` is
 * honored only with `canPickMany`), so the menu cannot be made to show this
 * without being told.
 */
async function fetchCurrentLevel(controller: AgentController): Promise<string | undefined> {
  try {
    const response = await controller.sendCommand({ type: 'get_state' });
    if (!response.success) return undefined;
    const level = (response.data as Record<string, unknown> | null)?.['thinkingLevel'];
    return typeof level === 'string' && level ? level : undefined;
  } catch {
    return undefined;
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
 * The picker's input line. Leads with the current level because that is the
 * fact the user is opening the menu to check, and names the model the levels
 * belong to so a list is never free-floating.
 *
 * A remembered level the model does not offer is called out rather than passed
 * over: pi clamps it on every model switch, so a level absent from this list
 * is a level the user believes they set and no longer have.
 */
function describeCurrent(
  currentLevel: string | undefined,
  levels: readonly string[],
  modelLabel: string | undefined,
): string {
  const where = modelLabel ? ` for ${modelLabel}` : '';
  if (!currentLevel) {
    return `Could not read the current level. Choose one${where}.`;
  }
  const offered = levels.includes(currentLevel);
  const level = offered ? currentLevel : `${currentLevel} (not offered by this model)`;
  return `Now: ${level}${where} — pick a different level to change it.`;
}

/**
 * Build the picker's items.
 *
 * The level pi actually has is marked with a leading checkmark and "current",
 * because a single-select `showQuickPick` cannot be told which row to start on
 * — the highlighted row is always just the first item. Without this, a menu
 * opened while the level is `high` appears to be offering `low`, and the two
 * disagree with no way to tell which is the fact.
 *
 * A 'model'-sourced list is the levels and nothing more. A 'fallback' list
 * gets a trailing, non-selectable separator and note so the user can see at a
 * glance that these are pi's full set rather than the levels their model
 * actually reports.
 */
export function buildLevelItems(
  levels: readonly string[],
  source: LevelSource = 'model',
  modelLabel?: string,
  currentLevel?: string,
): vscode.QuickPickItem[] {
  const items = levels.map((level) => {
    const isCurrent = level === currentLevel;
    const blurb = LEVEL_DESCRIPTIONS[level];
    return {
      // The checkmark is a prefix, not a replacement: the level token stays
      // contiguous with its label so typing it still filters the list.
      label: isCurrent ? `✓ ${level}` : level,
      description: isCurrent && blurb ? `${blurb} · current` : blurb,
      level,
    };
  }) as vscode.QuickPickItem[];

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
  const { levels, source, modelLabel, currentLevel } = await fetchLevels(controller);

  const items = buildLevelItems(levels, source, modelLabel, currentLevel);
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sqowe Wingman: Set Thinking Level',
    placeHolder: describeCurrent(currentLevel, levels, modelLabel),
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
