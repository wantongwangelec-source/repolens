import type { AnalyzableLanguage, Language, ModuleResolver } from "../types.js";
import { isAnalyzable, languageDefinitions, resolverFamily } from "../discovery/language.js";
import { createGoResolver } from "./go-resolver.js";
import { createPythonResolver } from "./python-resolver.js";
import { createRustResolver } from "./rust-resolver.js";
import { createTsResolver } from "./ts-resolver.js";

const CUSTOM_RESOLVERS = new Map<Language, ModuleResolver>();

/**
 * The parser has an internal cache (tsconfig, module tree), so a new set of instances is created each time it scans.
 * Instead of sharing a global singleton—otherwise cross-repository scans would read the previous repository's configuration.
 */
export function createResolvers(): Map<AnalyzableLanguage, ModuleResolver> {
  const map = new Map<AnalyzableLanguage, ModuleResolver>();
  const families = {
    ts: createTsResolver(),
    python: createPythonResolver(),
    go: createGoResolver(),
    rust: createRustResolver(),
  } as const;
  for (const definition of languageDefinitions()) {
    if (!isAnalyzable(definition.id)) continue;
    const family = resolverFamily(definition.id);
    if (family) map.set(definition.id, families[family]);
  }
  for (const [language, resolver] of CUSTOM_RESOLVERS) {
    if (isAnalyzable(language)) map.set(language, resolver);
  }
  return map;
}

/** Provide a dedicated module parser for language plugin registration; must be called before scanning starts. */
export function registerResolverFor(language: Language, resolver: ModuleResolver): void {
  if (CUSTOM_RESOLVERS.has(language)) throw new Error(`语言 ${language} 已注册专用模块解析器`);
  CUSTOM_RESOLVERS.set(language, resolver);
}
