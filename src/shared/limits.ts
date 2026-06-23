/**
 * Transport-agnostic shared limits.
 *
 * Imported by both the extension host and the webview; must contain only
 * plain constants with no runtime imports.
 */

/** Maximum prompt size accepted from the webview (bytes, UTF-8). */
export const MAX_PROMPT_BYTES = 32_768; // 32 KB

/**
 * Maximum byte length accepted for a clipboard write from the webview.
 * Prevents memory / DoS issues from oversized payloads.
 * Enforced both webview-side (before sending) and host-side (in validation).
 */
export const MAX_CLIPBOARD_BYTES = 5_242_880; // 5 MB

/**
 * Maximum byte length accepted for a patch string sent in openDiff / applyEdit
 * messages from the webview. Patches beyond this are almost certainly a bug or
 * an abuse attempt — reject early rather than running the diff algorithm.
 */
export const MAX_PATCH_BYTES = 1_048_576; // 1 MB
