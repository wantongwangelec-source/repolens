import type { ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from "../../types.js";
import {
  argumentTexts,
  attributeCalls,
  calleeAt,
  fieldNode,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const FUNCTION_TYPES = new Set([
  "function_declaration", "function_definition", "method_declaration",
  "method_definition", "constructor_declaration", "destructor_declaration",
  "local_function_statement", "singleton_method", "method",
  "function_statement",
]);

const TYPE_KINDS: Readonly<Record<string, SymbolKind>> = {
  class_declaration: "class",
  class_definition: "class",
  class: "class",
  class_specifier: "class",
  interface_declaration: "interface",
  interface: "interface",
  struct_specifier: "struct",
  enum_declaration: "enum",
  enum_specifier: "enum",
  namespace_definition: "module",
  module: "module",
};

const CALL_TYPES = new Set([
  "call_expression", "function_call_expression", "method_invocation",
  "invocation_expression", "member_call_expression",
  "call", "command",
]);

/**
 * Multilingual universal extractor. It only relies on node names that are relatively stable across grammars, preferring to extract less rather than more.
 * Guess the module's objective; the complete semantics should still be implemented by subsequent dedicated language plugins.
 */
export const genericExtractor: LanguageExtractor = {
  family: "generic",
  extract(input: ExtractInput): ParsedFile {
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const calls: RawCallSite[] = [];

    walk(input.root, (node) => {
      const typeKind = TYPE_KINDS[node.type];
      if (typeKind) {
        symbols.push(symbolOf(node, typeKind));
        return true;
      }
      if (FUNCTION_TYPES.has(node.type)) {
        const kind: SymbolKind = enclosingTypeName(node) || node.type.includes("method")
          || node.type.includes("constructor") || node.type.includes("destructor")
          ? "method"
          : "function";
        symbols.push(symbolOf(node, kind));
        return true;
      }
      if (isImportNode(node.type)) {
        const parsed = importOf(node);
        if (parsed) imports.push(parsed);
        return false;
      }
      const dependency = dependencyCallImport(node);
      if (dependency) {
        imports.push(dependency);
        return false;
      }
      // CSS's var() / calc() / rgba() are also call_expressions in the syntax tree, but they do not invoke any code
      if (CALL_TYPES.has(node.type) && input.language !== "css") {
        const call = callOf(node);
        if (call) calls.push(call);
      }
      return true;
    });

    return {
      symbols: dedupeSymbols(symbols),
      imports,
      exports: [],
      calls: attributeCalls(symbols, calls),
      typeRelations: [],
      hasError: input.root.hasError,
    };
  },
};

function symbolOf(node: TsNode, kind: SymbolKind): ParsedSymbol {
  const name = declarationName(node) ?? "<anonymous>";
  return {
    name,
    kind,
    container: kind === "method" ? enclosingTypeName(node) : undefined,
    exported: isPublic(node),
    signature: signatureOf(node, ["body", "block"]),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: genericComplexity(node),
  };
}

function declarationName(node: TsNode): string | null {
  const direct = fieldNode(node, "name");
  if (direct) return cleanIdentifier(direct.text);
  const declarator = fieldNode(node, "declarator");
  if (declarator) {
    let found: string | null = null;
    walk(declarator, (child) => {
      if (found) return false;
      if (isIdentifier(child.type)) { found = cleanIdentifier(child.text); return false; }
      return true;
    });
    if (found) return found;
  }
  const special = namedChildren(node).find((child) =>
    child.type === "function_name" || child.type === "method_name" || child.type === "command_name",
  );
  if (special) return cleanIdentifier(special.text);
  return firstIdentifier(node);
}

function enclosingTypeName(node: TsNode): string | undefined {
  let parent = node.parent;
  while (parent) {
    if (TYPE_KINDS[parent.type]) return declarationName(parent) ?? undefined;
    parent = parent.parent;
  }
  return undefined;
}

function callOf(node: TsNode): RawCallSite | null {
  const target = fieldNode(node, "function") ?? fieldNode(node, "name")
    ?? fieldNode(node, "method") ?? namedChildren(node)[0] ?? null;
  if (!target) return null;
  const text = normalizeWhitespace(target.text);
  const parts = text.split(/(?:\.|::|->)/).map(cleanIdentifier).filter(Boolean);
  const callee = parts.at(-1);
  if (!callee) return null;
  const args = fieldNode(node, "arguments") ?? fieldNode(node, "argument");
  return {
    callee,
    receiver: parts.length > 1 ? parts.slice(0, -1).join(".") : undefined,
    calleePath: parts.length > 1 ? parts : undefined,
    line: lineOf(node),
    argCount: args ? namedChildren(args).length : 0,
    argumentTexts: argumentTexts(args),
    kind: parts.length > 1 ? "method" : "call",
    byte: node.startIndex,
    endByte: node.endIndex,
    ...calleeAt(target, callee),
  };
}

function isImportNode(type: string): boolean {
  return type === "import_declaration" || type === "import_statement"
    || type === "using_directive" || type === "using_statement"
    || type === "preproc_include" || type === "namespace_use_declaration";
}

function importOf(node: TsNode): ParsedImport | null {
  let source: string;
  if (node.type === "preproc_include") {
    source = node.text.replace(/^\s*#\s*include\s*/, "");
  } else {
    source = node.text
      .replace(/^\s*(?:import\s+(?:static\s+)?|using\s+|use\s+)/i, "")
      .replace(/^namespace\s+/i, "");
  }
  source = source.replace(/[;\s]+$/g, "").replace(/^['"<]|['">]$/g, "").trim();
  if (!source || source.length > 500) return null;
  return { source, kind: "static", specifiers: [], line: lineOf(node) };
}

function dependencyCallImport(node: TsNode): ParsedImport | null {
  if (node.type !== "call" && node.type !== "command") return null;
  const text = node.text.trim();
  const match = /^(?:require|require_relative|load|source|\.)\s*(?:\(\s*)?["']?([^"'\s;)]+)["']?/i.exec(text);
  if (!match?.[1]) return null;
  return { source: match[1], kind: "require", specifiers: [], line: lineOf(node) };
}

function firstIdentifier(node: TsNode): string | null {
  let found: string | null = null;
  walk(node, (child) => {
    if (child !== node && isIdentifier(child.type)) {
      found = cleanIdentifier(child.text);
      return false;
    }
    return found ? false : true;
  });
  return found;
}

function isIdentifier(type: string): boolean {
  return type === "identifier" || type === "name" || type === "function_name"
    || type === "method_name" || type === "command_name" || type.endsWith("_identifier");
}

function cleanIdentifier(text: string): string {
  return text.trim().replace(/^[$@]+/, "").replace(/[^\p{L}\p{N}_$!?~-]+$/u, "").slice(0, 160);
}

function isPublic(node: TsNode): boolean {
  const head = node.text.slice(0, Math.min(160, node.text.length));
  return /\b(?:public|export)\b/.test(head) || !/\b(?:private|protected|internal)\b/.test(head);
}

function genericComplexity(node: TsNode): number {
  let value = 1;
  walk(node, (child) => {
    if (/^(?:if|else_if|for|while|case|catch|conditional|match)_/.test(`${child.type}_`)
      || ["if", "for", "while", "case", "catch"].includes(child.type)) value++;
    return true;
  });
  return value;
}

function dedupeSymbols(symbols: ParsedSymbol[]): ParsedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.container ?? ""}:${symbol.name}:${symbol.startByte}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
