import type {
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedImportSpecifier,
  ParsedParam,
  ParsedSymbol,
  ParsedTypeRelation,
} from "../../types.js";
import {
  ancestorOfType,
  argumentTexts,
  attributeCalls,
  calleeAt,
  complexityOf,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  PY_DECISIONS,
  pythonDocstring,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

/** Determine the naming conventions for top-level constants; allow leading underscores to identify private constants */
const CONSTANT_NAME = /^_*[A-Z][A-Z0-9_]*$/;

/** When looking for the nearest 'enclosing container', only these three types are recognized: functions inside a class are methods, functions inside a function are not. */
const OWNER_TYPES = ["class_definition", "function_definition", "lambda"] as const;

/**
 * Python extractor.
 *
 * Python does not have an export syntax; visibility can only be inferred by convention: first trust `__all__`,
 * When `__all__` is not present, it falls back to the underscore prefix convention. Both only constrain top-level module symbols,
 * All class members should use the underscore rule (`__all__` does not semantically apply to class members).
 */
export const pythonExtractor: LanguageExtractor = {
  family: "python",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const dunderAll = readDunderAll(root);

    const symbols: ParsedSymbol[] = [];
    const moduleLevel: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const callSites: RawCallSite[] = [];
    const entryHints: NonNullable<ParsedFile["entryHints"]> = [];

    const record = (symbol: ParsedSymbol, isModuleLevel: boolean): void => {
      symbols.push(symbol);
      if (isModuleLevel) moduleLevel.push(symbol);
    };

    walk(root, (node) => {
      switch (node.type) {
        case "import_statement":
          collectImport(node, imports);
          return false;

        case "import_from_statement":
          collectImportFrom(node, imports);
          return false;

        // The `@app.route(...)` in a decorator is metadata rather than a runtime invocation edge.
        case "decorator":
          return false;

        case "function_definition": {
          const owner = ancestorOfType(node, OWNER_TYPES);
          record(functionSymbol(node, owner, dunderAll), owner === null);
          collectRouteHints(node, entryHints);
          return true;
        }

        case "class_definition": {
          const owner = ancestorOfType(node, OWNER_TYPES);
          record(classSymbol(node, owner, dunderAll), owner === null);
          collectBases(node, typeRelations);
          return true;
        }

        case "assignment": {
          const symbol = constantSymbol(node, dunderAll);
          if (symbol) record(symbol, true);
          return true;
        }

        case "call":
          collectCall(node, callSites);
          return true;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: buildExports(moduleLevel, dunderAll, root),
      calls: attributeCalls(symbols, callSites),
      entryHints,
      typeRelations,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

function functionSymbol(
  node: TsNode,
  owner: TsNode | null,
  dunderAll: ReadonlySet<string> | null,
): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const container = containerName(owner);
  const decorators = decoratorNames(node);

  return {
    name,
    kind: container === undefined ? "function" : "method",
    container,
    exported: isExported(name, owner === null, dunderAll),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "return_type")),
    doc: pythonDocstring(fieldNode(node, "body")),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, PY_DECISIONS),
    isAsync: node.text.startsWith("async"),
    isStatic: decorators.includes("staticmethod") || decorators.includes("classmethod"),
  };
}

function classSymbol(
  node: TsNode,
  owner: TsNode | null,
  dunderAll: ReadonlySet<string> | null,
): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  return {
    name,
    kind: "class",
    container: containerName(owner),
    exported: isExported(name, owner === null, dunderAll),
    signature: signatureOf(node, ["body"]),
    doc: pythonDocstring(fieldNode(node, "body")),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

/** Only accept assignments to uppercase names at the top level of the module: local variables inside function bodies are not architectural information */
function constantSymbol(node: TsNode, dunderAll: ReadonlySet<string> | null): ParsedSymbol | null {
  const statement = node.parent;
  if (statement?.type !== "expression_statement" || statement.parent?.type !== "module") return null;

  const left = fieldNode(node, "left");
  if (!left || left.type !== "identifier" || !CONSTANT_NAME.test(left.text)) return null;

  return {
    name: left.text,
    kind: "constant",
    exported: isExported(left.text, true, dunderAll),
    signature: normalizeWhitespace(node.text).slice(0, 200),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

function containerName(owner: TsNode | null): string | undefined {
  if (owner?.type !== "class_definition") return undefined;
  return fieldText(owner, "name") ?? undefined;
}

function decoratorNames(node: TsNode): string[] {
  const parent = node.parent;
  if (parent?.type !== "decorated_definition") return [];
  const out: string[] = [];
  for (const child of namedChildren(parent)) {
    if (child.type !== "decorator") continue;
    const path = dottedPath(child.text.replace(/^@/, "").replace(/\(.*$/s, ""));
    const last = path.at(-1);
    if (last !== undefined) out.push(last);
  }
  return out;
}

function isExported(
  name: string,
  isModuleLevel: boolean,
  dunderAll: ReadonlySet<string> | null,
): boolean {
  if (isModuleLevel && dunderAll) return dunderAll.has(name);
  return !name.startsWith("_");
}

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const child of namedChildren(paramsNode)) {
    switch (child.type) {
      // `self` / `cls` are not specially processed and are recorded truthfully as the first parameter
      case "identifier":
        out.push({ name: child.text, optional: false, variadic: false });
        break;

      case "typed_parameter": {
        // The typed_parameter does not have a name field; the name is the first named child node.
        const target = child.namedChild(0);
        const splat = target?.type === "list_splat_pattern" || target?.type === "dictionary_splat_pattern";
        out.push({
          name: splat ? splatName(target) : normalizeWhitespace(target?.text ?? "_"),
          type: annotationText(fieldNode(child, "type")),
          optional: splat,
          variadic: splat,
        });
        break;
      }

      case "default_parameter":
      case "typed_default_parameter":
        out.push({
          name: fieldText(child, "name") ?? "_",
          type: annotationText(fieldNode(child, "type")),
          defaultValue: normalizeWhitespace(fieldNode(child, "value")?.text ?? "").slice(0, 120) || undefined,
          optional: true,
          variadic: false,
        });
        break;

      case "list_splat_pattern":
      case "dictionary_splat_pattern":
        out.push({ name: splatName(child), optional: true, variadic: true });
        break;

      // keyword_separator(`*`) / positional_separator(`/`) is not a parameter
      default:
        break;
    }
  }
  return out;
}

/** `*args` → `args`，`**kwargs` → `kwargs` */
function splatName(node: TsNode | null): string {
  if (!node) return "_";
  return node.namedChild(0)?.text ?? normalizeWhitespace(node.text);
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

// ---------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------

/** `import a.b.c` / `import a.b as x` / `import a, b` */
function collectImport(node: TsNode, out: ParsedImport[]): void {
  const line = lineOf(node);
  for (const child of namedChildren(node)) {
    if (child.type === "dotted_name") {
      out.push({
        source: child.text,
        kind: "static",
        specifiers: [{ imported: "*", local: child.text, isNamespace: true }],
        line,
      });
      continue;
    }
    if (child.type === "aliased_import") {
      const source = fieldText(child, "name");
      if (source === null || source.length === 0) continue;
      out.push({
        source,
        kind: "static",
        specifiers: [{ imported: "*", local: fieldText(child, "alias") ?? source, isNamespace: true }],
        line,
      });
    }
  }
}

/**
 * `from .x import y` / `from ..x import y as z` / `from x import *`
 *
 * The source retains the original dots (`.` / `..x`) in `relative_import`, and the parser uses the number of dots to backtrack the package hierarchy.
 * Once normalized, you can no longer distinguish `.x` from `..x`.
 */
function collectImportFrom(node: TsNode, out: ParsedImport[]): void {
  const children = namedChildren(node);
  const moduleNode = children[0];
  if (!moduleNode) return;

  const specifiers: ParsedImportSpecifier[] = [];
  for (const child of children.slice(1)) {
    switch (child.type) {
      case "wildcard_import":
        specifiers.push({ imported: "*", local: "*", isNamespace: true });
        break;
      case "dotted_name":
        specifiers.push({ imported: child.text, local: child.text });
        break;
      case "aliased_import": {
        const imported = fieldText(child, "name");
        if (imported === null || imported.length === 0) break;
        specifiers.push({ imported, local: fieldText(child, "alias") ?? imported });
        break;
      }
      default:
        break;
    }
  }

  out.push({
    source: normalizeWhitespace(moduleNode.text),
    kind: "static",
    specifiers,
    line: lineOf(node),
  });
}

function readDunderAll(root: TsNode): ReadonlySet<string> | null {
  for (const statement of namedChildren(root)) {
    if (statement.type !== "expression_statement") continue;
    const assignment = firstOfType(statement, "assignment", "augmented_assignment");
    if (!assignment || fieldText(assignment, "left") !== "__all__") continue;

    const right = fieldNode(assignment, "right");
    if (!right || (right.type !== "list" && right.type !== "tuple")) continue;

    const names = new Set<string>();
    for (const item of namedChildren(right)) {
      if (item.type !== "string") continue;
      const content = firstOfType(item, "string_content");
      if (content) names.add(content.text);
    }
    return names;
  }
  return null;
}

function buildExports(
  moduleLevel: readonly ParsedSymbol[],
  dunderAll: ReadonlySet<string> | null,
  root: TsNode,
): ParsedExport[] {
  if (dunderAll) {
    const lineByName = new Map(moduleLevel.map((s) => [s.name, s.startLine]));
    const fallback = dunderAllLine(root);
    // `__all__` can list names that are not defined in this file (re-exported imports), and these are also considered exports
    return [...dunderAll].map((name) => ({
      name,
      kind: "named" as const,
      line: lineByName.get(name) ?? fallback,
    }));
  }
  return moduleLevel
    .filter((s) => !s.name.startsWith("_"))
    .map((s) => ({ name: s.name, kind: "named" as const, line: s.startLine }));
}

function dunderAllLine(root: TsNode): number {
  for (const statement of namedChildren(root)) {
    if (statement.type !== "expression_statement") continue;
    const assignment = firstOfType(statement, "assignment", "augmented_assignment");
    if (assignment && fieldText(assignment, "left") === "__all__") return lineOf(assignment);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  const argCount = countArgs(fieldNode(node, "arguments"));
  const args = argumentTexts(fieldNode(node, "arguments"));
  const line = lineOf(node);
  const byte = node.startIndex;
  const endByte = node.endIndex;

  if (fn.type === "identifier") {
    out.push({
      callee: fn.text, line, argCount, argumentTexts: args, kind: "call", byte, endByte,
      ...calleeAt(fn, fn.text),
    });
    return;
  }

  if (fn.type === "attribute") {
    const callee = fieldText(fn, "attribute");
    if (callee === null) return;
    const object = fieldNode(fn, "object");
    const path = dottedPath(fn.text);
    out.push({
      callee,
      receiver: object ? normalizeWhitespace(object.text).slice(0, 120) : undefined,
      calleePath: path.length > 1 ? path : undefined,
      line,
      argCount,
      argumentTexts: args,
      kind: "method",
      byte,
      endByte,
      ...calleeAt(fn, callee),
    });
  }
  // `handlers[k]()` / `f()()`'s callee cannot be statically named, not recorded
}

/** FastAPI / Flask-style decorator routing. The decorator itself is not used as a runtime invocation edge. */
function collectRouteHints(
  node: TsNode,
  out: NonNullable<ParsedFile["entryHints"]>,
): void {
  const parent = node.parent;
  if (parent?.type !== "decorated_definition") return;
  const handlerName = fieldText(node, "name") ?? undefined;
  for (const decorator of namedChildren(parent)) {
    if (decorator.type !== "decorator") continue;
    const compact = normalizeWhitespace(decorator.text);
    const match = compact.match(/^@([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|options|head|route|websocket)\s*\((.*)\)$/s);
    if (!match) continue;
    const receiver = match[1] as string;
    const verb = (match[2] as string).toLowerCase();
    const rawArgs = match[3] as string;
    const routeMatch = rawArgs.match(/^\s*(["'])(.*?)\1/);
    const route = routeMatch?.[2];
    if (!route) continue;
    out.push({
      kind: "http",
      framework: verb === "route" ? "Flask" : "FastAPI",
      handlerName,
      line: lineOf(decorator),
      label: `${verb === "route" ? "HTTP" : verb.toUpperCase()} ${route}`,
      method: verb === "route" || verb === "websocket" ? undefined : verb.toUpperCase(),
      route,
      confidence: "exact",
      evidence: `${receiver}.${verb} decorator`,
    });
  }
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter((c) => c.type !== "comment").length;
}

// ---------------------------------------------------------------------------
// Type relationship
// ---------------------------------------------------------------------------

function collectBases(node: TsNode, out: ParsedTypeRelation[]): void {
  const subject = fieldText(node, "name");
  const supers = fieldNode(node, "superclasses");
  if (subject === null || !supers) return;

  for (const child of namedChildren(supers)) {
    // `metaclass=ABCMeta` is a class creation parameter, not a base class
    if (child.type === "keyword_argument") continue;
    // The base class of `Generic[T]` is `Generic`, with the type parameter dropped
    const base = child.type === "subscript" ? fieldNode(child, "value") : child;
    if (!base) continue;

    const path = dottedPath(base.text);
    const target = path.at(-1);
    if (target === undefined) continue;

    out.push({
      subject,
      subjectKind: "class",
      relation: "extends",
      target,
      targetPath: path.length > 1 ? path : undefined,
      line: lineOf(child),
    });
  }
}
