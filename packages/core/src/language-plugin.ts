import { registerLanguage, type LanguageDefinition } from "./discovery/language.js";
import { registerExtractorFor } from "./parse/extractors/registry.js";
import type { LanguageExtractor } from "./parse/extractors/types.js";
import { registerResolverFor } from "./resolve/registry.js";
import type { ModuleResolver } from "./types.js";

export interface LanguagePlugin {
  definition: LanguageDefinition;
  /** If not provided, the built-in extractor specified by definition.extractor will be used (usually generic). */
  extractor?: LanguageExtractor;
  /** Optional dedicated module resolver; if not provided, mark the import explicitly as unresolved. */
  resolver?: ModuleResolver;
}

/**
 * A one-time registration of language discovery, grammar, structure extraction, and module parsing capabilities. Registration only affects subsequent scans.
 * Plugins can be loaded after the process starts, but it is not allowed to override built-in languages or the registration of another plugin.
 */
export function registerLanguagePlugin(plugin: LanguagePlugin): void {
  const definition = plugin.extractor && !plugin.definition.extractor
    ? { ...plugin.definition, extractor: plugin.extractor.family }
    : plugin.definition;
  registerLanguage(definition);
  if (plugin.extractor) registerExtractorFor(definition.id, plugin.extractor);
  if (plugin.resolver) registerResolverFor(definition.id, plugin.resolver);
}
