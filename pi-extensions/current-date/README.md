# pi-extensions/current-date

Bundled pi extension that injects the current date — in the machine's system
time zone — into pi's system prompt as a dedicated section.

## Why it exists

pi's built-in system prompt contains no date at all. Models therefore lean on
their training data or on whatever the serving infrastructure implies, and
providers whose clocks run ahead of local time confidently assert future dates
in answers. A pinned `Current date:` line gives the model one authoritative
reference point, the same way other tools inject `{{date}}` into their system
messages.

## What it does

On every `before_agent_start` event (once per user prompt), sets a
`current_date` section in `systemPromptOptions` (default template shown):

```
<current_date>
Current date: 2026-10-11 (Sunday, time zone Europe/Budapest).
Use this as the reference point for all time-related reasoning.
Ignore any internal assumption about today's date, including dates implied by the serving infrastructure.
</current_date>
```

Design notes:

- **Date granularity, no time of day.** pi diffs prompt sections against the
  transcript and appends a delta only when the rendered text changes. Time-of-day
  precision would emit a new near-identical system message on every prompt;
  a date-only value changes once per day, which is exactly the freshness the
  fix needs. Long sessions crossing midnight stay correct.
- **System time zone, resolved per prompt.** `Intl.DateTimeFormat().resolvedOptions().timeZone`
  is read inside the handler, not at extension load, so the value follows the
  host through travel and DST transitions without restarting pi or Wingman.
- **No Wingman-side wiring.** No commands, no status keys, nothing for the
  host bridge to intercept — the host only passes `-e pi-extensions/current-date/index.js`.

## Configuration

The section text is template-driven by the VS Code setting
`sqoweWingman.currentDateTemplate` (default: the shipped three-line text):

- Placeholders `{{date}}` (`YYYY-MM-DD`), `{{weekday}}` (full English weekday)
  and `{{timeZone}}` (IANA zone of this machine) are substituted at render
  time — the values stay live per prompt even though the template itself is
  fixed for the life of the pi process.
- Unknown placeholders are left verbatim, so a typo stays visible in the
  prompt instead of silently deleting text.
- A blank template falls back to the built-in default (guards against an
  accidentally empty section).
- Changing the setting reloads the agent: the template travels to the pi child
  through its environment (`WINGMAN_CURRENT_DATE_TEMPLATE`), which the host
  sets at spawn on top of the allowlisted env — the child env is fixed at
  spawn, so a respawn is what applies the new value.

| Env var | Effect |
| --- | --- |
| `WINGMAN_CURRENT_DATE_TEMPLATE` | Template override; blank/absent = built-in default. Set by the Wingman host from the setting; also honoured when pi is run manually with `-e`. |
| `WINGMAN_CURRENT_DATE=off` | Kill switch — extension registers nothing. The host forwards it from the environment VS Code started from; it also works when running pi manually. |

Loaded unconditionally (like `instruction-report`); no settings gate.
