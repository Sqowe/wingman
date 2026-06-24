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

/**
 * Maximum decoded byte length for a single image attached to a prompt.
 * Matches MAX_CLIPBOARD_BYTES — consistent with the existing 5 MB cap on
 * other large payloads. Enforced both webview-side and host-side.
 */
export const MAX_IMAGE_BYTES = 5_242_880; // 5 MB

/**
 * Maximum number of images that may be attached to one prompt.
 * Prevents memory pressure from very large multi-image payloads.
 */
export const MAX_IMAGES_PER_PROMPT = 10;

/**
 * Allowlisted image MIME types accepted for attachment.
 * Matches the set accepted by pi's RPC image content blocks.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** Union type of the allowed image MIME types. */
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/**
 * Maximum total decoded byte size across all images in one prompt.
 * 10 images × 5 MB each could be 50 MB; cap the combined payload at 20 MB
 * to protect VS Code's webview message bus and extension-host memory.
 */
export const MAX_TOTAL_IMAGE_BYTES = 20_971_520; // 20 MB
