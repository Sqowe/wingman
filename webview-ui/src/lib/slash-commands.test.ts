/**
 * Unit tests for slash-commands helpers.
 *
 * These cover the pure logic that drives the composer's slash menu:
 * - When to open / close the menu (slashFilterFromValue)
 * - Which commands to show (filterCommands)
 * - What text to insert on selection (buildInsertedText)
 *
 * No DOM / jsdom needed — all pure functions.
 */
import { describe, it, expect } from 'vitest';
import { slashFilterFromValue, filterCommands, buildInsertedText, isSlashCommand } from './slash-commands';
import type { PiCommand } from '@shared/messages';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const cmds: PiCommand[] = [
  { name: '/skill:review-fix-loop', description: 'Autonomous review loop' },
  { name: '/skill:firecrawl', description: 'Web search' },
  { name: '/fix-issue', description: 'Fix a GitHub issue', argumentHint: '[issue-number]' },
  { name: '/compact', description: 'Compact the session' },
];

// ─── slashFilterFromValue ────────────────────────────────────────────────────

describe('slashFilterFromValue', () => {
  it('returns "/" for a bare slash', () => {
    expect(slashFilterFromValue('/')).toBe('/');
  });

  it('returns the prefix for a partial command name', () => {
    expect(slashFilterFromValue('/ski')).toBe('/ski');
    expect(slashFilterFromValue('/fix-issue')).toBe('/fix-issue');
  });

  it('returns null for empty string', () => {
    expect(slashFilterFromValue('')).toBeNull();
  });

  it('returns null when a command has been inserted with trailing space', () => {
    // This is the key insert-and-stay case: after selectCommand inserts
    // "/fix-issue ", the menu must NOT reopen.
    expect(slashFilterFromValue('/fix-issue ')).toBeNull();
  });

  it('returns null when the user has typed arguments after the command', () => {
    expect(slashFilterFromValue('/fix-issue 123')).toBeNull();
    expect(slashFilterFromValue('/skill:review-fix-loop focus on auth')).toBeNull();
  });

  it('returns null for plain text (no leading slash)', () => {
    expect(slashFilterFromValue('hello')).toBeNull();
    expect(slashFilterFromValue('fix something')).toBeNull();
  });

  it('returns null for a slash not at position 0', () => {
    expect(slashFilterFromValue('some /cmd')).toBeNull();
  });

  it('returns the full token for a skill:name command', () => {
    expect(slashFilterFromValue('/skill:review')).toBe('/skill:review');
  });
});

// ─── filterCommands ──────────────────────────────────────────────────────────

describe('filterCommands', () => {
  it('returns empty array when prefix is null', () => {
    expect(filterCommands(cmds, null)).toEqual([]);
  });

  it('returns all commands for bare "/"', () => {
    expect(filterCommands(cmds, '/')).toHaveLength(4);
  });

  it('filters case-insensitively', () => {
    expect(filterCommands(cmds, '/SKI')).toHaveLength(2);
    expect(filterCommands(cmds, '/ski')).toHaveLength(2);
  });

  it('matches skill: prefix', () => {
    const results = filterCommands(cmds, '/skill:');
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.name)).toEqual([
      '/skill:review-fix-loop',
      '/skill:firecrawl',
    ]);
  });

  it('returns empty array when no command matches', () => {
    expect(filterCommands(cmds, '/zzz')).toHaveLength(0);
  });

  it('returns commands matching the full typed prefix (startsWith semantics)', () => {
    // '/fix-issue' matches only '/fix-issue' given the current fixture set;
    // the behavior is startsWith, not exact-match.
    const results = filterCommands(cmds, '/fix-issue');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('/fix-issue');
  });

  it('excludes builtIn commands even when they match the prefix', () => {
    const withBuiltIn: PiCommand[] = [
      ...cmds,
      { name: '/settings', description: 'Open settings', builtIn: true },
      { name: '/skill:extra', description: 'Extra skill', builtIn: false },
    ];
    // '/' matches everything but builtIn entries must be excluded.
    const all = filterCommands(withBuiltIn, '/');
    expect(all.every((c) => !c.builtIn)).toBe(true);
    expect(all.map((c) => c.name)).not.toContain('/settings');
    expect(all.map((c) => c.name)).toContain('/skill:extra');
  });

  it('excludes builtIn commands even when prefix matches exactly', () => {
    const withBuiltIn: PiCommand[] = [
      { name: '/compact', description: 'Compact session', builtIn: true },
    ];
    expect(filterCommands(withBuiltIn, '/compact')).toHaveLength(0);
  });

  it('preserves argumentHint on matched commands', () => {
    const [cmd] = filterCommands(cmds, '/fix-issue');
    expect(cmd.argumentHint).toBe('[issue-number]');
  });

  it('returns empty array for empty command list', () => {
    expect(filterCommands([], '/')).toEqual([]);
  });
});

// ─── buildInsertedText ───────────────────────────────────────────────────────

describe('buildInsertedText', () => {
  it('appends a single trailing space to the command name', () => {
    const cmd: PiCommand = { name: '/fix-issue', description: '' };
    expect(buildInsertedText(cmd)).toBe('/fix-issue ');
  });

  it('works for skill: commands', () => {
    const cmd: PiCommand = { name: '/skill:review-fix-loop', description: '' };
    expect(buildInsertedText(cmd)).toBe('/skill:review-fix-loop ');
  });

  it('the result is not a bare slash prefix — slashFilterFromValue returns null', () => {
    // Confirms the round-trip: after insertion the menu stays closed.
    const cmd: PiCommand = { name: '/review', description: '' };
    const inserted = buildInsertedText(cmd);
    expect(slashFilterFromValue(inserted)).toBeNull();
  });

  it('preserves the command name exactly (no normalisation)', () => {
    const cmd: PiCommand = { name: '/skill:firecrawl-search', description: '' };
    expect(buildInsertedText(cmd)).toBe('/skill:firecrawl-search ');
  });
});

// ─── isSlashCommand ──────────────────────────────────────────────────────────────

// Known commands fixture used for command-aware tests.
const knownCmds: PiCommand[] = [
  { name: '/fix-issue', description: 'Fix a GitHub issue' },
  { name: '/skill:review-fix-loop', description: 'Autonomous review loop' },
  { name: '/compact', description: 'Compact session' },
  { name: '/settings', description: 'Settings', builtIn: true },
];

describe('isSlashCommand', () => {
  describe('command-aware mode (commands list provided)', () => {
    it('returns true for an exact command name match', () => {
      expect(isSlashCommand('/fix-issue', knownCmds)).toBe(true);
    });

    it('returns true for a command name with trailing arguments', () => {
      expect(isSlashCommand('/fix-issue 123', knownCmds)).toBe(true);
      expect(isSlashCommand('/skill:review-fix-loop focus on auth', knownCmds)).toBe(true);
    });

    it('returns true for inserted text with trailing space', () => {
      // buildInsertedText result before the user types args.
      expect(isSlashCommand('/fix-issue ', knownCmds)).toBe(true);
    });

    it('returns false for a bare slash', () => {
      expect(isSlashCommand('/', knownCmds)).toBe(false);
    });

    it('returns false for an unknown slash token (avoids false positive on paths)', () => {
      // This is the key improvement over the heuristic: '/usr/local/bin' is not
      // in the known commands list, so images are not stripped.
      expect(isSlashCommand('/usr/local/bin', knownCmds)).toBe(false);
      expect(isSlashCommand('/unknown-cmd', knownCmds)).toBe(false);
    });

    it('returns false for builtIn commands (they are inert over RPC)', () => {
      expect(isSlashCommand('/settings', knownCmds)).toBe(false);
    });

    it('returns false for plain text', () => {
      expect(isSlashCommand('hello world', knownCmds)).toBe(false);
      expect(isSlashCommand('', knownCmds)).toBe(false);
    });

    it('returns false for a slash not at position 0', () => {
      expect(isSlashCommand('some /fix-issue', knownCmds)).toBe(false);
    });
  });

  describe('heuristic fallback mode (no commands list)', () => {
    it('returns true for a slash token with no list', () => {
      expect(isSlashCommand('/fix-issue')).toBe(true);
    });

    it('returns false for a bare slash', () => {
      expect(isSlashCommand('/')).toBe(false);
    });

    it('returns false for plain text', () => {
      expect(isSlashCommand('')).toBe(false);
      expect(isSlashCommand('hello')).toBe(false);
    });
  });

  describe('empty commands list (initialization state)', () => {
    // During startup, commands=[] before get_commands completes.
    // An empty list is treated as command-aware (no known commands yet),
    // NOT as a fallback to heuristic — so no false positives on paths.
    it('returns false for a slash token when list is empty', () => {
      expect(isSlashCommand('/fix-issue', [])).toBe(false);
    });

    it('returns false for an absolute path when list is empty', () => {
      expect(isSlashCommand('/usr/local/bin', [])).toBe(false);
    });

    it('returns false for plain text when list is empty', () => {
      expect(isSlashCommand('hello', [])).toBe(false);
      expect(isSlashCommand('', [])).toBe(false);
    });
  });

  // ── Images-invariant round-trip ───────────────────────────────────────────
  //
  // Confirms that any text produced by the slash-command selection flow
  // (buildInsertedText + user-typed args) is always detected as a slash
  // command when the known commands list is passed.

  it('any buildInsertedText result is detected as a slash command', () => {
    const flowCmds: PiCommand[] = [
      { name: '/fix-issue', description: '' },
      { name: '/skill:review-fix-loop', description: '' },
      { name: '/compact', description: '' },
    ];
    for (const cmd of flowCmds) {
      const inserted = buildInsertedText(cmd);
      expect(isSlashCommand(inserted, flowCmds)).toBe(true);
      expect(isSlashCommand(`${inserted}some user instruction`, flowCmds)).toBe(true);
    }
  });

  // ── Selection flow invariant ───────────────────────────────────────────────
  //
  // Documents the full round-trip: select → insert → user types args → send.

  it('selection flow: inserted text closes menu and is flagged as slash command', () => {
    const cmd: PiCommand = { name: '/fix-issue', description: '', argumentHint: '[issue-number]' };
    const flowCmds = [cmd];

    // 1. User types '/fi' — menu opens.
    expect(slashFilterFromValue('/fi')).toBe('/fi');

    // 2. User selects the command — buildInsertedText produces '/fix-issue '.
    const inserted = buildInsertedText(cmd);
    expect(inserted).toBe('/fix-issue ');

    // 3. Menu must NOT reopen after insertion (trailing space closes it).
    expect(slashFilterFromValue(inserted)).toBeNull();

    // 4. User types an argument — menu stays closed.
    expect(slashFilterFromValue('/fix-issue 123')).toBeNull();

    // 5. At send time, images must be suppressed for this text.
    expect(isSlashCommand('/fix-issue 123', flowCmds)).toBe(true);
    expect(isSlashCommand(inserted, flowCmds)).toBe(true);
  });

  it('Enter key path: selecting from menu does not send — only inserts', () => {
    // The Enter key handler in Composer calls selectCommand() and returns
    // (e.preventDefault() + return, no fall-through to handleSend).
    // We verify the pure-logic side: after buildInsertedText the menu is closed
    // (slashFilterFromValue returns null), meaning a subsequent Enter would
    // go to the normal send path only when the user explicitly presses it.
    const cmd: PiCommand = { name: '/skill:review-fix-loop', description: '' };
    const inserted = buildInsertedText(cmd);

    // Inserted text is '/skill:review-fix-loop ' — menu closed, not yet sent.
    expect(slashFilterFromValue(inserted)).toBeNull();

    // Only after the user presses Enter again (with the full text) would
    // handleSend be triggered — at that point isSlashCommand correctly detects it.
    const flowCmds = [cmd];
    expect(isSlashCommand(inserted, flowCmds)).toBe(true);
    expect(isSlashCommand(`${inserted}focus on auth`, flowCmds)).toBe(true);
  });
});
