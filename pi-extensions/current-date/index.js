/**
 * Wingman bundled pi extension — current-date
 *
 * Injects the current date (system time zone) into pi's system prompt as a
 * dedicated section. Without it pi sends no date at all, so models fall back
 * on their training data or on dates implied by the serving infrastructure —
 * some providers run ahead of local time and confidently assert future dates.
 *
 * Recomputed on every user prompt via the `before_agent_start` event. pi diffs
 * prompt sections against the transcript, so the section is re-sent only when
 * the rendered value actually changes — at date granularity that is once per
 * day, keeping long sessions correct across midnight without churning the
 * context. The time zone is resolved per prompt (not at startup) so it follows
 * the host through travel and DST changes.
 *
 * The section text is template-driven. The template arrives through the
 * environment (the Wingman host sets it from the `sqoweWingman.currentDateTemplate`
 * setting on spawn); placeholders {{date}}, {{weekday}} and {{timeZone}} are
 * substituted at render time. Blank/absent template = built-in default.
 *
 * Plain JavaScript (no build step) so pi can load it directly via `-e <path>`,
 * matching the standing convention for bundled pi extensions in this repo.
 *
 * See pi-extensions/current-date/README.md for full documentation.
 */

const SECTION_NAME = 'current_date';

/** Built-in template, used when WINGMAN_CURRENT_DATE_TEMPLATE is absent or blank. */
const DEFAULT_TEMPLATE = [
  'Current date: {{date}} ({{weekday}}, time zone {{timeZone}}).',
  'Use this as the reference point for all time-related reasoning.',
  "Ignore any internal assumption about today's date, including dates implied by the serving infrastructure.",
].join('\n');

/** Read the template from the environment once per process (per spawn). */
function resolveTemplate() {
  const raw = process.env['WINGMAN_CURRENT_DATE_TEMPLATE'] ?? '';
  return raw.trim() ? raw : DEFAULT_TEMPLATE;
}

/**
 * Render the section for "now". Date-only granularity (no time of day): pi
 * appends a transcript delta only when the section text changes, and adding
 * hours or minutes would produce a new slightly-different "current time"
 * system message on every user prompt, which is context noise rather than
 * signal. Unknown placeholders are left verbatim so a typo stays visible in
 * the prompt instead of silently deleting text.
 */
function renderCurrentDate(template) {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // en-CA renders ISO-like YYYY-MM-DD; en-GB gives the unabbreviated weekday.
  const date = now.toLocaleDateString('en-CA', { timeZone });
  const weekday = now.toLocaleDateString('en-GB', { timeZone, weekday: 'long' });

  return template
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{weekday\}\}/g, weekday)
    .replace(/\{\{timeZone\}\}/g, timeZone);
}

export default function (pi) {
  // Kill switch — bail before registering any hooks. The Wingman host
  // forwards this variable from its own environment so the switch also works
  // when pi is spawned from the extension (the child env is allowlisted).
  if ((process.env['WINGMAN_CURRENT_DATE'] ?? '').toLowerCase() === 'off') return;

  const template = resolveTemplate();

  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections[SECTION_NAME] = renderCurrentDate(template);
  });
}

// Exported for unit tests (src/agent/current-date-extension.test.ts).
// Not part of the pi extension surface.
export const _internals = { DEFAULT_TEMPLATE, resolveTemplate, renderCurrentDate };
