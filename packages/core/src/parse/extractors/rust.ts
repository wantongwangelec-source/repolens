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
  ancestorOfType,
  attributeCalls,
  calleeAt,
  complexityOf,
  docCommentAbove,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  RUST_DECISIONS,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const COMMENT_TYPES = ["line_comment", "block_comment"] as const;

/** Candidate containers when looking for function ownership; hitting function_item/closure indicates this is a nested function, not a method */
const OWNER_TYPES = ["impl_item", "trait_item", "function_item", "closure_expression"] as const;

const DECLARED_TYPE_KINDS = new Set<SymbolKind>(["struct", "enum", "trait", "type"]);

/**
 * Rust extractor.
 *
 * The biggest difference from other languages is that the module tree is not implicitly determined by the directory structure, but is driven by `mod foo;` declarations.
 * Here, in addition to putting the name into `moduleDecls`, an extra `module-decl` ParsedImport is also produced.
 * Allow the module resolver to use the same path to resolve `mod foo;` to `foo.rs` / `foo/mod.rs`.
 */
export const rustExtractor: LanguageExtractor = {
  family: "rust",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const moduleDecls: string[] = [];
    const callSites: RawCallSite[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "use_declaration":
          collectUse(node, imports);
          return false;

        case "mod_item": {
          const name = fieldText(node, "name");
          if (name === null) return false;
          if (fieldNode(node, "body") === null) {
            moduleDecls.push(name);
            imports.push({
              source: `self::${name}`,
              kind: "module-decl",
              specifiers: [{ imported: "*", local: name, isNamespace: true }],
              line: lineOf(node),
            });
            return false;
          }
          symbols.push(declarationSymbol(node, "module", name));
          return true;
        }

        case "function_item":
        case "function_signature_item":
          symbols.push(functionSymbol(node));
          return true;

        case "struct_item":
        case "union_item":
          symbols.push(declarationSymbol(node, "struct"));
          return true;

        case "enum_item":
          symbols.push(declarationSymbol(node, "enum"));
          return true;

        case "trait_item":
          symbols.push(declarationSymbol(node, "trait"));
          collectSupertraits(node, typeRelations);
          return true;

        case "type_item":
          symbols.push(declarationSymbol(node, "type"));
          return true;

        case "impl_item":
          symbols.push(implSymbol(node));
          collectImplRelation(node, symbols, typeRelations);
          return true;

        case "const_item":
        case "static_item":
          symbols.push(declarationSymbol(node, "constant"));
          return true;

        case "call_expression":
          collectCall(node, callSites);
          return true;

        case "macro_invocation":
          collectMacro(node, callSites);
          // In token_tree, it is an unresolved token stream, not containing call_expression, so there is no need to delve deeper.
          return false;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: symbols
        .filter((s) => s.exported && s.container === undefined && s.kind !== "impl")
        .map((s): ParsedExport => ({ name: s.name, kind: "named", line: s.startLine })),
      calls: attributeCalls(symbols, callSites),
      typeRelations,
      moduleDecls,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

function functionSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const owner = ancestorOfType(node, OWNER_TYPES);
  const container = memberContainer(owner);

  return {
    name,
    kind: container === undefined ? "function" : "method",
    container,
    exported: isExported(node),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "return_type")),
    doc: docOf(node),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, RUST_DECISIONS),
    isAsync: firstOfType(node, "function_modifiers")?.text.includes("async") ?? false,
  };
}

function declarationSymbol(node: TsNode, kind: SymbolKind, nameOverride?: string): ParsedSymbol {
  return {
    name: nameOverride ?? fieldText(node, "name") ?? "<anonymous>",
    kind,
    exported: isExported(node),
    signature: signatureOf(node, ["body"]),
    doc: docOf(node),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

/** impl blocks have no name, use `Type` or `Trait for Type` as a readable identifier */
function implSymbol(node: TsNode): ParsedSymbol {
  const subject = typeNameOf(fieldNode(node, "type")) ?? "<unknown>";
  const trait = typeNameOf(fieldNode(node, "trait"));
  return {
    ...declarationSymbol(node, "impl", trait === undefined ? subject : `${trait} for ${subject}`),
    // The visibility of the impl block itself is meaningless; visibility is declared individually for each of its members.
    exported: false,
  };
}

function memberContainer(owner: TsNode | null): string | undefined {
  if (owner === null) return undefined;
  if (owner.type === "impl_item") return typeNameOf(fieldNode(owner, "type"));
  if (owner.type === "trait_item") return fieldText(owner, "name") ?? undefined;
  return undefined;
}

function isExported(node: TsNode): boolean {
  return firstOfType(node, "visibility_modifier") !== null;
}

/** `&mut Vec<T>` / `crate::a::Type<T>` → `Type` */
function typeNameOf(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const head = node.text.replace(/^[&*\s]+/, "").replace(/^\bmut\b\s*/, "").replace(/<.*$/s, "");
  const last = head
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .at(-1);
  return last === undefined || last.length === 0 ? undefined : last;
}

// ---------------------------------------------------------------------------
// Document Comment
// ---------------------------------------------------------------------------

/**
 * Rust documentation comments.
 *
 * The issue of counting line breaks as part of the comment node range has been normalized to the 'visual last line' in `docCommentAbove`.
 * Here, we only need to handle another thing unique to Rust: attributes like `#[derive(..)]` can be inserted between comments and
 * Interruption between declarations breaks the sibling chain, so first move the anchor point up to the topmost property.
 */
function docOf(node: TsNode): string | undefined {
  return docCommentAbove(attributeAnchor(node), COMMENT_TYPES);
}

function attributeAnchor(node: TsNode): TsNode {
  let anchor = node;
  for (;;) {
    const prev: TsNode | null = anchor.previousSibling;
    if (!prev || prev.type !== "attribute_item") return anchor;
    if (prev.endPosition.row !== anchor.startPosition.row - 1) return anchor;
    anchor = prev;
  }
}

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const child of namedChildren(paramsNode)) {
    switch (child.type) {
      case "parameter":
        out.push({
          name: normalizeWhitespace(fieldNode(child, "pattern")?.text ?? "_").slice(0, 120),
          type: annotationText(fieldNode(child, "type")),
          optional: false,
          variadic: false,
        });
        break;
      case "self_parameter":
        // `&self` / `&mut self` / `self`: The type information is right there in the original text
        out.push({ name: "self", type: normalizeWhitespace(child.text), optional: false, variadic: false });
        break;
      case "variadic_parameter":
        out.push({ name: "...", optional: false, variadic: true });
        break;
      default:
        break;
    }
  }
  return out;
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

// ---------------------------------------------------------------------------
// use declaration
// ---------------------------------------------------------------------------

interface UseLeaf {
  /** Complete path segments, such as '["crate","store","models","User"]' */
  segments: string[];
  alias?: string | undefined;
  wildcard?: boolean | undefined;
}

/**
 * Expand `use a::{b, c::d}` into a separate entry for each leaf.
 *
 * `source` only retains the module path (removing the last segment's symbol name), so the parser always receives
 * Things that can be written onto the file; the last paragraph is given to the symbol-level parser as a specifier.
 */
function collectUse(node: TsNode, out: ParsedImport[]): void {
  const argument = fieldNode(node, "argument");
  if (!argument) return;

  const line = lineOf(node);
  for (const leaf of useLeaves(argument, [])) {
    const binding = bindingOf(leaf);
    if (binding) out.push({ ...binding, kind: "static", line });
  }
}

/** Split the leaf path into two halves: 'module path' and 'binding name' */
function bindingOf(leaf: UseLeaf): Pick<ParsedImport, "source" | "specifiers"> | null {
  const last = leaf.segments.at(-1);
  if (last === undefined) return null;

  // Wildcard imports treat the entire path as a module path, with no symbol names that can be individually imported
  if (leaf.wildcard === true) {
    return {
      source: leaf.segments.join("::"),
      specifiers: [{ imported: "*", local: "*", isNamespace: true }],
    };
  }

  // `use foo;` and `use a::{self}` import the module itself, and similarly there are no symbol-level final segments
  if (last === "self" || leaf.segments.length === 1) {
    const segments = last === "self" ? leaf.segments.slice(0, -1) : leaf.segments;
    const name = segments.at(-1);
    if (name === undefined) return null;
    return {
      source: segments.join("::"),
      specifiers: [{ imported: "*", local: leaf.alias ?? name, isNamespace: true }],
    };
  }

  return {
    source: leaf.segments.slice(0, -1).join("::"),
    specifiers: [{ imported: last, local: leaf.alias ?? last }],
  };
}

function useLeaves(node: TsNode, prefix: readonly string[]): UseLeaf[] {
  switch (node.type) {
    case "scoped_use_list": {
      const path = [...prefix, ...pathSegments(fieldNode(node, "path"))];
      const list = fieldNode(node, "list");
      return list ? namedChildren(list).flatMap((item) => useLeaves(item, path)) : [];
    }
    case "use_list":
      return namedChildren(node).flatMap((item) => useLeaves(item, prefix));
    case "use_as_clause": {
      const path = fieldNode(node, "path");
      if (!path) return [];
      const alias = fieldText(node, "alias") ?? undefined;
      return useLeaves(path, prefix).map((leaf) => ({ ...leaf, alias }));
    }
    case "use_wildcard":
      return [{ segments: [...prefix, ...pathSegments(node)], wildcard: true }];
    case "scoped_identifier":
    case "identifier":
    case "crate":
    case "super":
    case "self":
      return [{ segments: [...prefix, ...pathSegments(node)] }];
    default:
      return [];
  }
}

/**
 * Split the path text by `::`.
 *
 * The path/name field is not recursive because the leading `::` (`use ::global::Thing`) is not present in the syntax tree.
 * The corresponding named node is complete only in the original text; empty sections and `*` can be discarded together.
 */
function pathSegments(node: TsNode | null): string[] {
  if (!node) return [];
  return node.text
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  // Explicit generic `parse::<u32>()`: the actual callee is on the function field of generic_function
  const target = fn.type === "generic_function" ? fieldNode(fn, "function") : fn;
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

  if (target.type === "scoped_identifier") {
    const segments = pathSegments(target);
    const callee = segments.at(-1);
    if (callee === undefined) return;
    // `Store::open()` is an associated function rather than an instance method, categorized as a regular call
    out.push({
      callee,
      receiver: segments.length > 1 ? segments.slice(0, -1).join("::") : undefined,
      calleePath: segments.length > 1 ? segments : undefined,
      line,
      argCount,
      argumentTexts: args,
      kind: "call",
      byte,
      endByte,
      ...calleeAt(target, callee),
    });
    return;
  }

  if (target.type === "field_expression") {
    const callee = fieldText(target, "field");
    if (callee === null) return;
    const value = fieldNode(target, "value");
    const path = dottedPath(target.text);
    out.push({
      callee,
      receiver: value ? normalizeWhitespace(value.text).slice(0, 120) : undefined,
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

function collectMacro(node: TsNode, out: RawCallSite[]): void {
  const macro = fieldNode(node, "macro");
  const callee = typeNameOf(macro);
  if (callee === undefined) return;
  const tree = firstOfType(node, "token_tree");
  out.push({
    callee,
    // token_tree does not have a parameter structure; it is approximated using named tokens (`,` is an anonymous node and is not counted)
    argCount: tree ? namedChildren(tree).length : 0,
    line: lineOf(node),
    kind: "macro",
    byte: node.startIndex,
    endByte: node.endIndex,
    ...calleeAt(macro ?? node, callee),
  });
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter(
    (c) => c.type !== "line_comment" && c.type !== "block_comment",
  ).length;
}

// ---------------------------------------------------------------------------
// Type relationship
// ---------------------------------------------------------------------------

function collectImplRelation(
  node: TsNode,
  known: readonly ParsedSymbol[],
  out: ParsedTypeRelation[],
): void {
  const traitNode = fieldNode(node, "trait");
  if (!traitNode) return;

  const subject = typeNameOf(fieldNode(node, "type"));
  const target = typeNameOf(traitNode);
  if (subject === undefined || target === undefined) return;

  out.push({
    subject,
    subjectKind: declaredKindOf(subject, known),
    relation: "implements",
    target,
    targetPath: qualifiedPath(traitNode),
    line: lineOf(node),
  });
}

function collectSupertraits(node: TsNode, out: ParsedTypeRelation[]): void {
  const subject = fieldText(node, "name");
  const bounds = fieldNode(node, "bounds");
  if (subject === null || !bounds) return;

  for (const bound of namedChildren(bounds)) {
    // Lifetime constraints (`'a`) and negative constraints (`?Sized`) are not parent traits
    if (bound.type === "lifetime" || bound.type === "removed_trait_bound") continue;
    const target = typeNameOf(bound);
    if (target === undefined) continue;
    out.push({
      subject,
      subjectKind: "trait",
      relation: "extends",
      target,
      targetPath: qualifiedPath(bound),
      line: lineOf(bound),
    });
  }
}

/** Limited paths, such as `serde::Serialize`; drop generic segments, single-segment paths return undefined if they carry no information */
function qualifiedPath(node: TsNode): string[] | undefined {
  const path = pathSegments(node).filter((s) => !s.includes("<"));
  return path.length > 1 ? path : undefined;
}

/**
 * The impl block only writes the type name, so you can't tell whether it's a struct or an enum.
 * Declarations are usually found in the same file; when not found, it falls back to `struct` (the most common case).
 */
function declaredKindOf(name: string, known: readonly ParsedSymbol[]): SymbolKind {
  const hit = known.find((s) => s.name === name && DECLARED_TYPE_KINDS.has(s.kind));
  return hit?.kind ?? "struct";
}
