import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language as TsLanguage, Parser } from "web-tree-sitter";
import type { AnalyzableLanguage } from "../types.js";
import { grammarFor, grammarPathFor } from "../discovery/language.js";

const require = createRequire(import.meta.url);

/**
 * tree-sitter parser pool.
 *
 * Grammar (Language) is loaded once and reused throughout, Parser instances are cached according to the grammar——
 * Every time a new Parser is created for parsing, the cost of wasm initialization is incurred repeatedly, which is considerable at the scale of 1,400 files.
 * The Tree object must be explicitly deleted, otherwise the wasm heap will keep growing.
 */
export class ParserPool {
  private initialized = false;
  private readonly languages = new Map<string, TsLanguage>();
  private readonly parsers = new Map<string, Parser>();
  private readonly failed = new Set<string>();

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    this.initialized = true;
  }

  async parserFor(language: AnalyzableLanguage): Promise<Parser | null> {
    const grammar = grammarFor(language);
    const source = grammarPathFor(language) ?? wasmPath(grammar);
    if (this.failed.has(source)) return null;

    const cached = this.parsers.get(source);
    if (cached) return cached;

    await this.init();

    try {
      let lang = this.languages.get(source);
      if (!lang) {
        lang = await TsLanguage.load(source);
        this.languages.set(source, lang);
      }
      const parser = new Parser();
      parser.setLanguage(lang);
      this.parsers.set(source, parser);
      return parser;
    } catch (err) {
      // The failure to load a single grammar should not cause the entire scan to fail; note it and skip that language.
      this.failed.add(source);
      process.emitWarning(
        `tree-sitter 语法 ${grammar} 加载失败，该语言将被跳过：${(err as Error).message}`,
      );
      return null;
    }
  }

  dispose(): void {
    for (const parser of this.parsers.values()) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }
}

function wasmPath(grammar: string): string {
  // Parse with package.json as the anchor to avoid depending on the internal export mappings of @vscode/tree-sitter-wasm
  const anchor = require.resolve("@vscode/tree-sitter-wasm/package.json");
  return join(dirname(anchor), "wasm", `tree-sitter-${grammar}.wasm`);
}
