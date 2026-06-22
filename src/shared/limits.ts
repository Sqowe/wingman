/**
 * Transport-agnostic shared limits.
 *
 * Imported by both the extension host and the webview; must contain only
 * plain constants with no runtime imports.
 */

/** Maximum prompt size accepted from the webview (bytes, UTF-8). */
export const MAX_PROMPT_BYTES = 32_768; // 32 KB
