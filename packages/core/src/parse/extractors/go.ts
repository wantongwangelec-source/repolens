import type {
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedParam,
  ParsedSymbol,
  ParsedTypeRelation,
  SymbolKind,
} from "../../types.js";
import {
  argumentTexts,
  attributeCalls,
  calleeAt,
  childrenOfType,
  complexityOf,
  docCommentAbove,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  GO_DECISIONS,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const COMMENT_TYPES = ["comment"] as const;

/** Document comments may be attached to the spec itself, or they may be attached to the declaration that wraps it. */
const SPEC_WRAPPERS = new Set([
  "type_declaration",
  "const_declaration",
  "var_declaration",
  "var_spec_list",
  "const_spec_list",
]);

/**
 * Go extractor.
 *
 * The visibility in Go is entirely determined by the capitalization of the first letter, without an export statement, so `exports` is directly determined by
 * Derived from exported symbols, no separate grammar branch is needed.
 */
export const goExtractor: LanguageExtractor = {
  family: "go",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const callSites: RawCallSite[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "import_declaration":
          collectImports(node, imports);
          return false;

        case "function_declaration":
          symbols.push(functionSymbol(node));
          return true;

        case "method_declaration":
          symbols.push(methodSymbol(node));
          return true;

        case "type_declaration":
          collectTypes(node, symbols, typeRelations);
          return true;

        case "const_declaration":
          collectValues(node, symbols, "constant");
          return true;

        case "var_declaration":
          collectValues(node, symbols, "variable");
          return true;

        case "call_expression":
          collectCall(node, callSites);
          return true;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: symbols
        .filter((s) => s.exported && s.container === undefined)
        .map((s): ParsedExport => ({ name: s.name, kind: "named", line: s.startLine })),
      calls: attributeCalls(symbols, callSites),
      typeRelations,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// Functions and Methods
// ---------------------------------------------------------------------------

function functionSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  return {
    name,
    kind: "function",
    exported: isExported(name),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "result")),
    doc: docCommentAbove(node, COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, GO_DECISIONS),
  };
}

function methodSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const receiverType = receiverTypeOf(node);
  return {
    name,
    kind: "method",
    container: receiverType === undefined ? undefined : baseTypeName(receiverType),
    exported: isExported(name),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "result")),
    doc: docCommentAbove(node, COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, GO_DECISIONS),
    receiverType,
  };
}

function receiverTypeOf(node: TsNode): string | undefined {
  const receiver = fieldNode(node, "receiver");
  if (!receiver) return undefined;
  const declaration = firstOfType(receiver, "parameter_declaration");
  if (!declaration) return undefined;
  const type = fieldNode(declaration, "type");
  return type ? normalizeWhitespace(type.text) : undefined;
}

/** `*Server` / `Server[T]` → `Server`: the container name must match the type declaration name */
function baseTypeName(text: string): string {
  return text.replace(/^[*&\s]+/, "").replace(/\[.*$/s, "").trim();
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// Type / Constant / Variable Declaration
// ---------------------------------------------------------------------------

function collectTypes(
  declaration: TsNode,
  symbols: ParsedSymbol[],
  relations: ParsedTypeRelation[],
): void {
  for (const spec of namedChildren(declaration)) {
    if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
    const name = fieldText(spec, "name");
    if (name === null) continue;

    const typeNode = fieldNode(spec, "type");
    const kind = spec.type === "type_alias" ? "type" : typeKindOf(typeNode);

    symbols.push({
      name,
      kind,
      exported: isExported(name),
      // type_spec does not have a body field, signatureOf will return the entire original text—for structs
      // Displaying the field list together is actually more useful, and the overly long parts are truncated by signatureOf itself.
      signature: signatureOf(spec, ["body"]),
      doc: docOf(spec),
      startLine: lineOf(spec),
      endLine: spec.endPosition.row + 1,
      startByte: spec.startIndex,
      endByte: spec.endIndex,
      complexity: 1,
    });

    if (typeNode) collectEmbeds(name, typeNode, relations);
  }
}

function typeKindOf(typeNode: TsNode | null): SymbolKind {
  if (!typeNode) return "type";
  if (typeNode.type === "struct_type") return "struct";
  if (typeNode.type === "interface_type") return "interface";
  return "type";
}

/** Only top-level const/var are collected: local declarations inside function bodies are not architectural information */
function collectValues(declaration: TsNode, symbols: ParsedSymbol[], kind: SymbolKind): void {
  if (declaration.parent?.type !== "source_file") return;

  for (const spec of specsOf(declaration)) {
    for (const nameNode of fieldNodes(spec, "name")) {
      const name = nameNode.text;
      symbols.push({
        name,
        kind,
        exported: isExported(name),
        signature: normalizeWhitespace(spec.text).slice(0, 200),
        doc: docOf(spec),
        startLine: lineOf(spec),
        endLine: spec.endPosition.row + 1,
        startByte: spec.startIndex,
        endByte: spec.endIndex,
        complexity: 1,
      });
    }
  }
}

/** The spec of `const A = 1` is the direct child node of the declaration, while `const ( ... )` may have an additional layer of spec_list. */
function specsOf(declaration: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const child of namedChildren(declaration)) {
    if (child.type === "const_spec" || child.type === "var_spec") out.push(child);
    else if (child.type === "const_spec_list" || child.type === "var_spec_list") {
      out.push(...namedChildren(child).filter((c) => c.type === "const_spec" || c.type === "var_spec"));
    }
  }
  return out;
}

function docOf(spec: TsNode): string | undefined {
  const own = docCommentAbove(spec, COMMENT_TYPES);
  if (own !== undefined) return own;

  // The comment `// Doc` + `type X struct{}` is a sibling of type_declaration, not of type_spec.
  let cursor: TsNode | null = spec.parent;
  while (cursor && SPEC_WRAPPERS.has(cursor.type)) {
    const inherited = docCommentAbove(cursor, COMMENT_TYPES);
    if (inherited !== undefined) return inherited;
    cursor = cursor.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const declaration of namedChildren(paramsNode)) {
    const variadic = declaration.type === "variadic_parameter_declaration";
    if (!variadic && declaration.type !== "parameter_declaration") continue;

    const type = annotationText(fieldNode(declaration, "type"));
    const names = fieldNodes(declaration, "name");

    // A declaration like `func f(int, error)` that only has types without names (commonly seen in return value lists)
    if (names.length === 0) {
      out.push({ name: "_", type, optional: false, variadic });
      continue;
    }
    // `a, b int` are two parameters in a declaration and must be expanded
    for (const nameNode of names) {
      out.push({ name: nameNode.text, type, optional: false, variadic });
    }
  }
  return out;
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

/**
 * Get all values of the fields with the same name.
 *
 * tree-sitter will also mark the commas in `a, b int` as `name` fields, so anonymous nodes must be skipped.
 */
function fieldNodes(node: TsNode, field: string): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) !== field) continue;
    const child = node.child(i);
    if (child?.isNamed) out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

function collectImports(declaration: TsNode, out: ParsedImport[]): void {
  walk(declaration, (node) => {
    if (node.type !== "import_spec") return true;

    const source = unquote(fieldNode(node, "path"));
    if (source === null) return false;

    const alias = fieldNode(node, "name")?.text;
    out.push({
      source,
      // `import _ "driver"` is only to trigger init(), with no symbol-level dependencies
      kind: alias === "_" ? "side-effect" : "static",
      specifiers: [{ imported: "*", local: alias ?? lastSegment(source), isNamespace: true }],
      line: lineOf(node),
    });
    return false;
  });
}

function unquote(node: TsNode | null): string | null {
  if (!node) return null;
  const text = node.text;
  if (text.length < 2) return null;
  const quote = text[0];
  if (quote !== '"' && quote !== "`") return null;
  return text.slice(1, -1);
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  // `f[int](x)` will be parsed by the syntax as a type_conversion_expression rather than a call_expression,
  // Generic function calls in Go naturally cannot be caught; `handlers[i](x)` is the same, don't try to guess.
  const target = fieldNode(node, "function");
  if (!target) return;

  const argCount = countArgs(fieldNode(node, "arguments"));
  const args = argumentTexts(fieldNode(node, "arguments"));
  const line = lineOf(node);
  const byte = node.startIndex;
  const endByte = node.endIndex;

  if (target.type === "identifier") {
    out.push({
      callee: target.text, line, argCount, argumentTexts: args, kind: "call", byte, endByte,
      ...calleeAt(target, target.text),
    });
    return;
  }

  if (target.type === "selector_expression") {
    const callee = fieldText(target, "field");
    if (callee === null) return;
    const operand = fieldNode(target, "operand");
    const path = dottedPath(target.text);
    // `pkg.Func()` and `obj.Method()` are syntactically similar, and they cannot be distinguished during the extraction phase.
    // Truthfully record the receiver, leaving disambiguation to the link stage (only then is the import table and symbol table available)
    out.push({
      callee,
      receiver: operand ? normalizeWhitespace(operand.text).slice(0, 120) : undefined,
      calleePath: path.length > 1 ? path : undefined,
      line,
      argCount,
      argumentTexts: args,
      kind: "method",
      byte,
      endByte,
      ...calleeAt(target, callee),
    });
  }
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter((c) => c.type !== "comment").length;
}

// ---------------------------------------------------------------------------
// Embedding relationship
// ---------------------------------------------------------------------------

function collectEmbeds(subject: string, typeNode: TsNode, out: ParsedTypeRelation[]): void {
  if (typeNode.type === "struct_type") {
    const fields = firstOfType(typeNode, "field_declaration_list");
    if (!fields) return;
    for (const field of childrenOfType(fields, "field_declaration")) {
      // An anonymous field is an embedding: it has only a type and no name
      if (fieldNodes(field, "name").length > 0) continue;
      pushEmbed(subject, "struct", fieldNode(field, "type"), field, out);
    }
    return;
  }

  if (typeNode.type === "interface_type") {
    for (const elem of childrenOfType(typeNode, "type_elem")) {
      const parts = namedChildren(elem);
      // A type set constraint (`int | ~string`) is not an interface embedding and only accepts a single named type
      if (parts.length !== 1) continue;
      pushEmbed(subject, "interface", parts[0] ?? null, elem, out);
    }
  }
}

const EMBEDDABLE_TYPES = new Set(["type_identifier", "qualified_type", "generic_type"]);

function pushEmbed(
  subject: string,
  subjectKind: SymbolKind,
  typeNode: TsNode | null,
  lineNode: TsNode,
  out: ParsedTypeRelation[],
): void {
  if (!typeNode || !EMBEDDABLE_TYPES.has(typeNode.type)) return;
  const path = dottedPath(typeNode.text.replace(/^[*&\s]+/, "").replace(/\[.*$/s, ""));
  const target = path.at(-1);
  if (target === undefined) return;

  out.push({
    subject,
    subjectKind,
    relation: "embeds",
    target,
    targetPath: path.length > 1 ? path : undefined,
    line: lineOf(lineNode),
  });
}
