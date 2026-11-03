import type { AnalyzableLanguage, BuiltinLanguage, Language } from "../types.js";

export type ExtractorFamily = "ts" | "python" | "go" | "rust" | "generic";
export type ResolverFamily = "ts" | "python" | "go" | "rust";
export type EmbeddedSourceKind = "vue" | "svelte" | "astro";

/** A complete statement of a language's capabilities; discovery, parsing, and modular parsing all take this as the sole source of truth. */
export interface LanguageDefinition {
  id: Language;
  extensions: readonly string[];
  /** The grammar file name in @vscode/tree-sitter-wasm. */
  grammar?: string;
  /** The absolute wasm path of a third-party grammar; built-in languages do not need to be filled in. */
  grammarPath?: string;
  extractor?: ExtractorFamily;
  resolver?: ResolverFamily;
  embedded?: EmbeddedSourceKind;
}

const BUILTINS: readonly LanguageDefinition[] = [
  language("typescript", [".ts", ".mts", ".cts"], "typescript", "ts", "ts"),
  language("tsx", [".tsx"], "tsx", "ts", "ts"),
  language("javascript", [".js", ".mjs", ".cjs"], "javascript", "ts", "ts"),
  language("jsx", [".jsx"], "tsx", "ts", "ts"),
  embedded("vue", [".vue"]),
  embedded("svelte", [".svelte"]),
  embedded("astro", [".astro"]),
  language("python", [".py", ".pyi"], "python", "python", "python"),
  language("go", [".go"], "go", "go", "go"),
  language("rust", [".rs"], "rust", "rust", "rust"),

  // Languages that rely on already distributed grammar should first connect to the universal structure extractor. It can reliably provide declarations.
  // and the call location, but it will not disguise an uncertain module path as fully resolved.
  language("java", [".java"], "java", "generic"),
  language("c", [".c", ".h"], "cpp", "generic"),
  language("cpp", [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], "cpp", "generic"),
  language("csharp", [".cs"], "c-sharp", "generic"),
  language("php", [".php", ".phtml"], "php", "generic"),
  language("ruby", [".rb", ".rake", ".gemspec"], "ruby", "generic"),
  language("powershell", [".ps1", ".psm1", ".psd1"], "powershell", "generic"),
  language("shell", [".sh", ".bash", ".zsh", ".fish"], "bash", "generic"),

  // Languages without accompanying grammar must also be visible as source code: count LOC, display source code, and support
  // File-level AI understanding; simply explicitly does not produce symbols/call graphs.
  plain("kotlin", [".kt", ".kts"]),
  plain("swift", [".swift"]),
  plain("dart", [".dart"]),
  plain("lua", [".lua"]),
  plain("scala", [".scala", ".sc"]),
  plain("elixir", [".ex", ".exs"]),
  plain("erlang", [".erl", ".hrl"]),
  plain("haskell", [".hs", ".lhs"]),
  plain("clojure", [".clj", ".cljs", ".cljc", ".edn"]),
  plain("objective-c", [".m", ".mm"]),
  plain("groovy", [".groovy", ".gradle"]),
  plain("perl", [".pl", ".pm", ".t"]),
  plain("r", [".r", ".rmd"]),
  plain("zig", [".zig"]),
  plain("nim", [".nim", ".nims"]),
  plain("solidity", [".sol"]),
  plain("sql", [".sql"]),
  plain("html", [".html", ".htm"]),
  language("css", [".css"], "css", "generic"),
  plain("scss", [".scss", ".sass"]),
  plain("less", [".less"]),
  plain("graphql", [".graphql", ".gql"]),
  plain("protobuf", [".proto"]),
  plain("terraform", [".tf", ".tfvars"]),
  plain("json", [".json", ".jsonc"]),
  plain("yaml", [".yaml", ".yml"]),
  plain("toml", [".toml"]),
  plain("markdown", [".md", ".mdx"]),
];

const definitions = new Map<Language, LanguageDefinition>();
let extensions = new Map<string, Language>();

for (const definition of BUILTINS) definitions.set(definition.id, definition);
rebuildExtensions();

export function detectLanguage(path: string): Language {
  const lower = path.toLowerCase();
  // Compound suffixes require the longest match; the registry has been sorted by length during rebuilding.
  for (const [extension, id] of extensions) {
    if (lower.endsWith(extension)) return id;
  }
  return "other";
}

export function languageDefinition(language: Language): LanguageDefinition | undefined {
  return definitions.get(language);
}

export function languageDefinitions(): readonly LanguageDefinition[] {
  return [...definitions.values()];
}

/**
 * Register a third-party language. The ID must use the `custom:` namespace; the same ID or suffix will not be ignored silently.
 * Override existing languages to avoid changes in scan results caused by plugin loading order. Should be called before scanRepo.
 */
export function registerLanguage(definition: LanguageDefinition): void {
  if (!definition.id.startsWith("custom:") || definition.id.length === "custom:".length) {
    throw new Error("自定义语言 ID 必须使用 custom:<name> 格式");
  }
  if (definitions.has(definition.id)) throw new Error(`语言已注册：${definition.id}`);
  const normalized = normalizeDefinition(definition);
  for (const extension of normalized.extensions) {
    const owner = extensions.get(extension);
    if (owner) throw new Error(`扩展名 ${extension} 已属于 ${owner}`);
  }
  if ((normalized.grammar || normalized.grammarPath) && !normalized.extractor) {
    throw new Error("提供 grammar 时必须同时声明 extractor");
  }
  if (normalized.extractor && !normalized.grammar && !normalized.grammarPath && !normalized.embedded) {
    throw new Error("提供 extractor 时必须同时声明 grammar 或 grammarPath");
  }
  definitions.set(normalized.id, normalized);
  rebuildExtensions();
}

export function isAnalyzable(language: Language): language is AnalyzableLanguage {
  const definition = definitions.get(language);
  return Boolean(definition?.extractor && (definition.grammar || definition.grammarPath || definition.embedded));
}

export function grammarFor(language: AnalyzableLanguage): string {
  const definition = definitions.get(language);
  if (!definition?.grammar && !definition?.grammarPath) {
    throw new Error(`语言 ${language} 没有直接 grammar`);
  }
  return definition.grammar ?? language.replace(/^custom:/, "");
}

export function grammarPathFor(language: AnalyzableLanguage): string | undefined {
  return definitions.get(language)?.grammarPath;
}

export function extractorFamily(language: AnalyzableLanguage): ExtractorFamily {
  const family = definitions.get(language)?.extractor;
  if (!family) throw new Error(`语言 ${language} 没有抽取器`);
  return family;
}

export function resolverFamily(language: Language): ResolverFamily | undefined {
  return definitions.get(language)?.resolver;
}

function language(
  id: BuiltinLanguage,
  fileExtensions: readonly string[],
  grammar: string,
  extractor: ExtractorFamily,
  resolver?: ResolverFamily,
): LanguageDefinition {
  return normalizeDefinition({ id, extensions: fileExtensions, grammar, extractor, resolver });
}

function embedded(id: EmbeddedSourceKind, fileExtensions: readonly string[]): LanguageDefinition {
  // When directly calling ParserPool, the component's default scripting syntax is used; the scan path will still follow the lang attribute.
  // Switch to TypeScript/TSX. This way, the public contract of AnalyzableLanguage will not have the exception of being analyzable but without a grammar.
  const grammar = id === "astro" ? "typescript" : "javascript";
  return normalizeDefinition({
    id, extensions: fileExtensions, grammar, extractor: "ts", resolver: "ts", embedded: id,
  });
}

function plain(id: BuiltinLanguage, fileExtensions: readonly string[]): LanguageDefinition {
  return normalizeDefinition({ id, extensions: fileExtensions });
}

function normalizeDefinition(definition: LanguageDefinition): LanguageDefinition {
  const normalizedExtensions = [...new Set(definition.extensions.map((extension) => {
    const lower = extension.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  }))];
  if (normalizedExtensions.length === 0) throw new Error(`语言 ${definition.id} 没有扩展名`);
  return { ...definition, extensions: normalizedExtensions };
}

function rebuildExtensions(): void {
  extensions = new Map(
    [...definitions.values()]
      .flatMap((definition) => definition.extensions.map((extension) => [extension, definition.id] as const))
      .sort(([a], [b]) => b.length - a.length),
  );
}
