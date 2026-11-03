import type { Node as TsNode } from "web-tree-sitter";
import type { AnalyzableLanguage, ParsedFile } from "../../types.js";

export type { TsNode };

export interface ExtractInput {
  root: TsNode;
  /** Source code text, used to obtain the original signature text and document comments */
  source: string;
  language: AnalyzableLanguage;
  /** Relative path of the repository, Go/Rust module ownership determination requires it */
  path: string;
}

export interface LanguageExtractor {
  family: "ts" | "python" | "go" | "rust" | "generic";
  extract: (input: ExtractInput) => ParsedFile;
}

export function emptyParsedFile(hasError = false): ParsedFile {
  return {
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    entryHints: [],
    typeRelations: [],
    hasError,
  };
}
