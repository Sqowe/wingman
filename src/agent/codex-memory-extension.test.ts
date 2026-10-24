/**
 * Unit tests for the bundled codex-memory pi extension
 * (pi-extensions/codex-memory/index.js) — store resolution (v2 over v1),
 * scope filtering (summary / project / all), cwd-tag prefix matching, char
 * budget on extras only, count vs capped files, status payload shape, and the
 * kill switch.
 *
 * The module reads process.env at call time, so env mutations between cases
 * are seen without re-importing; CODEX_HOME points at a fresh temp dir per
 * case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PiApi, CodexMemoryScope } from '../../pi-extensions/codex-memory/index.js';

type Internals = import('../../pi-extensions/codex-memory/index.js').CodexMemoryInternals;

let internals: Internals;
let factory: (pi: PiApi) => void;

/** Load the extension module (the repo compiles tests as CommonJS — no top-level await). */
async function loadExtension(): Promise<void> {
  const mod = await import('../../pi-extensions/codex-memory/index.js');
  internals = mod._internals as Internals;
  factory = mod.default as (pi: PiApi) => void;
}


/** Build a synthetic Codex home and return its paths. */
function makeCodexHome(opts: { v2?: boolean; v1?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-mem-test-'));
  const layout = (name: string) => {
    const dir = path.join(home, name);
    mkdirSync(path.join(dir, 'rollout_summaries'), { recursive: true });
    mkdirSync(path.join(dir, 'skills', 'release-flow'), { recursive: true });
    writeFileSync(
      path.join(dir, 'memory_summary.md'),
      'v1\n\n## User Profile\n\n- solo dev\n\n## User preferences\n\n- confirm before edits\n',
    );
    writeFileSync(
      path.join(dir, 'MEMORY.md'),
      [
        'preamble',
        '',
        `# Task Group: wingman repo`,
        'scope: everything about wingman',
        `applies_to: cwd=${home}/src/wingman; reuse_rule=safe within the repo`,
        '',
        '## Task 1: fix diff (success)',
        '',
        '# Task Group: other repo',
        'scope: unrelated',
        'applies_to: cwd=/somewhere/else; reuse_rule=checkout-specific',
        '',
        '## Task 1: thing',
        '',
        '# Task Group: untagged group',
        'scope: no applies_to line',
        '',
        '## Task 1: misc',
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(dir, 'raw_memories.md'), 'temp, never injected');
    writeFileSync(path.join(dir, 'rollout_summaries', 'fix-diff.md'), '# recap');
    writeFileSync(path.join(dir, 'skills', 'release-flow', 'SKILL.md'), '# release flow');
    return dir;
  };
  const dirs = {
    home,
    v2: opts.v2 === false ? null : layout('memories_v2'),
    v1: opts.v1 === false ? null : layout('memories'),
  };
  return dirs;
}

/** A registry whose task-group blocks are larger than the minimum budget. */
function oversizedRegistry(): string {
  return [
    '# Task Group: wingman repo',
    'scope: everything about wingman',
    'applies_to: cwd=/repo/wingman; reuse_rule=safe',
    'w'.repeat(3000),
    '# Task Group: other repo',
    'scope: unrelated',
    'applies_to: cwd=/somewhere/else; reuse_rule=checkout-specific',
    'o'.repeat(3000),
    '',
  ].join('\n');
}

function makePi(): PiApi & { handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as PiApi & { handlers: Map<string, unknown> };
}

async function runSession(
  pi: PiApi & { handlers: Map<string, unknown> },
  cwd: string,
): Promise<{ report: [string, string] | null; prompt: string | null }> {
  let report: [string, string] | null = null;
  type SessionStartHandler = (
    event: unknown,
    ctx: { cwd?: string; ui?: { setStatus?: (key: string, text: string) => void } },
  ) => Promise<void>;
  type BeforeAgentStartHandler = (event: { systemPrompt: string }) => Promise<
    { systemPrompt: string } | undefined
  >;
  const onSessionStart = pi.handlers.get('session_start') as SessionStartHandler;
  await onSessionStart({}, {
    cwd,
    ui: {
      setStatus: (key: string, text: string) => {
        report = [key, text];
      },
    },
  });
  const onBeforeAgentStart = pi.handlers.get('before_agent_start') as BeforeAgentStartHandler;
  const res = await onBeforeAgentStart({ systemPrompt: 'BASE' });
  return { report, prompt: res?.systemPrompt ?? null };
}

describe('codex-memory extension — store resolution', () => {
  const ORIGINAL = process.env['CODEX_HOME'];
  let cleanups: string[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    await loadExtension();
    cleanups = [];
  });

  afterEach(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = ORIGINAL;
  });

  it('prefers memories_v2 when both layouts hold artifacts', () => {
    const { home, v2, v1 } = makeCodexHome();
    cleanups.push(home);
    process.env['CODEX_HOME'] = home;
    expect(internals.resolveMemoryDir()).toBe(v2);
    expect(internals.resolveMemoryDir()).not.toBe(v1);
  });

  it('falls back to memories (v1) when v2 is absent', () => {
    const { home, v1 } = makeCodexHome({ v2: false });
    cleanups.push(home);
    process.env['CODEX_HOME'] = home;
    expect(internals.resolveMemoryDir()).toBe(v1);
  });

  it('returns null when no memory store exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex-mem-empty-'));
    cleanups.push(home);
    process.env['CODEX_HOME'] = home;
    expect(internals.resolveMemoryDir()).toBeNull();
  });

  it('returns null for a dir without memory_summary.md or MEMORY.md', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex-mem-junk-'));
    cleanups.push(home);
    mkdirSync(path.join(home, 'memories_v2'));
    writeFileSync(path.join(home, 'memories_v2', 'raw_memories.md'), 'not a real store');
    process.env['CODEX_HOME'] = home;
    expect(internals.resolveMemoryDir()).toBeNull();
  });

  it('a relative CODEX_HOME resolves to an absolute dir', () => {
    // The host requires absolute paths in the status payload — a relative
    // CODEX_HOME must not leak a relative dir into the report.
    const { home } = makeCodexHome();
    cleanups.push(home);
    const relative = path.relative(process.cwd(), home);
    process.env['CODEX_HOME'] = relative;
    const dir = internals.resolveMemoryDir();
    expect(dir).not.toBeNull();
    expect(path.isAbsolute(dir as string)).toBe(true);
    expect(dir).toBe(path.resolve(home, 'memories_v2'));
  });
});

describe('codex-memory extension — parseTaskGroups / selectBlocks', () => {
  let groups: import('../../pi-extensions/codex-memory/index.js').TaskGroup[];

  beforeEach(async () => {
    await loadExtension();
    groups = internals.parseTaskGroups(
      [
        '# Task Group: alpha',
        'scope: a',
        'applies_to: cwd=/repo/alpha; reuse_rule=safe',
        'body A',
        '# Task Group: beta',
        'scope: b',
        'applies_to: cwd=/repo/beta; reuse_rule=safe',
        'body B',
        '# Task Group: gamma',
        'scope: no tag',
        'body C',
      ].join('\n'),
    );
  });

  it('splits blocks with names and cwd tags', () => {
    expect(groups.map((g) => g.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(groups[0].cwd).toBe('/repo/alpha');
    expect(groups[2].cwd).toBeNull();
    expect(groups[0].text).toContain('body A');
    expect(groups[0].text).not.toContain('body B');
  });

  it("project scope matches the workspace cwd exactly and by prefix in both directions", () => {
    // Exact.
    expect(internals.selectBlocks(groups, 'project', '/repo/alpha').map((g) => g.name)).toEqual(['alpha']);
    // Workspace below the tagged root (subdirectory of the repo).
    expect(internals.selectBlocks(groups, 'project', '/repo/alpha/sub').map((g) => g.name)).toEqual(['alpha']);
    // Workspace above the tagged dir (running from a parent).
    expect(internals.selectBlocks(groups, 'project', '/repo').map((g) => g.name)).toEqual([
      'alpha',
      'beta',
    ]);
    // No overlap.
    expect(internals.selectBlocks(groups, 'project', '/elsewhere')).toHaveLength(0);
  });

  it('project scope excludes untagged blocks; all scope admits everything', () => {
    expect(internals.selectBlocks(groups, 'project', '/repo/alpha')).toHaveLength(1);
    expect(internals.selectBlocks(groups, 'all', '/elsewhere').map((g) => g.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('name-prefix siblings do not match (separator-aware prefix)', () => {
    expect(internals.selectBlocks(groups, 'project', '/repo/alpha-evil')).toHaveLength(0);
  });

  it('a git root does not pull in sibling subprojects', async () => {
    // cwd is a package inside a monorepo; a tag on a sibling package must not
    // match, while a tag on the package itself and one on the repo root must.
    const repo = mkdtempSync(path.join(tmpdir(), 'codex-mem-repo-'));
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'alpha'), { recursive: true });
    mkdirSync(path.join(repo, 'beta'), { recursive: true });
    const tagged = internals.parseTaskGroups(
      [
        '# Task Group: alpha',
        'applies_to: cwd=' + path.join(repo, 'alpha') + '; reuse_rule=safe',
        '# Task Group: beta',
        'applies_to: cwd=' + path.join(repo, 'beta') + '; reuse_rule=safe',
        '# Task Group: repo root',
        'applies_to: cwd=' + repo + '; reuse_rule=safe',
      ].join('\n'),
    );
    const selected = internals.selectBlocks(tagged, 'project', path.join(repo, 'alpha', 'sub'));
    const names = selected.map((g) => g.name);
    expect(names).toContain('alpha');
    expect(names).toContain('repo root');
    expect(names).not.toContain('beta');
    rmSync(repo, { recursive: true, force: true });
  });

  it('an indented applies_to line is parsed', () => {
    const indented = internals.parseTaskGroups(
      [
        '# Task Group: indented',
        '  applies_to: cwd=/repo/indented; reuse_rule=safe',
      ].join('\n'),
    );
    expect(indented[0].cwd).toBe('/repo/indented');
  });

  it('cwd tags differing only in case still match on case-insensitive volumes', () => {
    const cased = internals.parseTaskGroups(
      [
        '# Task Group: cased',
        'applies_to: cwd=/Users/John/Repo; reuse_rule=safe',
        '# Task Group: other',
        'applies_to: cwd=/elsewhere; reuse_rule=safe',
      ].join('\n'),
    );
    // macOS (default volume) and Windows compare case-insensitively.
    const expected = process.platform === 'linux' ? [] : ['cased'];
    expect(internals.selectBlocks(cased, 'project', '/users/john/repo').map((g) => g.name)).toEqual(expected);
  });

  it('a tagged cwd containing spaces is parsed whole', () => {
    const spaced = internals.parseTaskGroups(
      [
        '# Task Group: spaced',
        'applies_to: cwd=/Users/John Doe/project; reuse_rule=safe',
        '# Task Group: other',
        'applies_to: cwd=/elsewhere; reuse_rule=safe',
      ].join('\n'),
    );
    expect(spaced[0].cwd).toBe('/Users/John Doe/project');
    expect(internals.selectBlocks(spaced, 'project', '/Users/John Doe/project').map((g) => g.name)).toEqual([
      'spaced',
    ]);
  });
});

describe('codex-memory extension — buildMemoryBlock scope/budget', () => {
  const ORIGINAL_SCOPE = process.env['WINGMAN_CODEX_MEMORY_SCOPE'];
  const ORIGINAL_MAX = process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'];
  let home = '';

  beforeEach(async () => {
    vi.restoreAllMocks();
    await loadExtension();
    ({ home } = makeCodexHome());
    delete process.env['WINGMAN_CODEX_MEMORY_SCOPE'];
    delete process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (ORIGINAL_SCOPE === undefined) delete process.env['WINGMAN_CODEX_MEMORY_SCOPE'];
    else process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = ORIGINAL_SCOPE;
    if (ORIGINAL_MAX === undefined) delete process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'];
    else process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = ORIGINAL_MAX;
  });

  it('summary scope: inlines the summary whole, no task groups, never raw_memories', () => {
    const dir = path.join(home, 'memories_v2');
    const block = internals.buildMemoryBlock(dir, path.join(home, 'src', 'wingman'));
    expect(block).not.toBeNull();
    expect(block!.text).toContain('## User preferences');
    expect(block!.text).not.toContain('Task Group');
    expect(block!.text).not.toContain('never injected');
    // Artifacts: summary, registry, one rollout summary, one skill = 4.
    expect(block!.count).toBe(4);
    expect(block!.files).toHaveLength(4);
    expect(block!.files.map((f) => f.title)).toEqual([
      'memory_summary.md',
      'MEMORY.md',
      'fix-diff',
      'skill: release-flow',
    ]);
  });

  it('project scope: matching block inlined, non-matching and untagged excluded', () => {
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'project';
    const dir = path.join(home, 'memories_v2');
    const block = internals.buildMemoryBlock(dir, path.join(home, 'src', 'wingman', 'sub'));
    expect(block!.text).toContain('Task Group: wingman repo');
    expect(block!.text).not.toContain('Task Group: other repo');
    expect(block!.text).not.toContain('Task Group: untagged group');
  });

  it('all scope: every block inlined', () => {
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'all';
    const dir = path.join(home, 'memories_v2');
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text).toContain('Task Group: wingman repo');
    expect(block!.text).toContain('Task Group: other repo');
    expect(block!.text).toContain('Task Group: untagged group');
  });

  it('budget applies to extras only — a summary longer than the budget still gets blocks', () => {
    // Widen the summary far beyond the budget, then verify extras still inline.
    const dir = path.join(home, 'memories_v2');
    writeFileSync(path.join(dir, 'memory_summary.md'), 'v1\n\n' + 'x'.repeat(5000));
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'all';
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '2000';
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text).toContain('Task Group: wingman repo');
  });

  it('overflowing blocks are listed by name, never mid-cut', () => {
    const dir = path.join(home, 'memories_v2');
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'all';
    // Blocks larger than the (minimum) budget: none fits, all are named.
    writeFileSync(path.join(dir, 'MEMORY.md'), oversizedRegistry());
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '1000';
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text).toContain('more memory artifact(s) not inlined');
    expect(block!.text).toContain('MEMORY.md — wingman repo');
    expect(block!.text).toContain('MEMORY.md — other repo');
    // Whole-block granularity: a skipped block never appears partially.
    expect(block!.text).not.toMatch(/Task Group: [^\n]*\nbody/);
    // The summary itself is always whole.
    expect(block!.text).toContain('confirm before edits');
  });

  it('the budget takes blocks in order — the remainder after an overflow is listed', () => {
    const dir = path.join(home, 'memories_v2');
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'all';
    // First block small (fits), second huge (overflows), third must be listed.
    writeFileSync(
      path.join(dir, 'MEMORY.md'),
      [
        '# Task Group: small',
        'small body',
        '# Task Group: huge',
        'h'.repeat(3000),
        '# Task Group: after',
        'after body',
        '',
      ].join('\n'),
    );
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '1000';
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text).toContain('Task Group: small');
    expect(block!.text).not.toContain('Task Group: huge');
    expect(block!.text).not.toContain('Task Group: after');
    expect(block!.text).toContain('MEMORY.md — huge');
    expect(block!.text).toContain('MEMORY.md — after');
  });

  it('count is the true total while files is capped at 200', () => {
    const dir = path.join(home, 'memories_v2');
    // Artifacts: summary + registry + 1 pre-existing rollout + 205 more + 1 skill = 209.
    for (let i = 0; i < 205; i++) {
      writeFileSync(path.join(dir, 'rollout_summaries', `r-${String(i).padStart(3, '0')}.md`), '# r');
    }
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.count).toBe(209);
    expect(block!.files).toHaveLength(200);
  });

  it('without a summary the registry stands in for it — bounded, never dumped whole', () => {
    const dir = path.join(home, 'memories_v2');
    rmSync(path.join(dir, 'memory_summary.md'));
    // Default scope: the registry replaces the summary (budget still applies).
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text).toContain('Task Group: wingman repo');
    expect(block!.text).toContain('Task Group: other repo');
    // A budget below the block size must bound it and name the rest.
    writeFileSync(path.join(dir, 'MEMORY.md'), oversizedRegistry());
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '1000';
    const capped = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(capped!.text).toContain('not inlined');
    expect(capped!.text).toContain('MEMORY.md — wingman repo');
  });

  it('a free-form registry (no task-group headers) respects the scope', () => {
    const dir = path.join(home, 'memories_v2');
    rmSync(path.join(dir, 'memory_summary.md'));
    writeFileSync(path.join(dir, 'MEMORY.md'), 'free-form notes about the project');

    // `all` inlines it.
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'all';
    const all = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(all!.text).toContain('free-form notes about the project');

    // `project` treats untagged content like an untagged block — not inlined.
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'project';
    const project = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(project!.text).not.toContain('free-form notes about the project');

    // `summary` with a summary present: the free-form registry is not the
    // summary — it is not inlined either.
    writeFileSync(path.join(dir, 'memory_summary.md'), 'v1\n\n## User Profile\n');
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'summary';
    const summary = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(summary!.text).not.toContain('free-form notes about the project');
    expect(summary!.text).toContain('## User Profile');
  });

  it('an oversized summary is truncated with a marker', () => {
    const dir = path.join(home, 'memories_v2');
    writeFileSync(path.join(dir, 'memory_summary.md'), 'v1\n' + 'x'.repeat(200_000));
    const block = internals.buildMemoryBlock(dir, '/elsewhere');
    expect(block!.text.length).toBeLessThan(200_000);
    expect(block!.text).toContain('summary truncated');
    // The agent is told where the full file is.
    expect(block!.text).toContain('memory_summary.md');
  });

  it('invalid scope falls back to summary; invalid maxChars to the default', () => {
    expect(internals.parseScope()).toBe<CodexMemoryScope>('summary');
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'nonsense';
    expect(internals.parseScope()).toBe<CodexMemoryScope>('summary');
    delete process.env['WINGMAN_CODEX_MEMORY_SCOPE'];

    expect(internals.parseMaxChars()).toBe(12000);
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = 'not-a-number';
    expect(internals.parseMaxChars()).toBe(12000);
    // Clamped to the same [1000, 200000] range the setting enforces.
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '42';
    expect(internals.parseMaxChars()).toBe(1000);
    process.env['WINGMAN_CODEX_MEMORY_MAX_CHARS'] = '999999';
    expect(internals.parseMaxChars()).toBe(200000);
  });
});

describe('codex-memory extension — session flow', () => {
  const ORIGINAL_HOME = process.env['CODEX_HOME'];
  const ORIGINAL_SWITCH = process.env['WINGMAN_CODEX_MEMORY'];
  let home = '';

  beforeEach(async () => {
    vi.restoreAllMocks();
    await loadExtension();
    ({ home } = makeCodexHome());
    process.env['CODEX_HOME'] = home;
    delete process.env['WINGMAN_CODEX_MEMORY'];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = ORIGINAL_HOME;
    if (ORIGINAL_SWITCH === undefined) delete process.env['WINGMAN_CODEX_MEMORY'];
    else process.env['WINGMAN_CODEX_MEMORY'] = ORIGINAL_SWITCH;
  });

  it('reports to the reserved key and injects read-only under a heading', async () => {
    const pi = makePi();
    factory(pi);
    const { report, prompt } = await runSession(pi, '/any/project');
    expect(report).not.toBeNull();
    const [key, payload] = report as [string, string];
    expect(key).toBe('wingman:codexMemory');
    const parsed = JSON.parse(payload) as { dir: string; count: number };
    expect(parsed.dir).toBe(path.join(home, 'memories_v2'));
    expect(parsed.count).toBe(4);
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('## Codex memory (shared, read-only)');
    expect(prompt).toContain('## User preferences');
  });

  it('reports null when no store exists (host clears stale state)', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'codex-mem-none-'));
    process.env['CODEX_HOME'] = empty;
    const pi = makePi();
    factory(pi);
    const { report, prompt } = await runSession(pi, '/any/project');
    expect(report).toEqual(['wingman:codexMemory', 'null']);
    // No memory block -> the extension contributes nothing to the prompt.
    expect(prompt).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it('the kill switch (WINGMAN_CODEX_MEMORY=off) registers nothing', () => {
    process.env['WINGMAN_CODEX_MEMORY'] = 'off';
    const pi = makePi();
    factory(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it('no matching blocks -> artifacts are reported but nothing is injected', async () => {
    // Project scope, no summary, and no block tagged for this workspace:
    // the banner still lists what Codex has on disk, but the prompt must not
    // get a hollow "## Codex memory" section.
    const dir = path.join(home, 'memories_v2');
    rmSync(path.join(dir, 'memory_summary.md'));
    writeFileSync(
      path.join(dir, 'MEMORY.md'),
      '# Task Group: elsewhere\napplies_to: cwd=/somewhere/else; reuse_rule=safe\nbody\n',
    );
    process.env['WINGMAN_CODEX_MEMORY_SCOPE'] = 'project';
    const pi = makePi();
    factory(pi);
    const { report, prompt } = await runSession(pi, '/workspace/of/mine');
    // Reported: the artifacts exist and can be opened from the banner.
    expect(report).not.toBeNull();
    const parsed = JSON.parse((report as [string, string])[1]) as { count: number };
    expect(parsed.count).toBeGreaterThan(0);
    // Not injected: no hollow section.
    expect(prompt).toBeNull();
    delete process.env['WINGMAN_CODEX_MEMORY_SCOPE'];
  });
});
