/**
 * new-session — Sqowe Wingman: New Session command.
 * Calls pi's `new_session` RPC command to start a fresh conversation, then
 * re-applies the remembered model + thinking level.
 */

import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';

/**
 * How long a successful new session blocks the next one.
 *
 * The shortcut can reach the command from two independent directions — the
 * chat view forwards it to the host, and VS Code's own keybinding fires for
 * the same keystroke — and the two paths are not synchronised with each
 * other. The in-flight guard catches a duplicate that arrives while the
 * first one is still running; the cooldown catches the one that arrives just
 * after it finished. Only a successful session arms the cooldown, so a failed
 * one can be retried straight away.
 */
const NEW_SESSION_COOLDOWN_MS = 500;

/** Guard state, kept per controller so a fresh controller starts clean. */
interface NewSessionState {
  /** A new session is being created right now. */
  inFlight: boolean;
  /** When the last successful new session finished (0 = never). */
  lastCompletedAt: number;
}

const states = new WeakMap<AgentController, NewSessionState>();

function stateFor(controller: AgentController): NewSessionState {
  let state = states.get(controller);
  if (!state) {
    state = { inFlight: false, lastCompletedAt: 0 };
    states.set(controller, state);
  }
  return state;
}

export async function newSession(controller: AgentController): Promise<void> {
  const state = stateFor(controller);

  if (state.inFlight) {
    controller.outputChannel?.appendLine(
      '[Wingman] new session ignored — one is already in flight',
    );
    return;
  }
  if (
    state.lastCompletedAt > 0 &&
    Date.now() - state.lastCompletedAt < NEW_SESSION_COOLDOWN_MS
  ) {
    controller.outputChannel?.appendLine(
      '[Wingman] new session ignored — duplicate within the cooldown',
    );
    return;
  }

  state.inFlight = true;
  try {
    const created = await runNewSession(controller);
    if (created) state.lastCompletedAt = Date.now();
  } finally {
    state.inFlight = false;
  }
}

/**
 * Creates the session. Returns true when pi accepted it — a failed attempt
 * must not arm the cooldown, so the user can retry without waiting.
 */
async function runNewSession(controller: AgentController): Promise<boolean> {
  try {
    // pi's new_session rebuilds the whole runtime and re-resolves the model and
    // thinking level from its global settings, so the live selection is lost —
    // there is no `persist` option on the set_model / set_thinking_level RPC
    // commands, so Wingman has to remember and re-apply it itself. The refresh
    // is suppressed across both sends so the status bar doesn't flash the
    // default in between; restoreModelChoice issues one refresh at the end.
    const response = await controller.runSuppressingModelRefresh(async () => {
      const res = await controller.sendCommand({ type: 'new_session' });
      if (res.success) {
        // pi has already created the session at this point, so a failed re-apply
        // is non-fatal: warn, but still let the caller reset the view below.
        // Swallowing it here also stops a restore failure from being reported
        // as a "new session failed" that never happened.
        try {
          await controller.restoreModelChoice();
        } catch (err) {
          // err.message, not String(err) — the latter prefixes "Error: " and
          // duplicates the detail already in the output channel.
          const detail = err instanceof Error ? err.message : String(err);
          void vscode.window.showWarningMessage(
            `Sqowe Wingman: new session started, but the remembered model and thinking level could not be restored — ${detail}`,
          );
        }
      }
      return res;
    });
    if (!response.success) {
      void vscode.window.showErrorMessage(
        `Sqowe Wingman: new session failed — ${response.error ?? 'unknown error'}`,
      );
      return false;
    }
    // Notify the controller so it can refresh commands / stats and clear the
    // webview transcript (a new session starts empty).
    controller.onNewSession({ clearTranscript: true });
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Sqowe Wingman: new session failed — ${String(err)}`);
    return false;
  }
}
