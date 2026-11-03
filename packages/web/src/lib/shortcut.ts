const IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Display text for the shortcut key: On macOS, type ⌘K; on other platforms, type Ctrl+K.
 * The key handling itself recognizes both ⌘ and Ctrl; this only decides how the label is written.
 */
export function modKey(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

/** Display text for the Option / Alt key */
export const ALT_KEY = IS_MAC ? "⌥" : "Alt+";
