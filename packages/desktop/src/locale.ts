import { app } from "electron";

export type Locale = "zh" | "en";

let current: Locale | null = null;

/**
 * The language of native menus and dialogs follows the interface: every time the page loads, it reports the current language once.
 * Before that (when creating menus at startup, errors occur if the service doesn't start), use the one noted last time; if there isn't one, use the system language.
 * Consistent with the page's own default value.
 */
export function locale(): Locale {
  return current ?? (app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");
}

export function setLocale(next: Locale): void {
  current = next;
}

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** The main process has few copy texts, and the two languages are written directly where they are used. */
export function tr(zh: string, en: string): string {
  return locale() === "en" ? en : zh;
}
