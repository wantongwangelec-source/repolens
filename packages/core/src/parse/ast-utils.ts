import type { Node as TsNode } from "web-tree-sitter";
import type { CallKind, ParsedCall, ParsedSymbol } from "../types.js";

/** Depth-first pre-order traversal; if the visitor returns false, it means not to go deeper into that node */
export function walk(node: TsNode, visitor: (n: TsNode) => boolean | void): void {
  const stack: TsNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TsNode;
    if (visitor(current) === false) continue;
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      const child = current.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** Traverse all child nodes that contain anonymous nodes, and this is necessary when taking modifiers/keywords */
export function walkAll(node: TsNode, visitor: (n: TsNode) => boolean | void): void {
  const stack: TsNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TsNode;
    if (visitor(current) === false) continue;
    for (let i = current.childCount - 1; i >= 0; i--) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
}

export function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/**
 * Source code text of the call parameters. Keep only the first 12 items, with a maximum of 240 characters per item: route path and handler name
 * Usually at the front, setting a limit can prevent large object literals from being copied into SQLite.
 */
export function argumentTexts(
  argsNode: TsNode | null,
  commentTypes: ReadonlySet<string> = new Set(["comment", "line_comment", "block_comment"]),
): string[] {
  if (!argsNode) return [];
  return namedChildren(argsNode)
    .filter((child) => !commentTypes.has(child.type))
    .slice(0, 12)
    .map((child) => {
      const text = normalizeWhitespace(child.text);
      // Make SQL literals a bit longer: which table is read and written is often written after a long list of column names
      return text.slice(0, SQL_LITERAL.test(text) ? 4000 : 240);
    });
}

/** String literal starting with an SQL keyword */
export const SQL_LITERAL = /^(?:[a-zA-Z]{0,2}["'`]{1,3}|r#*")\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|MERGE)\b/i;

export function childrenOfType(node: TsNode, type: string): TsNode[] {
  return namedChildren(node).filter((c) => c.type === type);
}

export function firstOfType(node: TsNode, ...types: string[]): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

export function fieldNode(node: TsNode, field: string): TsNode | null {
  return node.childForFieldName(field) ?? null;
}

export function fieldText(node: TsNode, field: string): string | null {
  return node.childForFieldName(field)?.text ?? null;
}

/** 1-based line number */
export function lineOf(node: TsNode): number {
  return node.startPosition.row + 1;
}

/** Find the nearest ancestor of the specified type */
export function ancestorOfType(node: TsNode, types: readonly string[]): TsNode | null {
  let current: TsNode | null = node.parent;
  while (current) {
    if (types.includes(current.type)) return current;
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signatures and Documents
// ---------------------------------------------------------------------------

const MAX_SIGNATURE = 400;

/**
 * Get the original text of the function declaration signature: the text from the start of the declaration to the start of the function body.
 * Using the original text directly instead of reassembling it is to preserve the developer-written type annotations in their original form in the detail panel.
 */
export function signatureOf(node: TsNode, bodyFields: readonly string[] = ["body"]): string {
  let bodyStart = node.endIndex;
  for (const field of bodyFields) {
    const body = node.childForFieldName(field);
    if (body) {
      bodyStart = Math.min(bodyStart, body.startIndex);
    }
  }
  const raw = node.text.slice(0, bodyStart - node.startIndex);
  return normalizeWhitespace(raw).slice(0, MAX_SIGNATURE);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Collect the comment block immediately above the statement.
 *
 * The criterion for determining 'immediately adjacent' is consecutive line numbers: if there is an empty line in between, the comment is considered not to belong to this declaration.
 * This is consistent with the documentation comment conventions of most languages, and also avoids mistakenly attaching the file header comment to the first function.
 */
export function docCommentAbove(node: TsNode, commentTypes: readonly string[]): string | undefined {
  const lines: string[] = [];
  let cursor: TsNode | null = node.previousSibling;
  let expectedEndRow = node.startPosition.row - 1;

  while (cursor && commentTypes.includes(cursor.type)) {
    if (visualEndRow(cursor) !== expectedEndRow) break;
    lines.unshift(cursor.text);
    expectedEndRow = cursor.startPosition.row - 1;
    cursor = cursor.previousSibling;
  }

  if (lines.length === 0) return undefined;
  return cleanComment(lines.join("\n")).slice(0, 1000) || undefined;
}

/**
 * The last line in the visual of the node.
 *
 * When a range ends at column 0 of a certain line, it actually ends at the end of the previous line — tree-sitter-rust's
 * `line_comment` counts the newline at the end of the line as part of its own range. Just use `endPosition.row`
 * Comparison will cause the line number adjacency judgment of `///` documentation comments to never hold, resulting in the entire crate's documentation being lost.
 * Comment nodes in other languages do not contain line breaks, so this normalization is identical for them.
 */
function visualEndRow(node: TsNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

export function cleanComment(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\*\s?/, "")
        .replace(/^\s*\/\/\/?\s?/, "")
        .replace(/^\s*#\s?/, "")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}

/** Python docstring: The first statement in the function body is a string literal */
export function pythonDocstring(bodyNode: TsNode | null): string | undefined {
  if (!bodyNode) return undefined;
  const first = bodyNode.namedChild(0);
  if (!first) return undefined;
  const expr = first.type === "expression_statement" ? first.namedChild(0) : first;
  if (!expr || expr.type !== "string") return undefined;
  return expr.text
    .replace(/^[rubfRUBF]*("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "")
    .trim()
    .slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Complexity
// ---------------------------------------------------------------------------

/**
 * Cyclomatic complexity approximation: count of branch nodes + 1.
 *
 * Not aiming for exact consistency with any tool — the only purpose of this number is to do heat sorting on the directory tree,
 * Let the user see the most complex parts first. Relative size being correct is enough.
 */
export function complexityOf(node: TsNode, decisionTypes: ReadonlySet<string>): number {
  let count = 1;
  walk(node, (n) => {
    if (decisionTypes.has(n.type)) count++;
  });
  return count;
}

// ---------------------------------------------------------------------------
// Structural fingerprint
// ---------------------------------------------------------------------------

/**
 * These node types carry names and literals, which are the parts that 'change a little and become different.'
 * When calculating shapes, collapse them into a placeholder; only copies with renamed pasted will have the same fingerprint.
 */
const OPAQUE_NODES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "statement_identifier",
  "package_identifier",
  "label_name",
  "string",
  "string_literal",
  "raw_string_literal",
  "interpreted_string_literal",
  "template_string",
  "number",
  "integer",
  "integer_literal",
  "float",
  "float_literal",
  "char_literal",
  "true",
  "false",
  "none",
  "null",
  "nil",
  "undefined",
  "comment",
  "line_comment",
  "block_comment",
]);

/**
 * Structural fingerprint of symbols: only retain the skeleton of AST node types.
 *
 * The reason for its existence is that AI-written code has a characteristic flaw—it handles the same logic differently depending on the language and the scenario.
 * Generate each one separately, rather than extracting them to share. Using the name repeatedly for matching is inaccurate (because of the `main` with the same name).
 * They are often unrelated, and copying and pasting after changing the name can still miss things), using the original text hash also can't catch it (change a variable name
 * Just different). Only the shape happens to fall in the middle: the control flow is the same, so it counts as the same implementation.
 *
 * Use parentheses to record the hierarchy, otherwise `if{a;b}` and `if{a};b` will collapse into the same string.
 */
export function attachShapes(root: TsNode, symbols: ParsedSymbol[]): void {
  for (const sym of symbols) {
    // Take the smallest node that exactly covers the byte range of the symbol, which is its declaration node itself
    const node = root.descendantForIndex(sym.startByte, sym.endByte - 1);
    sym.shape = node ? shapeOf(node) : null;
  }
}

/** Declaration nodes with only signatures and no implementations */
const SIGNATURE_NODES: ReadonlySet<string> = new Set([
  "function_signature", "method_signature", "abstract_method_signature",
  "function_signature_item", "method_spec", "method_elem",
]);

/**
 * Methods in interfaces, overload declarations, and trait method signatures are also function/method symbols, but they do not have readable implementations:
 * When counting 'how many functions are tested,' they should be excluded, otherwise an interface could magically add a dozen or so functions that are never testable.
 */
export function attachDeclarationOnly(root: TsNode, symbols: ParsedSymbol[]): void {
  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    const node = root.descendantForIndex(sym.startByte, Math.max(sym.startByte, sym.endByte - 1));
    if (node && SIGNATURE_NODES.has(node.type)) sym.declarationOnly = true;
  }
}

export function shapeOf(node: TsNode): string {
  const parts: string[] = [];
  const visit = (n: TsNode): void => {
    if (OPAQUE_NODES.has(n.type)) {
      parts.push("_");
      return;
    }
    parts.push(n.type, "(");
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) visit(child);
    }
    parts.push(")");
  };
  visit(node);
  return parts.join("");
}

export const TS_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
  // `&&` / `||` also contribute branches, but they are binary_expressions with an operator field,
  // Including the entire category would seriously overestimate, so this part of the accuracy is abandoned here.
]);

export const PY_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
  "match_statement",
  "case_clause",
  "boolean_operator",
  "assert_statement",
]);

export const GO_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "expression_case",
  "type_case",
  "select_statement",
  "communication_case",
]);

export const RUST_DECISIONS: ReadonlySet<string> = new Set([
  "if_expression",
  "if_let_expression",
  "while_expression",
  "while_let_expression",
  "for_expression",
  "loop_expression",
  "match_arm",
  "try_expression",
]);

// ---------------------------------------------------------------------------
// Call site ownership
// ---------------------------------------------------------------------------

export interface RawCallSite {
  callee: string;
  receiver?: string | undefined;
  receiverType?: string | undefined;
  calleePath?: string[] | undefined;
  line: number;
  argCount: number;
  argumentTexts?: string[] | undefined;
  kind: CallKind;
  /** The byte offset of the call point in the file, used to locate the corresponding symbol */
  byte: number;
  /** The ending byte of the invoked expression; the actual argument ends before the outer call ends, and its order determines the evaluation sequence. */
  endByte: number;
  /** The line where the renamed variable is located; in multi-line chained calls, it is different from line (the starting line of the entire expression) */
  nameLine: number;
  /** The adjusted name is in the starting column of the line, UTF-16 offset */
  nameColumn: number;
}

/**
 * The location of the renamed identifier in the source code: look from the rightmost side of the target subtree to the left and find the first leaf whose text equals callee.
 * web-tree-sitter parses according to JS strings, columns are UTF-16 offsets, and strings cut by lines on the front end can be used directly.
 */
export function calleeAt(target: TsNode, callee: string): Pick<RawCallSite, "nameLine" | "nameColumn"> {
  // Return to the target starting point when not found (for example, if the name has been rewritten by cleanIdentifier); the limit prevents repeatedly taking large callbacks in long chains.
  let budget = 64;
  const visit = (node: TsNode): TsNode | null => {
    if (budget-- <= 0) return null;
    if (node.childCount === 0) return node.text === callee ? node : null;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      const hit = child ? visit(child) : null;
      if (hit) return hit;
    }
    return null;
  };
  const hit = visit(target) ?? target;
  return { nameLine: hit.startPosition.row + 1, nameColumn: hit.startPosition.column };
}

/**
 * Attribute the call site to the innermost symbol that contains it.
 *
 * The extractor is only responsible for finding the call points, and the attribution is handled here: this way, each language does not have to implement it repeatedly.
 * The state tracking of 'which function am I in now' also avoids ownership errors caused by nested closures.
 */
export function attributeCalls(symbols: readonly ParsedSymbol[], sites: readonly RawCallSite[]): ParsedCall[] {
  const callable = symbols
    .filter((s) => s.kind === "function" || s.kind === "method")
    .slice()
    // Sort in ascending order by interval length, the first one that hits is the innermost layer
    .sort((a, b) => a.endByte - a.startByte - (b.endByte - b.startByte));

  return sites.map((site) => {
    const owner = callable.find((s) => site.byte >= s.startByte && site.byte < s.endByte);
    return {
      callerName: owner?.name ?? null,
      callerContainer: owner?.container,
      callee: site.callee,
      receiver: site.receiver,
      receiverType: site.receiverType,
      calleePath: site.calleePath,
      line: site.line,
      endByte: site.endByte,
      nameLine: site.nameLine,
      nameColumn: site.nameColumn,
      argCount: site.argCount,
      argumentTexts: site.argumentTexts,
      kind: site.kind,
      startByte: site.byte,
      ownerStartByte: owner?.startByte,
      ownerEndByte: owner?.endByte,
    };
  });
}

/** Break a member expression in the form of `a.b.c` into path segments */
export function dottedPath(text: string): string[] {
  return normalizeWhitespace(text)
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z_$][\w$]*$/.test(s));
}
