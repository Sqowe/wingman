/**
 * model-picker — Sqowe Wingman: Set Model / Cycle Model commands.
 *
 * pickModel: fetches available models via get_available_models, shows a
 * quick-pick, then calls set_model with the chosen model id.
 * cycleModel: calls cycle_model to advance to the next configured model.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

interface ModelOption {
  id: string;
  name?: string;
}

/**
 * Normalize pi's get_available_models payload into ModelOption[]. The exact
 * shape is not contractually fixed across pi versions, so accept the common
 * variants defensively: `{ models: [...] }`, `{ data: [...] }`, a bare array,
 * arrays of strings, and objects keyed by `id` / `model` / `name` / `label`.
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
      out.push({ id, name });
    }
  }
  return out;
}

export async function pickModel(controller: AgentController): Promise<void> {
  // Fetch available models from pi.
  let models: ModelOption[];
  try {
    const response = await controller.sendCommand({ type: 'get_available_models' });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not fetch models — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    models = normalizeModels(response.data);
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: could not fetch models — ${String(err)}`);
    return;
  }

  if (models.length === 0) {
    void vscode.window.showInformationMessage('Sqowe Wingman: no models available.');
    return;
  }

  const items: vscode.QuickPickItem[] = models.map((m) => ({
    label: m.name ?? m.id,
    description: m.name ? m.id : undefined,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sqowe Wingman: Set Model',
    placeHolder: 'Choose a model for this session',
  });

  if (!picked) return;

  // Resolve back to the model id (the label when there's no name, else the description).
  const modelId = picked.description ?? picked.label;

  try {
    const response = await controller.sendCommand({ type: 'set_model', model: modelId });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: could not set model — ${response.error ?? 'unknown error'}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(`Sqowe Wingman: model set to ${modelId}.`);
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
