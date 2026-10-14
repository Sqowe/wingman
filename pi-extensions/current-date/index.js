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
 * Plain JavaScript (no build step) so pi can load it directly via `-e <path>`,
 * matching the standing convention for bundled pi extensions in this repo.
 *
 * See pi-extensions/current-date/README.md for full documentation.
 */

const SECTION_NAME = 'current_date';

export default function (pi) {
  // Kill switch — bail before registering any hooks.
  if ((process.env['WINGMAN_CURRENT_DATE'] ?? '').toLowerCase() === 'off') return;

  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections[SECTION_NAME] = renderCurrentDate();
  });
}

/**
 * Render the date section. Date-only granularity (no time of day): pi appends
 * a transcript delta only when the section text changes, and adding hours or
 * minutes would produce a new slightly-different "current time" system message
 * on every user prompt, which is context noise rather than signal.
 */
function renderCurrentDate() {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // en-CA renders ISO-like YYYY-MM-DD; en-GB gives the unabbreviated weekday.
  const date = now.toLocaleDateString('en-CA', { timeZone });
  const weekday = now.toLocaleDateString('en-GB', { timeZone, weekday: 'long' });

  return [
    `Current date: ${date} (${weekday}, time zone ${timeZone}).`,
    'Use this as the reference point for all time-related reasoning.',
    'Ignore any internal assumption about today\u0027s date, including dates implied by the serving infrastructure.',
  ].join('\n');
}
