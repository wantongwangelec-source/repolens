import type { Node as TsNode } from "web-tree-sitter";
import type { ControlBlock, ParsedCall } from "../types.js";
import { namedChildren, normalizeWhitespace } from "./ast-utils.js";

/** Function literals embedded in function bodies: callbacks, closures. Node names in the grammar of each language */
const FUNCTION_LITERALS: ReadonlySet<string> = new Set([
  "arrow_function", "function_expression", "function", "generator_function",
  "lambda",
  "func_literal",
  "closure_expression",
  "lambda_expression", "anonymous_method_expression",
  "anonymous_function_creation_expression", "anonymous_function",
]);

/** The symbol interval itself is a function definition: any function literals that appear inside it are all callbacks. */
const FUNCTION_DEFINITIONS: ReadonlySet<string> = new Set([
  ...FUNCTION_LITERALS,
  "function_declaration", "generator_function_declaration", "method_definition", "function_signature",
  "function_definition", "decorated_definition",
  "method_declaration", "constructor_declaration", "local_function_statement",
  "function_item",
]);

const LOOPS: ReadonlySet<string> = new Set([
  "for_statement", "for_in_statement", "while_statement", "do_statement",
  "for_expression", "while_expression", "loop_expression",
  "enhanced_for_statement", "foreach_statement", "for_range_loop",
]);

const CASES: ReadonlySet<string> = new Set([
  "switch_case", "expression_case", "type_case", "communication_case", "case_clause", "match_arm",
  "switch_block_statement_group", "switch_rule", "switch_section", "case_statement",
]);
const DEFAULT_CASES: ReadonlySet<string> = new Set(["switch_default", "default_case", "default_statement"]);

const SHORT_CIRCUIT = new Set(["&&", "||", "??", "and", "or"]);
const EXIT_STATEMENTS = /^(?:return_statement|throw_statement|raise_statement|break_statement|continue_statement|return_expression|break_expression|continue_expression)$/;
/** When calling these nodes wrapped on the outside, the return value is still considered unused: `await save()`、`f()?;`、`(g())` */
const TRANSPARENT = new Set(["await_expression", "parenthesized_expression", "try_expression", "non_null_expression"]);

const MAX_TEXT = 80;

/**
 * Add the control structure each call point is in and whether the return value is used.
 *
 * Like shape fingerprints, handle them uniformly in scanning, not scattered to each language extractor: the judgment relies only on field names in the syntax tree
 * (condition / consequence / alternative / body), these fields are in various tree-sitters
 * In grammar, it's called consistency of terms. Don't memorize structures you can't recognize; it's better to score fewer points in one group than to force a call into a branch you made up.
 */
export function attachControlFlow(root: TsNode, calls: ParsedCall[]): void {
  const ownerIsFunction = new Map<string, boolean>();
  for (const call of calls) {
    if (call.startByte === undefined) continue;
    const node = callNode(root, call.startByte, call.endByte);
    if (!node) continue;
    call.discarded = isDiscarded(node);
    if (call.ownerStartByte === undefined || call.ownerEndByte === undefined) continue;

    const ownerKey = `${call.ownerStartByte}:${call.ownerEndByte}`;
    let isFunction = ownerIsFunction.get(ownerKey);
    if (isFunction === undefined) {
      const owner = root.descendantForIndex(call.ownerStartByte, Math.max(call.ownerStartByte, call.ownerEndByte - 1));
      isFunction = owner !== null && FUNCTION_DEFINITIONS.has(owner.type);
      ownerIsFunction.set(ownerKey, isFunction);
    }
    const blocks = blocksAround(node, call.ownerStartByte, call.ownerEndByte, isFunction);
    if (blocks.length > 0) call.blocks = blocks;
  }
}

/** The extractor records the start and end bytes of the calling expression. From the leaf there, going upwards, the first one that covers the entire segment is it. */
function callNode(root: TsNode, start: number, end: number): TsNode | null {
  for (let node: TsNode | null = root.descendantForIndex(start, start); node; node = node.parent) {
    if (node.startIndex <= start && node.endIndex >= end) return node;
  }
  return null;
}

function isDiscarded(node: TsNode): boolean {
  let cursor = node.parent;
  while (cursor && TRANSPARENT.has(cursor.type)) cursor = cursor.parent;
  return cursor?.type === "expression_statement";
}

function blocksAround(call: TsNode, ownerStart: number, ownerEnd: number, ownerIsFunction: boolean): ControlBlock[] {
  const chain: TsNode[] = [];
  for (let node: TsNode | null = call; node; node = node.parent) {
    if (node.startIndex <= ownerStart && node.endIndex >= ownerEnd) break;
    chain.push(node);
  }
  // The symbol span of `const f = () => {…}` is the entire declaration, and the outermost arrow function inside it is f itself.
  // The things outside it (declarations, package calls) do not belong to the function body
  let outermost = chain.length - 1;
  if (!ownerIsFunction) {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (FUNCTION_LITERALS.has(chain[i]!.type)) {
        outermost = i - 1;
        break;
      }
    }
  }

  const blocks: ControlBlock[] = [];
  for (let i = outermost; i >= 1; i--) {
    const block = classify(chain[i]!, chain[i - 1]!);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** `child` is which part of `node`: the branch where the condition holds, the else, the loop body, the catch... if you can't recognize it, it doesn't count as a group */
type Classifier = (node: TsNode, child: TsNode) => ControlBlock | null;

function classify(node: TsNode, child: TsNode): ControlBlock | null {
  const type = node.type;
  if (CASES.has(type)) return caseBlock(node);
  if (DEFAULT_CASES.has(type)) return { b: node.startIndex, k: "case", t: "default", l: line(node) };
  if (LOOPS.has(type)) return loopBlock(node, child);
  if (FUNCTION_LITERALS.has(type)) return { b: node.startIndex, k: "callback", t: callbackOwner(node), l: line(node) };
  return CLASSIFIERS.get(type)?.(node, child) ?? null;
}

function ifBlock(node: TsNode, child: TsNode): ControlBlock | null {
  const consequence = node.childForFieldName("consequence") ?? node.childForFieldName("body");
  const condition = node.childForFieldName("condition");
  if (consequence && same(child, consequence)) {
    const exits = endsWithExit(consequence) && !hasElse(node);
    return { b: node.startIndex, k: "if", t: conditionText(condition), l: line(node), ...(exits ? { x: 1 as const } : {}) };
  }
  if (node.type !== "elif_clause" && isAlternative(node, child)) {
    return { b: child.startIndex, k: "else", t: conditionText(condition), l: line(child) };
  }
  return null;
}

function ternaryBlock(node: TsNode, child: TsNode): ControlBlock | null {
  const condition = node.childForFieldName("condition");
  const consequence = node.childForFieldName("consequence");
  const alternative = node.childForFieldName("alternative");
  if (!condition) return null;
  if (consequence && same(child, consequence)) return { b: node.startIndex, k: "if", t: conditionText(condition), l: line(node) };
  if (alternative && same(child, alternative)) return { b: alternative.startIndex, k: "else", t: conditionText(condition), l: line(alternative) };
  return null;
}

/** `a && f()` is called only when a is true; `a || f()` is called when a is false; `a ?? f()` is called when a is null. */
function shortCircuitBlock(node: TsNode, child: TsNode): ControlBlock | null {
  const operator = node.childForFieldName("operator")?.text;
  const right = node.childForFieldName("right");
  const left = node.childForFieldName("left");
  if (!operator || !SHORT_CIRCUIT.has(operator) || !right || !left || !same(child, right)) return null;
  const text = normalizeWhitespace(left.text);
  const condition = operator === "&&" || operator === "and" ? text : operator === "??" ? `${text} == null` : `!(${text})`;
  return { b: node.startIndex, k: "if", t: snippet(condition), l: line(node) };
}

function caseBlock(node: TsNode): ControlBlock {
  const value = node.childForFieldName("value") ?? node.childForFieldName("pattern");
  return { b: node.startIndex, k: "case", t: value ? snippet(value.text) : caseHead(node), l: line(node) };
}

function loopBlock(node: TsNode, child: TsNode): ControlBlock | null {
  const body = node.childForFieldName("body");
  if (!body || !same(child, body)) return null;
  return { b: node.startIndex, k: "loop", t: snippet(node.text.slice(0, body.startIndex - node.startIndex)), l: line(node) };
}

function tryBlock(node: TsNode, child: TsNode): ControlBlock | null {
  const body = node.childForFieldName("body");
  if (body && same(child, body)) return { b: node.startIndex, k: "try", l: line(node) };
  if (child.type === "catch_clause" || child.type === "except_clause") {
    const parameter = child.childForFieldName("parameter");
    return { b: child.startIndex, k: "catch", t: parameter ? snippet(parameter.text) : catchHead(child), l: line(child) };
  }
  if (child.type === "finally_clause") return { b: child.startIndex, k: "finally", l: line(child) };
  return null;
}

const CLASSIFIERS = new Map<string, Classifier>([
  ["if_statement", ifBlock],
  ["if_expression", ifBlock],
  ["elif_clause", ifBlock],
  ["ternary_expression", ternaryBlock],
  ["conditional_expression", ternaryBlock],
  ["binary_expression", shortCircuitBlock],
  ["boolean_operator", shortCircuitBlock],
  ["try_statement", tryBlock],
  ["defer_statement", (node) => ({ b: node.startIndex, k: "defer", t: "defer", l: line(node) })],
  ["go_statement", (node) => ({ b: node.startIndex, k: "callback", t: "go", l: line(node) })],
]);

/** Who the callback is passed to: in `list.map((x) => …)` it's map, in `useEffect(() => …)` it's useEffect */
function callbackOwner(fn: TsNode): string | undefined {
  const args = fn.parent;
  if (!args || !/^(?:arguments|argument_list)$/.test(args.type)) return undefined;
  const call = args.parent;
  const callee = call?.childForFieldName("function") ?? call?.childForFieldName("name");
  if (!callee) return undefined;
  const parts = callee.text.split(/[.:]+/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1)?.slice(0, MAX_TEXT);
}

function hasElse(node: TsNode): boolean {
  if (node.childForFieldName("alternative")) return true;
  return namedChildren(node).some((child) => child.type === "else_clause" || child.type === "elif_clause");
}

function isAlternative(node: TsNode, child: TsNode): boolean {
  const alternative = node.childForFieldName("alternative");
  if (alternative && same(child, alternative)) return true;
  // Python's if can have multiple elif / else, but the field name only gets the first one
  return child.type === "else_clause" || child.type === "elif_clause";
}

/** The last sentence of the branch is return / throw / break / continue */
function endsWithExit(node: TsNode): boolean {
  if (EXIT_STATEMENTS.test(node.type)) return true;
  if (node.type === "expression_statement") {
    const inner = node.namedChild(0);
    return inner !== null && EXIT_STATEMENTS.test(inner.type);
  }
  const last = namedChildren(node).filter((child) => !child.type.includes("comment")).at(-1);
  return last !== undefined && last !== node && endsWithExit(last);
}

function conditionText(condition: TsNode | null): string | undefined {
  if (!condition) return undefined;
  let text = normalizeWhitespace(condition.text);
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();
  return snippet(text);
}

function caseHead(node: TsNode): string | undefined {
  const head = node.text.split(/[:{\n]/)[0]?.replace(/^\s*(case|when)\s+/i, "");
  return head ? snippet(head) : undefined;
}

function catchHead(node: TsNode): string | undefined {
  const head = node.text.split(/[:{\n]/)[0]?.replace(/^\s*(catch|except)\s*/i, "").replace(/^\(|\)$/g, "");
  return head ? snippet(head) : undefined;
}

function same(a: TsNode, b: TsNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

function snippet(text: string): string | undefined {
  const clean = normalizeWhitespace(text);
  if (clean === "") return undefined;
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

function line(node: TsNode): number {
  return node.startPosition.row + 1;
}
