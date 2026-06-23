/**
 * model-picker — Sqowe Wingman: Set Model / Cycle Model commands.
 *
 * pickModel: shows the user's curated model shortlist (settings.json
 * `enabledModels`, the same set the CLI's cycle_model rotates through),
 * enriched with display names from get_available_models, then calls set_model
 * with the chosen model. Falls back to the full get_available_models catalog
 * only when no shortlist is configured.
 * cycleModel: calls cycle_model to advance to the next configured model.
 *
 * Why a shortlist: pi's get_available_models returns *every* model reachable
 * through configured providers — an aggregator like OpenRouter alone yields
 * hundreds — which is unusable as a switcher. `enabledModels` is the user's
 * picked subset. pi's RPC has no command to read it, so we read the shared
 * ~/.pi/agent/settings.json directly (consistent with the "shared config with
 * the CLI" design).
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AgentController } from '../agent/controller';

interface ModelOption {
  id: string;
  name?: string;
  provider?: string;
}

/** A pickable model resolved to the `{ provider, modelId }` pair set_model needs. */
interface ModelPick extends vscode.QuickPickItem {
  provider: string;
  modelId: string;
}

/**
 * Normalize pi's get_available_models payload into ModelOption[]. The exact
 * shape is not contractually fixed across pi versions, so accept the common
 * variants defensively: `{ models: [...] }`, `{ data: [...] }`, a bare array,
 * arrays of strings, and objects keyed by `id` / `model` / `name` / `label`.
 * The `provider` field is captured when present (pi's Model object carries it)
 * so set_model can be called with the contractual `{ provider, modelId }`.
 */
export function normalizeModels(raw: unknown): ModelOption[] {
  const arr: unknown[] =
    Array.isArray(raw) ? raw :
    Array.isArray((raw as Record<string, unknown> | null)?.['models']) ? (raw as Record<string, unknown>)['models'] as unknown[] :
    Array.isArray((raw as Record<string, unknown> | null)?.['data']) ? (raw as Record<string, unknown>)['data'] as unknown[] :
    [];

  const out: ModelOption[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      if (entry) out.push({ id: entry });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const id =
        typeof o['id'] === 'string' ? o['id'] :
        typeof o['model'] === 'string' ? o['model'] :
        typeof o['name'] === 'string' ? o['name'] :
        undefined;
      if (!id) continue;
      const name =
        typeof o['name'] === 'string' && o['name'] !== id ? o['name'] :
        typeof o['label'] === 'string' ? o['label'] :
        undefined;
      const provider = typeof o['provider'] === 'string' ? o['provider'] : undefined;
      out.push({ id, name, provider });
    }
  }
  return out;
}

/**
 * Read the `enabledModels` array from a parsed settings.json object. Entries
 * are `provider/modelId` reference strings (e.g. `openrouter/deepseek/deepseek-v4-pro`).
 * Tolerates a missing/malformed setting by returning an empty list.
 */
export function parseEnabledModels(settings: unknown): string[] {
  const arr = (settings as Record<string, unknown> | null)?.['enabledModels'];
  if (!Array.isArray(arr)) return [];
  return arr.filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/**
 * Split a `provider/modelId` reference on its first slash. The model id itself
 * may contain slashes (`openrouter/deepseek/deepseek-v4-pro` → provider
 * `openrouter`, modelId `deepseek/deepseek-v4-pro`). A ref with no slash yields
 * an empty provider.
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf('/');
  if (i < 0) return { provider: '', modelId: ref };
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Build picker items for the curated shortlist, enriching each ref with the
 * display name from the catalog when a matching model is found. A ref absent
 * from the catalog still appears (labelled by its ref) so nothing silently
 * drops.
 */
export function buildShortlistItems(enabled: string[], catalog: ModelOption[]): ModelPick[] {
  return enabled.map((ref) => {
    const { provider, modelId } = splitModelRef(ref);
    const match = catalog.find((m) => `${m.provider ?? ''}/${m.id}` === ref || m.id === ref);
    const name = match?.name;
    return {
      label: name ?? ref,
      description: name ? ref : undefined,
      provider,
      modelId,
    };
  });
}

/** Build picker items for the full catalog (fallback when no shortlist exists). */
export function buildCatalogItems(catalog: ModelOption[]): ModelPick[] {
  return catalog.map((m) => {
    const provider = m.provider ?? splitModelRef(m.id).provider;
    const modelId = m.provider ? m.id : splitModelRef(m.id).modelId;
    return {
      label: m.name ?? m.id,
      description: m.name ? m.id : undefined,
      provider,
      modelId,
    };
  });
}

/** Read the user's curated model shortlist from the shared pi settings.json. */
async function readEnabledModels(): Promise<string[]> {
  try {
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
    const text = await fs.readFile(settingsPath, 'utf-8');
    return parseEnabledModels(JSON.parse(text));
  } catch {
    return []; // missing / unreadable / malformed → fall back to the full list
  }
}

export async function pickModel(controller: AgentController): Promise<void> {
  const enabled = await readEnabledModels();

  // Fetch the catalog for display names, and as the fallback source when no
  // shortlist is configured. Tolerate failure when we have a shortlist to show.
  let catalog: ModelOption[] = [];
  let catalogError: string | undefined;
  try {
    const response = await controller.sendCommand({ type: 'get_available_models' });
    if (response.success) {
      catalog = normalizeModels(response.data);
    } else {
      catalogError = response.error ?? 'unknown error';
    }
  } catch (err) {
    catalogError = String(err);
  }

  let items: ModelPick[];
  if (enabled.length > 0) {
    items = buildShortlistItems(enabled, catalog);
  } else if (catalog.length > 0) {
    items = buildCatalogItems(catalog);
  } else {
    void vscode.window.showErrorMessage(
      catalogError
        ? `Sqowe Wingman: could not fetch models — ${catalogError}`
        : 'Sqowe Wingman: no models available.',
    );
    return;
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage('Sqowe Wingman: no models available.');
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sqowe Wingman: Set Model',
    placeHolder: 'Choose a model for this session',
  });

  if (!picked) return;

  // pi's contract is { provider, modelId } (not a single combined field).
  const { provider, modelId } = picked;

  try {
    const response = await controller.sendCommand({ type: 'set_model', provider, modelId });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not set model — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    const label = provider ? `${provider}/${modelId}` : modelId;
    void vscode.window.showInformationMessage(`Sqowe Wingman: model set to ${label}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: could not set model — ${String(err)}`);
  }
}

/** Read a model identifier from a cycle_model response payload (tolerant of shape). */
function readCurrentModel(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const o = data as Record<string, unknown>;
  for (const key of ['model', 'id', 'name', 'current', 'currentModel', 'current_model']) {
    if (typeof o[key] === 'string' && o[key]) return o[key] as string;
  }
  return undefined;
}

export async function cycleModel(controller: AgentController): Promise<void> {
  try {
    const response = await controller.sendCommand({ type: 'cycle_model' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not cycle model — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    const model = readCurrentModel(response.data);
    void vscode.window.showInformationMessage(
      model ? `Sqowe Wingman: model switched to ${model}.` : 'Sqowe Wingman: model cycled.',
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: could not cycle model — ${String(err)}`);
  }
}
