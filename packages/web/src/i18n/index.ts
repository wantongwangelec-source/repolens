import { create } from "zustand";
import { readPref, writePref } from "../lib/prefs";
import { EN, EN_PATTERNS } from "./en";

export type Locale = "zh" | "en";

export type MessageParams = Record<string, string | number>;
/** English entries can be functions, used to handle situations like singular and plural, which Chinese does not need to differentiate. */
export type Translation = string | ((params: MessageParams) => string);

const STORAGE_KEY = "repolens-locale";

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * Interface language. The original Chinese text is used directly as the key: what the code reads is exactly the text displayed on the interface,
 * When looking up in the English dictionary according to the original text, if it cannot be found, the Chinese is displayed as is, so missing one translation will not result in a blank.
 */
export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initialLocale(),
  setLocale(locale) {
    writePref(STORAGE_KEY, locale);
    applyDocumentLocale(locale);
    set({ locale });
  },
}));

applyDocumentLocale(useLocaleStore.getState().locale);

export function t(message: string, params?: MessageParams): string {
  const translation = useLocaleStore.getState().locale === "en" ? lookup(message) : undefined;
  if (typeof translation === "function") return translation(params ?? {});
  return interpolate(translation ?? message, params);
}

/** Only recognizes the dictionary's own keys: the original error message from the server might happen to be names on the prototype like constructor */
function lookup(message: string): Translation | undefined {
  return Object.hasOwn(EN, message) ? EN[message] : undefined;
}

/**
 * Error messages and status explanations sent from the server and the main desktop process. They do not go through t(), and part of them also
 * If the whole sentence cannot be found, match according to EN_PATTERNS for paths or names; if none are recognized, display them as is.
 */
export function translateMessage(message: string): string {
  if (useLocaleStore.getState().locale !== "en") return message;
  if (lookup(message) !== undefined) return t(message);
  for (const [pattern, render] of EN_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return render(...match.slice(1));
  }
  return message;
}

/**
 * Call it inside the component, and when the language is changed, the component re-renders accordingly. What is returned is t itself.
 * In the same file, t has already been imported, so just calling it without receiving the return value is the same.
 */
export function useT(): typeof t {
  useLocaleStore((s) => s.locale);
  return t;
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

/** Date and time are formatted according to the interface language, not the browser's system language */
export function intlLocale(): string {
  return useLocaleStore.getState().locale === "en" ? "en-US" : "zh-CN";
}

/**
 * Mark a piece of copy that will be translated later, and return it as is. Use it for the top-level tag table of the module:
 * The value should be passed through t() only at render time; otherwise, after switching languages, it will still remain as the one during loading.
 */
export function msg(message: string): string {
  return message;
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

function initialLocale(): Locale {
  const stored = readPref(STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  const language = typeof navigator === "undefined" ? "zh" : navigator.language.toLowerCase();
  return language.startsWith("zh") ? "zh" : "en";
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}
