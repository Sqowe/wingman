/**
 * Type declarations for the plain-JS current-date pi extension, so host code
 * (and unit tests) get a typed import surface without adding a build step to
 * pi-extensions/. Mirrors index.js.
 */

export interface CurrentDateInternals {
  /** Built-in template, used when WINGMAN_CURRENT_DATE_TEMPLATE is absent or blank. */
  readonly DEFAULT_TEMPLATE: string;
  /** Read the template from the environment (once per process). */
  resolveTemplate(): string;
  /** Substitute {{date}} / {{weekday}} / {{timeZone}} in a template for "now". */
  renderCurrentDate(template: string): string;
}

/** pi ExtensionAPI surface this module touches (structural, not the real type). */
export interface PiApi {
  on(
    event: 'before_agent_start',
    handler: (event: {
      systemPromptOptions: { sections: Record<string, string> };
    }) => void | Promise<void>,
  ): () => void;
}

export default function currentDate(pi: PiApi): void;
export const _internals: CurrentDateInternals;
