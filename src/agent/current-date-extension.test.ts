/**
 * Unit tests for the bundled current-date pi extension
 * (pi-extensions/current-date/index.js) — template resolution, placeholder
 * substitution, kill switch and section registration.
 *
 * The module reads process.env at load, so each case re-imports it fresh via
 * vi.resetModules() with the environment it needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PiApi } from '../../pi-extensions/current-date/index.js';

async function loadExtension(): Promise<{
  factory: (pi: PiApi) => void;
  internals: import('../../pi-extensions/current-date/index.js').CurrentDateInternals;
}> {
  const mod = await import('../../pi-extensions/current-date/index.js');
  return { factory: mod.default, internals: mod._internals };
}

function makePi(): PiApi & { handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
}

function fire(pi: PiApi & { handlers: Map<string, unknown> }): Record<string, string> {
  const handler = pi.handlers.get('before_agent_start') as
    | ((event: { systemPromptOptions: { sections: Record<string, string> } }) => void)
    | undefined;
  expect(handler).toBeTypeOf('function');
  const sections: Record<string, string> = {};
  handler!({ systemPromptOptions: { sections } });
  return sections;
}

describe('current-date extension', () => {
  const ORIGINAL_TEMPLATE = process.env['WINGMAN_CURRENT_DATE_TEMPLATE'];
  const ORIGINAL_SWITCH = process.env['WINGMAN_CURRENT_DATE'];

  beforeEach(() => {
    vi.resetModules();
    delete process.env['WINGMAN_CURRENT_DATE_TEMPLATE'];
    delete process.env['WINGMAN_CURRENT_DATE'];
  });

  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_TEMPLATE === undefined) delete process.env['WINGMAN_CURRENT_DATE_TEMPLATE'];
    else process.env['WINGMAN_CURRENT_DATE_TEMPLATE'] = ORIGINAL_TEMPLATE;
    if (ORIGINAL_SWITCH === undefined) delete process.env['WINGMAN_CURRENT_DATE'];
    else process.env['WINGMAN_CURRENT_DATE'] = ORIGINAL_SWITCH;
  });

  it('registers before_agent_start and sets a current_date section from the default template', async () => {
    const { factory } = await loadExtension();
    const pi = makePi();
    factory(pi);
    expect(pi.handlers.size).toBe(1);

    const sections = fire(pi);
    const text = sections['current_date'];
    expect(text).toBeTypeOf('string');
    // Default template shape: date line first, no raw placeholders left.
    expect(text).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \([A-Za-z]+, time zone [A-Za-z/_+-]+\)\./);
    expect(text).not.toContain('{{');
    expect(text).toContain('reference point for all time-related reasoning');
  });

  it('substitutes {{date}}, {{weekday}} and {{timeZone}} from a custom template', async () => {
    process.env['WINGMAN_CURRENT_DATE_TEMPLATE'] =
      'Heute ist {{weekday}}, {{date}} ({{timeZone}}).';
    const { factory } = await loadExtension();
    const pi = makePi();
    factory(pi);

    const sections = fire(pi);
    expect(sections['current_date']).toMatch(/^Heute ist [A-Za-z]+, \d{4}-\d{2}-\d{2} \([A-Za-z/_+-]+\)\.$/);
  });

  it('leaves unknown placeholders verbatim', async () => {
    process.env['WINGMAN_CURRENT_DATE_TEMPLATE'] = '{{date}} — {{unknown}}';
    const { factory } = await loadExtension();
    const pi = makePi();
    factory(pi);

    expect(fire(pi)['current_date']).toContain('{{unknown}}');
  });

  it('falls back to the built-in default when the template is blank', async () => {
    process.env['WINGMAN_CURRENT_DATE_TEMPLATE'] = '   ';
    const { factory, internals } = await loadExtension();
    expect(internals.resolveTemplate()).toBe(internals.DEFAULT_TEMPLATE);

    const pi = makePi();
    factory(pi);
    expect(fire(pi)['current_date']).not.toContain('{{');
  });

  it('registers nothing when WINGMAN_CURRENT_DATE=off', async () => {
    process.env['WINGMAN_CURRENT_DATE'] = 'off';
    const { factory } = await loadExtension();
    const pi = makePi();
    factory(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it('renders the same text within a day (stable prompt section, no churn)', async () => {
    const { internals } = await loadExtension();
    const a = internals.renderCurrentDate(internals.DEFAULT_TEMPLATE);
    const b = internals.renderCurrentDate(internals.DEFAULT_TEMPLATE);
    expect(a).toBe(b);
  });

  // The shipped VS Code default and the extension's built-in fallback are two
  // copies of the same string, reached by different paths: the host always
  // passes the setting (default included) to the child, while a blank/absent
  // env falls back to DEFAULT_TEMPLATE. If they drift, behaviour silently
  // depends on how pi was launched, so pin them together.
  it('ships a package.json default identical to the extension default template', async () => {
    const { internals } = await loadExtension();
    const manifest = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as {
      contributes: {
        configuration: {
          properties: Record<string, { default?: unknown; markdownDescription?: string }>;
        };
      };
    };
    const setting =
      manifest.contributes.configuration.properties['sqoweWingman.currentDateTemplate'];
    expect(setting).toBeDefined();
    expect(setting.default).toBe(internals.DEFAULT_TEMPLATE);
  });
});
