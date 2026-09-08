/**
 * Shared parsing rules for pi's `select` / `input` dialog payloads.
 *
 * This file is imported by both the extension host (Node) and the webview
 * (React) — it must contain only pure functions with no runtime imports, no
 * `vscode`, and no DOM.
 *
 * ## Why a shared module
 *
 * pi's `select` primitive carries `string[]` and nothing else, so a sender with
 * both a short label and a longer explanation per option has no choice but to
 * flatten the two into one line. Both surfaces that render such an option — the
 * host's quick pick (`toOptionPick` in `src/ui-protocol/bridge.ts`) and the
 * webview's question card — must split it the *same* way, or the same dialog
 * would read differently depending on which surface won. One rule, one file.
 *
 * ## Recognition is by shape, never by name
 *
 * An `extension_ui_request` carries only `id` / `method` / `title` / `options` /
 * `timeout` (pi `docs/rpc.md` §"Extension UI Requests") — no tool name, no
 * extension name, no sender identity of any kind. Every function here therefore
 * keys on the payload itself. Two consequences worth stating: renaming the
 * sending tool cannot break this, and any extension that formats its options
 * the same way benefits automatically.
 *
 * ## The answer goes back byte-for-byte
 *
 * Senders encode meaning into the option string.
 * `@juicesharp/rpiv-ask-user-question` reads the leading index back with
 * `Number.parseInt` and treats anything it cannot map to an offered index as a
 * *dismissal* — which cancels the whole questionnaire. So `ParsedOption.raw` is
 * the only value that may ever be sent back; every other field on it exists for
 * display only.
 *
 * See `docs/design/in-chat-question-cards.md` for the design this supports.
 */

/**
 * Separator between an option's headline and its explanation.
 *
 * The convention is a spaced em dash: rpiv's RPC fallback builds
 * `"3. Rewrite for aiohttp — Replace the FastAPI stub…"` (`rpc-fallback.ts`,
 * `formatOptionLine`). A VS Code quick pick truncates a one-line label with an
 * ellipsis at ~600 px, so the explanation is precisely the part that gets lost.
 */
export const OPTION_DETAIL_SEPARATOR = ' — ';

/**
 * Option length, in characters, above which a quick pick row would be
 * truncated with an ellipsis.
 *
 * A 600 px quick pick row shows roughly this many characters at the default
 * font size (`.quick-input-widget{…width:600px…}` in VS Code's
 * `workbench.desktop.main.css`, with no API to change it).
 *
 * Provisional: derived from the widget width, not measured against real
 * questions — see `docs/design/in-chat-question-cards.md` §8. It is a
 * secondary signal only; every option rpiv sends already carries
 * `OPTION_DETAIL_SEPARATOR`, so this exists to catch senders that flatten a
 * long option *without* a separator. Revise it against real dialogs rather
 * than by re-deriving it from the pixel width.
 */
export const MAX_QUICK_PICK_OPTION_CHARS = 90;

// ─── Options ──────────────────────────────────────────────────────────────────

/** One `select` option, split into display parts. */
export interface ParsedOption {
  /**
   * The option string exactly as pi sent it.
   *
   * The **only** value that may be sent back in an `extension_ui_response`.
   * Senders parse their own encoding out of it (rpiv reads the leading `N.`),
   * so a reformatted answer is not merely cosmetic — rpiv reads an
   * unrecognised value as a dismissal and cancels the questionnaire.
   */
  raw: string;
  /**
   * The leading 1-based list number (`"3. Foo"` → `3`), or undefined when the
   * option does not start with one. Display only — never rebuild an answer
   * from this; send `raw`.
   */
  index?: number;
  /**
   * The headline, retaining any `"N. "` prefix. This is what the quick pick
   * shows on its `label` line, so the prefix stays: it is the user's visual
   * link to a sender that talks in option numbers.
   */
  label: string;
  /** `label` with the `"N. "` prefix removed — for surfaces that number rows themselves. */
  headline: string;
  /** The explanation after the separator, or undefined when there is none. */
  description?: string;
}

/** Matches a leading `"12. "` list number, capturing the digits. */
const LEADING_INDEX_RE = /^(\d+)\.[^\S\n]*/;

/**
 * Split `"3. Label — explanation"` into its display parts.
 *
 * Splitting is per option, never all-or-nothing: a real list routinely mixes
 * both kinds — rpiv appends a bare `"4. Type something."` sentinel to an
 * otherwise fully-described list.
 *
 * An option that contains the separator inside its own label splits at the
 * **first** occurrence. Worst case is cosmetic: text moves to the description
 * (design doc §6), and `raw` is unaffected.
 */
export function parseOption(raw: string): ParsedOption {
  const at = raw.indexOf(OPTION_DETAIL_SEPARATOR);

  // Default to the whole string as the label, untrimmed — a plain option such
  // as `"Allow"` or `"3. Type something."` must survive byte-identically.
  let label = raw;
  let description: string | undefined;

  if (at > 0) {
    const head = raw.slice(0, at).trim();
    const tail = raw.slice(at + OPTION_DETAIL_SEPARATOR.length).trim();
    // Only accept the split when both halves carry text; a leading or trailing
    // separator is not a headline/explanation pair.
    if (head.length > 0 && tail.length > 0) {
      label = head;
      description = tail;
    }
  }

  const match = LEADING_INDEX_RE.exec(label);
  const index = match ? Number.parseInt(match[1], 10) : undefined;
  const headline = match ? label.slice(match[0].length) : label;

  return {
    raw,
    ...(index !== undefined ? { index } : {}),
    label,
    headline,
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * True when a `select` payload's options would suffer as a quick pick and
 * should render as an in-chat question card instead.
 *
 * Both signals read the **options**, not the title — deliberately. A tempting
 * third signal, "the title spans several lines", would drag in dialogs that are
 * better off native: `bash-restrictions` builds a multi-line title but offers
 * `Allow once` / `Deny` / `Deny & suggest alternative`, three short labels
 * answered in a keystroke. Routing the product's most frequent dialog to a card
 * would make it slower for no gain (design doc §4).
 */
export function shouldRouteToCard(options: readonly string[]): boolean {
  return options.some(
    (option) =>
      option.includes(OPTION_DETAIL_SEPARATOR) ||
      option.length > MAX_QUICK_PICK_OPTION_CHARS,
  );
}

// ─── Titles ───────────────────────────────────────────────────────────────────

/** Matches a blank line (a line break, optional horizontal whitespace, a line break). */
const BLANK_LINE_RE = /\n[^\S\n]*\n/;

/**
 * Split a dialog title at the first blank line.
 *
 * Both quick input surfaces render a title as a single text node, so newlines
 * in it collapse into spaces. Senders that compose a title out of several
 * blocks separated by a blank line — rpiv's multiple choice sends the question,
 * the option list and "enter the numbers, comma-separated" as one string —
 * therefore read as one run of text.
 *
 * `rest` is undefined when the title is a single block. Collapsed newlines
 * *within* a block are not recoverable here; removing that ceiling is what the
 * question card is for.
 */
export function splitTitleBlocks(title: string): { head: string; rest?: string } {
  const at = title.search(BLANK_LINE_RE);
  if (at < 0) return { head: title };

  const head = title.slice(0, at).trim();
  const rest = title.slice(at).trim();
  if (head.length === 0 || rest.length === 0) return { head: title };
  return { head, rest };
}

/** A question, with the sender's short chip label lifted out of it. */
export interface ParsedQuestion {
  /** The bracketed chip, when the sender prefixed one (`"[REST API file] …"`). */
  header?: string;
  /** The question with any chip prefix removed. */
  question: string;
}

/** Matches a leading `"[chip] "` prefix, capturing the chip text. */
const LEADING_HEADER_RE = /^\[([^\]\n]{1,60})\][^\S\n]*/;

/**
 * Lift a leading `"[chip] "` prefix off a question.
 *
 * rpiv has a short `header` field per question but no wire field to carry it,
 * so it prefixes the question text (`rpc-fallback.ts`:
 * `` const header = q.header ? `[${q.header}] ` : "" ``). A card renders it as
 * its own chip instead of leaving it inline. The chip is capped at 60
 * characters and may not span lines, so a question that merely *starts* with a
 * bracketed clause is left alone.
 */
export function parseQuestionHeader(text: string): ParsedQuestion {
  const match = LEADING_HEADER_RE.exec(text);
  if (!match) return { question: text };

  const header = match[1].trim();
  const question = text.slice(match[0].length).trim();
  // A prefix with nothing after it is the question, not a chip for an empty one.
  if (header.length === 0 || question.length === 0) return { question: text };
  return { header, question };
}

// ─── Option previews folded into a title ──────────────────────────────────────

/**
 * Matches one preview banner line: `--- 2. Rewrite for aiohttp preview ---`.
 *
 * rpiv has no wire field for a per-option preview either, so it folds previews
 * into the `select` title, capped at 600 characters each
 * (`rpc-fallback.ts`, `buildPreviewBlock`):
 *
 * ```
 * <question>
 *
 * --- 1. <label> preview ---
 * <preview text>
 *
 * --- 2. <label> preview ---
 * <preview text>
 * ```
 *
 * The title is the only place a preview arrives, which is why the card parses
 * it back out rather than reading a field.
 */
const PREVIEW_BANNER_RE = /^[^\S\n]*-{3,}[^\S\n]*(\d+)\.[^\n]*?preview[^\S\n]*-{3,}[^\S\n]*$/gm;

/** A title split into the question and any option previews folded into it. */
export interface ParsedTitlePreviews {
  /** The title with every preview block removed. */
  question: string;
  /**
   * Preview text by 1-based option index, matching `ParsedOption.index`.
   * Empty when the title carries none.
   */
  previews: Record<number, string>;
}

/**
 * Pull option previews back out of a `select` title.
 *
 * Returns the question with the preview blocks stripped, plus each preview
 * keyed by the option index its banner named. A title with no banner comes back
 * unchanged with an empty `previews`, so this is safe to call on every title.
 *
 * Preview *content* is not inspected: a preview that itself contains a line
 * looking like a banner would split early. That is cosmetic and matches how the
 * rest of this module treats ambiguous senders — never at the cost of `raw`.
 */
export function parseTitlePreviews(title: string): ParsedTitlePreviews {
  // Collect banner positions first; slicing between them is simpler (and easier
  // to reason about) than trying to capture the bodies in one regex.
  const banners: Array<{ index: number; start: number; end: number }> = [];
  // The regex is /g and module-scoped, so reset lastIndex before every scan.
  PREVIEW_BANNER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PREVIEW_BANNER_RE.exec(title)) !== null) {
    banners.push({
      index: Number.parseInt(match[1], 10),
      start: match.index,
      end: match.index + match[0].length,
    });
    // Guard against a zero-length match stalling the loop.
    if (match[0].length === 0) PREVIEW_BANNER_RE.lastIndex++;
  }

  if (banners.length === 0) return { question: title, previews: {} };

  const previews: Record<number, string> = {};
  for (let i = 0; i < banners.length; i++) {
    const banner = banners[i];
    const bodyEnd = i + 1 < banners.length ? banners[i + 1].start : title.length;
    const body = title.slice(banner.end, bodyEnd).trim();
    // Last banner wins for a duplicated index — same "first/last occurrence"
    // pragmatism as parseOption: never worth failing the whole dialog over.
    if (body.length > 0) previews[banner.index] = body;
  }

  return { question: title.slice(0, banners[0].start).trim(), previews };
}

// ─── Multiple choice folded into an `input` title ─────────────────────────────

/** A multiple-choice question recovered from an `input` title. */
export interface ParsedMultiSelect {
  /** The question block, chip prefix still attached (run it through `parseQuestionHeader`). */
  question: string;
  /** The numbered option lines, verbatim, in the order the sender listed them. */
  options: string[];
  /** Everything after the option list — the sender's how-to-answer instructions. */
  instructions?: string;
}

/**
 * Recover a multiple-choice question from an `input` title.
 *
 * Multiple choice does not arrive as a `select`. rpiv sends an `input` whose
 * title is the question, a blank line, the numbered option list, a blank line,
 * and the instruction to "enter the numbers of all that apply, comma-separated"
 * (`rpc-fallback.ts`, `askMultiSelect`). No quick input surface honours a line
 * break, so those options run together into one wrapped paragraph — the ceiling
 * the question card exists to remove (design doc §8).
 *
 * Returns null unless the title really has that shape: at least two blocks, one
 * of which is entirely numbered lines, with at least two of them. Anything else
 * — a plain prompt, rpiv's own free-text follow-up (question, blank line,
 * "Type your answer:") — is left for the input box.
 *
 * **The answer is indices, not labels.** rpiv splits the reply on `/[,\s]+/`
 * and requires *every* token to be an in-range index; a single unrecognised
 * token makes it keep the entire reply as free text instead. So a card must
 * submit bare comma-separated indices (`"1,3"`).
 */
export function parseMultiSelectTitle(title: string): ParsedMultiSelect | null {
  // Same blank-line pattern `splitTitleBlocks` uses, but with `split` rather than
  // `search`: that function needs only the first boundary (head / rest), while a
  // multiple-choice title has to be examined block by block to find which one is
  // the option list.
  const blocks = title
    .split(BLANK_LINE_RE)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length < 2) return null;

  // Never treat the first block as the option list: that is the question, and a
  // question is not a list of numbered lines.
  for (let i = 1; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length < 2) continue;
    if (!lines.every((line) => LEADING_INDEX_RE.test(line))) continue;

    const instructions = blocks.slice(i + 1).join('\n\n').trim();
    return {
      question: blocks.slice(0, i).join('\n\n').trim(),
      options: lines,
      ...(instructions.length > 0 ? { instructions } : {}),
    };
  }

  return null;
}
