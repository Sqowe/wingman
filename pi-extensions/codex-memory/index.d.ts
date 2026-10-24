/**
 * Type declarations for the plain-JS codex-memory pi extension, so host code
 * (and unit tests) get a typed import surface without adding a build step to
 * pi-extensions/. Mirrors index.js.
 */

export interface CodexMemoryEntry {
  path: string;
  title: string;
}

export interface CodexMemoryBlock {
  /** Fully assembled injected text. */
  text: string;
  /** True total number of memory artifacts (independent of the files cap). */
  count: number;
  /** Reported artifact list, capped at MAX_REPORTED_FILES. */
  files: CodexMemoryEntry[];
}

/** A `# Task Group:` block parsed out of MEMORY.md. */
export interface TaskGroup {
  name: string;
  text: string;
  cwd: string | null;
}

export type CodexMemoryScope = 'summary' | 'project' | 'all';

export interface CodexMemoryInternals {
  /** Resolve $CODEX_HOME/memories[_v2], preferring the newer non-empty layout. */
  resolveMemoryDir(): string | null;
  /** Build the injected block + status-report payload for a memory dir. */
  buildMemoryBlock(dir: string, cwd: string | null | undefined): CodexMemoryBlock | null;
  /** Split MEMORY.md into `# Task Group:` blocks with their cwd tag. */
  parseTaskGroups(registryText: string): TaskGroup[];
  /** Pick the blocks a scope admits for a workspace cwd. */
  selectBlocks(blocks: TaskGroup[], scope: CodexMemoryScope, cwd: string | null | undefined): TaskGroup[];
  /** Read WINGMAN_CODEX_MEMORY_SCOPE (unrecognized -> 'summary'). */
  parseScope(): CodexMemoryScope;
  /** Read WINGMAN_CODEX_MEMORY_MAX_CHARS (invalid -> 12000). */
  parseMaxChars(): number;
  /** List every memory artifact (summary, registry, rollouts, skills). */
  listArtifacts(dir: string): CodexMemoryEntry[];
}

/** pi ExtensionAPI surface this module touches (structural, not the real type). */
export interface PiApi {
  on(
    event: 'session_start',
    handler: (
      event: unknown,
      ctx: { cwd?: string; ui?: { setStatus?: (key: string, text: string) => void } },
    ) => void | Promise<void>,
  ): () => void;
  on(
    event: 'before_agent_start',
    handler: (event: { systemPrompt: string }) =>
      | void
      | Promise<{ systemPrompt: string } | undefined>,
  ): () => void;
}

export default function codexMemory(pi: PiApi): void;
export const _internals: CodexMemoryInternals;
