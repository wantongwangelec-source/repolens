import { desktop } from "./desktop";

/**
 * Both reading and writing of user preferences go through here. In the browser, it's localStorage. On the desktop, the local service starts every time.
 * The ports are all different, the page changed its source, and localStorage also switched to an empty version, so each time it is written at the same time
 * Hand it over to the main process to save into the state file, and let the preload reload it back into localStorage before the page script runs.
 */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** null means to clear and return to the default */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // This adjustment is still effective when the browser storage is disabled.
  }
  desktop?.savePref(key, value);
}
