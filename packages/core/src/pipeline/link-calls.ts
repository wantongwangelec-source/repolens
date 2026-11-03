import type { Db } from "../db/database.js";
import type { EdgeRow } from "../db/writer.js";
import { resolverFamily, type ResolverFamily } from "../discovery/language.js";
import type { Confidence, Language } from "../types.js";
import { builtinType, isBuiltinFunction, isBuiltinReceiver } from "./builtins.js";

/**
 * Call site → Symbol-level call edge.
 *
 * This is the place in the entire project where 'seemingly certain mistakes along the edges' are most likely to occur, so every edge must
 * Include the confidence level, and the judgment order is from 'provable by language semantics' gradually down to 'guessed by the name':
 *
 *   exact      Same file definition / this.x hits the same class / import chain can reach the definition
 *   likely     There is file-level evidence but no symbol-level evidence (Go same package, Python/Rust wildcard import,
 *              import points to the file but the other side did not explicitly export this name)
 *   ambiguous There is more than one candidate with the same name, store all candidate IDs together and pass them to the interface
 *   external   The call target comes from a third party or the standard library
 *   unresolved Nothing matched, no edges are generated
 *
 * "'The only same-name in the entire warehouse' only acts as a fallback in languages without a module resolver. TS/JS, Python, Rust's
 * Cross-file calls must go through import; hits with the same name without import evidence are almost all coincidences——
 * The local variable `run()` will be connected to a `run` that happens to be exported in another package, and it crosses architecture boundaries.
 *
 * The type of the receiver of the method call comes from clues noted by the parser (parameter annotations, `new`, `as`, local variables)
 * the initial value) or the caller's parameter list; chained calls follow the result of the previous call. None of these are complete
 * Type inference: if it can't be deduced, just continue using name matching as usual; this will not result in an additional definite erroneous edge.
 *
 * unresolved Leaving the edges undefined is intentional: `console.log` and similar take up most of the call sites,
 * Drawing them into the diagram will only drown out the real structure. The statistics will still be reported.
 */

export interface CallLinkStats {
  callSites: number;
  edges: number;
  byConfidence: Record<Confidence, number>;
}

interface Binding {
  /** import the parsed target file; Go's package-level import has no file granularity, so it is null */
  targetFileId: number | null;
  /** The directory where the Go package-level import falls */
  targetDir: string | null;
  externalName: string | null;
  /** The original name in the target module, distinguished from the local alias */
  imported: string;
  isNamespace: boolean;
}

interface FileScope {
  family: ResolverFamily | undefined;
  dir: string;
  packageId: number | null;
  /** This document top-level definition: name → symbol id */
  locals: Map<string, number[]>;
  /** Members of this document: `container.name` → symbol id */
  members: Map<string, number[]>;
  /** import's local name → binding */
  bindings: Map<string, Binding>;
  /** Files pointed to by `export * from` / `from x import *` / `use x::*` */
  stars: number[];
  /** Type names visible in this document: locally declared + imported */
  visibleTypes: Set<string>;
}

export function linkCallEdges(db: Db, insert: (edges: EdgeRow[]) => void): CallLinkStats {
  const index = buildIndex(db);
  const stats: CallLinkStats = {
    callSites: 0,
    edges: 0,
    byConfidence: { exact: 0, likely: 0, ambiguous: 0, external: 0, unresolved: 0 },
  };

  // If the same (caller, callee) appears multiple times, only keep one edge, with the count recorded in the weight.
  // Calling the same function 10 times in a loop shows the same relationship on the graph as calling it once.
  const merged = new Map<string, EdgeRow>();

  // Sort according to the end position in the file, when chaining calls `a.b().c()`, by the time c is processed, b already has a result
  const rows = db
    .prepare(
      `SELECT c.id, c.file_id AS fileId, c.caller_symbol_id AS callerId, c.callee_name AS callee,
              c.receiver, c.receiver_type AS receiverType, c.callee_path AS calleePath,
              c.call_kind AS callKind, c.line
       FROM call_sites c ORDER BY c.file_id, c.end_byte`,
    )
    .all() as Array<CallRow & { id: number; line: number }>;
  const record = db.prepare(
    `UPDATE call_sites SET resolution = @confidence, target_symbol_id = @symbolId,
       target_name = @externalName, candidates = @candidates
     WHERE id = @id`,
  );

  let priorFile = -1;
  let prior: PriorCall[] = [];
  for (const row of rows) {
    stats.callSites++;
    if (row.fileId !== priorFile) {
      priorFile = row.fileId;
      prior = [];
    }
    const scope = index.scopes.get(row.fileId);
    const inner = row.receiver?.includes("(") && row.receiverType === null ? innerCallOf(prior, row) : null;
    const target =
      (inner ? chainedOn(index, inner.resolution, row.callee) : null) ?? resolveCall(index, scope, row, 0, prior);
    prior.push({ callerId: row.callerId, receiver: row.receiver, callee: row.callee, resolution: target });
    if (prior.length > 512) prior = prior.slice(-256);
    stats.byConfidence[target.confidence]++;
    record.run({
      id: row.id,
      confidence: target.confidence,
      symbolId: target.symbolId,
      externalName: target.externalName,
      candidates: target.candidates ? JSON.stringify(target.candidates) : null,
    });
    if (target.confidence === "unresolved") continue;

    // The caller may be the top-level code of the module, in which case it should be attributed to the file header rather than creating a fake caller.
    const srcKind = row.callerId !== null ? "symbol" : "file";
    const srcId = row.callerId ?? row.fileId;
    if (srcKind === "symbol" && target.symbolId === srcId) continue; // Do not enter the graph recursively

    const dstKey = target.symbolId !== null ? `s${target.symbolId}` : `e${target.externalName}`;
    const key = `${srcKind}${srcId}\u0000${dstKey}`;
    const existing = merged.get(key);
    if (existing) {
      existing.weight++;
      continue;
    }

    merged.set(key, {
      type: "calls",
      srcKind,
      srcId,
      dstKind: target.symbolId !== null ? "symbol" : "external",
      dstId: target.symbolId,
      dstName: target.externalName,
      confidence: target.confidence,
      line: row.line,
      callKind: row.callKind,
      candidates: target.candidates,
      weight: 1,
    });
  }

  const edges = [...merged.values()];
  insert(edges);
  stats.edges = edges.length;
  return stats;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Resolution {
  confidence: Confidence;
  symbolId: number | null;
  externalName: string | null;
  candidates: number[] | null;
}

const UNRESOLVED: Resolution = {
  confidence: "unresolved",
  symbolId: null,
  externalName: null,
  candidates: null,
};

interface CallRow {
  fileId: number;
  callerId: number | null;
  callee: string;
  receiver: string | null;
  /** Receiver type hints recorded by the parser, see `receiverHint` */
  receiverType: string | null;
  calleePath: string | null;
  callKind: string;
}

/** When propagating the return type, other calls will be parsed recursively. A maximum depth is set to prevent circular references caused by aliases or mutually returning types. */
const MAX_TYPE_DEPTH = 3;

function resolveCall(
  index: RepoIndex,
  scope: FileScope | undefined,
  row: CallRow,
  depth: number,
  prior: readonly PriorCall[] = [],
): Resolution {
  const isMethod = row.receiver !== null && row.receiver.length > 0;

  if (isMethod) {
    const receiver = row.receiver as string;

    // this.foo() —— the only method call where the receiver type can be determined solely by syntax
    if (receiver === "this" || receiver === "self" || receiver === "Self" || receiver === "cls") {
      const container = row.callerId !== null ? index.containerOf.get(row.callerId) : undefined;
      if (container && scope) {
        const hit = scope.members.get(`${container}.${row.callee}`);
        if (hit && hit.length > 0) return exact(hit[0] as number);
        const decl = index.typesOf.get(row.fileId)?.get(container);
        const inherited = decl ? methodViaParents(index, decl, row.callee, depth) : null;
        if (inherited) return inherited;
      }
    }
    if (receiver === "super" || receiver === "super()") {
      const container = row.callerId !== null ? index.containerOf.get(row.callerId) : undefined;
      const decl = container ? index.typesOf.get(row.fileId)?.get(container) : undefined;
      const inherited = decl ? methodViaParents(index, decl, row.callee, depth) : null;
      if (inherited) return inherited;
    }

    const head = receiver.split(/\.|::/)[0] as string;
    if (!scope?.bindings.has(head) && isBuiltinReceiver(scope?.family, head)) {
      return external(head);
    }

    // Namespace import: import * as fs → fs.readFile(); Go's pkg.Func();
    // Python's `import a.b` binds the full dotted name
    const binding = scope?.bindings.get(receiver) ?? scope?.bindings.get(head);
    if (binding?.isNamespace) {
      if (binding.externalName !== null) return external(binding.externalName);
      if (binding.targetFileId !== null) {
        const hit = resolveImported(index, binding.targetFileId, row.callee);
        if (hit) return hit;
      }
      if (binding.targetDir !== null) {
        const hit = byPackage(index.topLevelByDir.get(binding.targetDir)?.get(row.callee), "exact");
        if (hit) return hit;
      }
    }

    // The receiver is the member's host: `api.load()` / `Foo.create()` in this file,
    // Or `api.load()` after `import { api } from "./client"`
    if (scope && !receiver.includes(".")) {
      const hit = binding
        ? binding.isNamespace || binding.targetFileId === null
          ? null
          : resolveMember(index, binding.targetFileId, binding.imported, row.callee, new Set())
        : uniqueOf(scope.members.get(`${receiver}.${row.callee}`));
      if (hit !== null) return exact(hit);
    }

    if (scope && depth < MAX_TYPE_DEPTH) {
      const typed = receiverTypeOf(index, scope, row, depth, prior);
      if (typed) {
        const hit = methodOnType(index, typed.type, row.callee, depth);
        if (hit) return typed.inferred ? downgrade(hit) : hit;
      }
    }

    // When the return value type cannot be inferred, the then / catch / finally attached to the call result will almost always be Promise
    if (receiver.includes("(") && (row.callee === "then" || row.callee === "catch" || row.callee === "finally")) {
      return external("Promise");
    }

    // The receiver is a regular variable with an unknown type. The candidate pool must satisfy two conditions at the same time: it is a method,
    // And the host class is visible in this file (locally defined or imported). Without the latter,
    // `arr.push(x)` will attach to any user method in the repository that happens to be called push—
    // There are more than a thousand such pseudo-edges on pi, and they all point to completely unrelated classes.
    return byName(visibleMethods(index, scope, row.callee));
  }

  // ---- Regular Function Call ----

  if (!scope) return byName(index.exportedByName.get(row.callee));

  const local = scope.locals.get(row.callee);
  if (local && local.length === 1) return exact(local[0] as number);
  if (local && local.length > 1) {
    return { confidence: "ambiguous", symbolId: local[0] as number, externalName: null, candidates: local };
  }

  const binding = scope.bindings.get(row.callee);
  if (binding) {
    if (binding.externalName !== null) return external(binding.externalName);
    if (binding.targetFileId !== null) {
      const name = binding.isNamespace ? row.callee : binding.imported;
      const hit = resolveImported(index, binding.targetFileId, name, row.callee);
      if (hit) return hit;
    }
  }

  const builtin = isBuiltinFunction(scope.family, row.callee) ? external(row.callee) : UNRESOLVED;
  switch (scope.family) {
    case "ts":
      // Without import, it is impossible to call functions from other files.
      return builtin;
    case "python":
    case "rust": {
      const hit = fromStars(index, scope, row.callee);
      return hit.confidence === "unresolved" ? builtin : hit;
    }
    case "go": {
      // In Go, direct calls without a receiver can only occur within the same package (same directory) or in packages imported with a dot; definitions in the same package can overshadow built-ins like len and copy.
      const samePackage = index.topLevelByDir.get(scope.dir)?.get(row.callee);
      const hit = byPackage(samePackage, "likely");
      if (hit) return hit;
      const dot = scope.bindings.get(".");
      if (dot?.targetDir) {
        return byPackage(index.topLevelByDir.get(dot.targetDir)?.get(row.callee), "likely") ?? builtin;
      }
      return builtin;
    }
    default:
      return byName(index.exportedByName.get(row.callee));
  }
}

// ---------------------------------------------------------------------------
// Recipient Type
// ---------------------------------------------------------------------------

type TypeRef = { kind: "external"; name: string } | { kind: "repo"; decl: TypeDecl };

interface TypeDecl {
  id: number;
  fileId: number;
  name: string;
  kind: string;
  signature: string | null;
}

interface PriorCall {
  callerId: number | null;
  receiver: string | null;
  callee: string;
  resolution: Resolution;
}

/**
 * The type of the receiver. `inferred` means that the type is deduced from the return value rather than written in the source code:
 * The return type annotation might be broader than it actually is (returning an interface, returning a superclass), so the method it resolves to can only be considered likely.
 */
function receiverTypeOf(
  index: RepoIndex,
  scope: FileScope,
  row: CallRow,
  depth: number,
  prior: readonly PriorCall[],
): { type: TypeRef; inferred: boolean } | null {
  // TS's clues are found by the parser following the scope, and it has already handled the situation where inner parameters with the same name shadow outer ones; the parameter list fallback is only provided for other languages.
  const hint = row.receiverType ?? (scope.family === "ts" ? null : paramHint(index, row));
  return hint === null ? null : typeOfHint(index, scope, row, hint, depth, prior);
}

/** The callback parameter is the result of a collection element or a Promise, not an object from the library where the registrar is located. */
const COLLECTION_METHODS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "find", "findIndex", "findLast", "some", "every", "flatMap",
  "sort", "then", "catch", "finally", "replace", "replaceAll",
]);

function typeOfHint(
  index: RepoIndex,
  scope: FileScope,
  row: CallRow,
  hint: string,
  depth: number,
  prior: readonly PriorCall[],
): { type: TypeRef; inferred: boolean } | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  const body = hint.slice(2);
  if (hint.startsWith("T:")) {
    const type = resolveTypeName(index, row.fileId, body, false, depth);
    return type ? { type, inferred: false } : null;
  }
  // M: It is the property chain `c.req`, followed by the clue of the root variable. Only trust the specified type and callback parameters:
  // The roots inferred from the return value are mostly ordinary data, and the attributes no longer belong to that library.
  if (hint.startsWith("M:")) {
    if (!/^[TC]:/.test(body)) return null;
    const root = typeOfHint(index, scope, row, body, depth + 1, prior);
    return root?.type.kind === "external" ? root : null;
  }
  // C: Callback parameter without a specified type, `method name|clue from the registrant`
  if (hint.startsWith("C:")) {
    const bar = body.indexOf("|");
    const method = body.slice(0, bar);
    if (bar < 0 || COLLECTION_METHODS.has(method)) return null;
    const owner = typeOfHint(index, scope, row, body.slice(bar + 1), depth + 1, prior);
    const hit = owner ? methodOnType(index, owner.type, method, depth + 1) : null;
    if (hit?.confidence !== "external" || hit.externalName === null || !index.importedExternals.has(hit.externalName)) {
      return null;
    }
    return { type: { kind: "external", name: hit.externalName }, inferred: true };
  }
  if (!hint.startsWith("R:") && !hint.startsWith("A:")) return null;
  // R: It's the path of f in `const x = f()`, A: is the one that has been awaited. That call in the initial value is generally already resolved.
  // It carries its own receiver cues, which are more accurate than re-parsing according to the path.
  const segments = body.split(".");
  const call: CallRow = {
    fileId: row.fileId,
    callerId: row.callerId,
    callee: segments.at(-1) as string,
    receiver: segments.length > 1 ? segments.slice(0, -1).join(".") : null,
    receiverType: null,
    calleePath: body,
    callKind: "call",
  };
  const earlier = findPrior(prior, call);
  const resolution = earlier?.resolution ?? resolveCall(index, scope, call, depth + 1);
  const type = returnTypeOf(index, resolution, hint.startsWith("A:"), depth);
  return type ? { type, inferred: true } : null;
}

function findPrior(prior: readonly PriorCall[], call: CallRow): PriorCall | null {
  for (let i = prior.length - 1; i >= 0 && i >= prior.length - 256; i--) {
    const candidate = prior[i] as PriorCall;
    if (candidate.callee === call.callee && candidate.receiver === call.receiver) return candidate;
  }
  return null;
}

/** When the receiver is the caller's parameter, the type annotation in the parameter list; the receiver variable of a Go method also counts */
function paramHint(index: RepoIndex, row: CallRow): string | null {
  if (row.callerId === null || row.receiver === null || !/^[A-Za-z_$][\w$]*$/.test(row.receiver)) return null;
  const type = paramTypesOf(index, row.callerId).get(row.receiver);
  return type ? `T:${type}` : null;
}

function paramTypesOf(index: RepoIndex, symbolId: number): Map<string, string> {
  const cached = index.paramTypeCache.get(symbolId);
  if (cached) return cached;
  const out = new Map<string, string>();
  const info = index.symbolInfo.get(symbolId);
  if (info?.params) {
    try {
      for (const param of JSON.parse(info.params) as Array<{ name?: string; type?: string | null }>) {
        if (param.name && param.type) out.set(param.name, param.type);
      }
    } catch {
      // The params in the old index may not be JSON, treat them as unannotated.
    }
  }
  const goReceiver = info?.signature?.match(/^func\s*\(\s*(\w+)\s+\*?\s*([\w.]+)/);
  if (goReceiver) out.set(goReceiver[1] as string, goReceiver[2] as string);
  index.paramTypeCache.set(symbolId, out);
  return out;
}

/**
 * The result type of a single call: if you call a class, it is its instance; if you call a function, look at the return type annotation.
 * The return type of an external library function is not visible, but the subsequent method being called also belongs to that library, so attributing it to the library is more useful than reporting 'cannot determine'.
 */
function returnTypeOf(index: RepoIndex, resolution: Resolution, awaited: boolean, depth: number): TypeRef | null {
  if (resolution.confidence === "external" && resolution.externalName !== null) {
    return { kind: "external", name: resolution.externalName };
  }
  if (resolution.symbolId === null || resolution.confidence === "ambiguous") return null;
  const decl = index.typeById.get(resolution.symbolId);
  if (decl) return { kind: "repo", decl };
  const info = index.symbolInfo.get(resolution.symbolId);
  if (!info?.returnType) return null;
  return resolveTypeName(index, info.fileId, info.returnType, awaited, depth + 1);
}

/** In the chain call `a.b(x).c()`, which result does c attach to: it attaches to the closest call whose receiver starts with that call */
function innerCallOf(prior: readonly PriorCall[], row: CallRow): PriorCall | null {
  const receiver = row.receiver as string;
  for (let i = prior.length - 1; i >= 0 && i >= prior.length - 64; i--) {
    const call = prior[i] as PriorCall;
    if (call.callerId !== row.callerId) continue;
    const prefix = `${call.receiver ? `${call.receiver}.` : ""}${call.callee}(`;
    if (receiver.startsWith(prefix)) return call;
  }
  return null;
}

function chainedOn(index: RepoIndex, inner: Resolution, callee: string): Resolution | null {
  const type = returnTypeOf(index, inner, false, 0);
  const hit = type ? methodOnType(index, type, callee, 0) : null;
  return hit ? downgrade(hit) : null;
}

/** Type annotation → Can find the host of the method: the type declared in the repository, or some external library / built-in language */
function resolveTypeName(index: RepoIndex, fileId: number, text: string, awaited: boolean, depth: number): TypeRef | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const name = simplifyType(text, scope.family, awaited);
  if (name === null) return null;
  const segments = name.split(/\.|::/);
  const head = segments[0] as string;

  if (segments.length === 1) {
    const local = index.typesOf.get(fileId)?.get(head);
    if (local) return followAlias(index, local, depth);
    const binding = scope.bindings.get(head);
    if (binding) {
      if (binding.externalName !== null) return { kind: "external", name: binding.externalName };
      if (binding.targetFileId !== null && !binding.isNamespace) {
        const defaultId = binding.imported === "default" ? index.defaultExportOf.get(binding.targetFileId) : undefined;
        const decl =
          (defaultId !== undefined ? index.typeById.get(defaultId) : undefined) ??
          exportedType(index, binding.targetFileId, binding.imported === "default" ? head : binding.imported, new Set());
        return decl ? followAlias(index, decl, depth) : null;
      }
    }
    if (scope.family === "go") {
      const decl = index.typesByDir.get(scope.dir)?.get(head);
      if (decl) return followAlias(index, decl, depth);
    }
    const builtin = builtinType(scope.family, head);
    if (builtin) return { kind: "external", name: builtin };
    // In TS, uppercase type names that are not declared or imported come from global declarations (lib.dom, @types/node);
    // Single letters and TItem are generic parameters, not specific types
    if (scope.family === "ts" && /^[A-Z]/.test(head) && !/^[A-Z]$|^T[A-Z]/.test(head)) {
      return { kind: "external", name: head };
    }
    return null;
  }

  const member = segments[1] as string;
  const binding = scope.bindings.get(head);
  if (binding) {
    if (binding.externalName !== null) return { kind: "external", name: binding.externalName };
    if (binding.targetFileId !== null && binding.isNamespace) {
      const decl = exportedType(index, binding.targetFileId, member, new Set());
      return decl ? followAlias(index, decl, depth) : null;
    }
    if (binding.targetDir !== null) {
      const decl = index.typesByDir.get(binding.targetDir)?.get(member);
      return decl ? followAlias(index, decl, depth) : null;
    }
    return null;
  }
  if (isBuiltinReceiver(scope.family, head)) return { kind: "external", name: head };
  if (scope.family === "ts" && /^[A-Z]/.test(head)) return { kind: "external", name: head };
  return null;
}

/** `type Db = Database.Database` This type alias should follow the one on the right; Go's `type Handler func()` can itself have methods */
function followAlias(index: RepoIndex, decl: TypeDecl, depth: number): TypeRef | null {
  if (decl.kind !== "type") return { kind: "repo", decl };
  const rhs = decl.signature?.match(/=\s*([\s\S]+?);?\s*$/)?.[1];
  if (rhs === undefined) return { kind: "repo", decl };
  return resolveTypeName(index, decl.fileId, rhs, false, depth + 1);
}

/** Find the file that declares this type along import/re-export */
function exportedType(index: RepoIndex, fileId: number, name: string, seen: Set<number>): TypeDecl | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);
  const direct = index.typesOf.get(fileId)?.get(name);
  if (direct) return direct;
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const binding = scope.bindings.get(name);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = exportedType(index, binding.targetFileId, binding.imported, seen);
    if (hit) return hit;
  }
  for (const target of scope.stars) {
    const hit = exportedType(index, target, name, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Simplify type annotations into a searchable name: remove nullable, reference, pointer, and generic parameters.
 * Union, intersection, function, and object literal types do not fall on a single host, returning null.
 */
function simplifyType(text: string, family: ResolverFamily | undefined, awaited: boolean): string | null {
  let type = text.replace(/\s+/g, " ").trim().replace(/^:\s*/, "");
  for (let guard = 0; guard < 8; guard++) {
    const before = type;
    if (/^(typeof|keyof) /.test(type)) return null;
    type = type.replace(/^(readonly|unique) /, "");
    type = type.replace(/^&\s*('\w+\s+)?(mut\s+)?|^\*+\s*|^(dyn|impl|mut) /, "");
    // Python's forward reference written as a string: `def f(x: "Store")`
    if (family === "python") type = type.replace(/^(["'])(.*)\1$/, "$2");
    if (type.startsWith("(") && type.endsWith(")") && splitTopLevel(type.slice(1, -1), ",").length === 1) {
      type = type.slice(1, -1).trim();
    }
    const parts = splitTopLevel(type, "|").map((p) => p.trim()).filter((p) => !/^(null|undefined|void|None)$/.test(p));
    if (parts.length !== 1) return null;
    type = parts[0] as string;
    if (splitTopLevel(type, "&").length > 1 || hasTopLevelArrow(type) || type.startsWith("{")) return null;

    if (type.endsWith("[]")) return family === "ts" ? "Array" : null;
    // In TS, `X["key"]` is an indexed access type, not a generic; bracket generics are only used in Python/Go.
    if (family === "ts" && type.endsWith("]")) return null;
    const generic = type.match(/^([\w$.:]+)\s*[<[]([\s\S]*)[>\]]$/);
    if (generic) {
      const base = generic[1] as string;
      const args = splitTopLevel(generic[2] as string, ",");
      const unwrap =
        (awaited && (base === "Promise" || base === "PromiseLike")) ||
        (family === "python" && (base === "Optional" || base === "Annotated" || base === "typing.Optional")) ||
        (family === "rust" && (base === "Box" || base === "Rc" || base === "Arc"));
      type = unwrap ? (args[0] ?? "").trim() : base;
    }
    if (type === before) break;
  }
  return /^[A-Za-z_$][\w$]*((\.|::)[A-Za-z_$][\w$]*)*$/.test(type) ? type : null;
}

function hasTopLevelArrow(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ">" && text[i - 1] !== "=") || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "=" && text[i + 1] === ">") return true;
  }
  return false;
}

function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ">" && text[i - 1] !== "=") || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === separator) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Finding methods by type: first look at yourself, then go up along extends/embeds. Interfaces and traits do not have their own implementations,
 * It falls on the class that implements it; when more than one is implemented, leave it to the interface to choose.
 */
function methodOnType(index: RepoIndex, type: TypeRef, callee: string, depth: number): Resolution | null {
  if (type.kind === "external") return external(type.name);
  const { decl } = type;
  const own = membersOf(index, decl, callee);
  if (decl.kind === "interface" || decl.kind === "trait") {
    const hits = [...new Set(
      (index.implementersOf.get(decl.id) ?? [])
        .map((id) => index.typeById.get(id))
        .map((impl) => (impl ? membersOf(index, impl, callee).at(-1) : undefined))
        .filter((id): id is number => id !== undefined),
    )];
    if (hits.length === 1) return likely(hits[0] as number);
    if (hits.length > 1) return byName(hits);
    if (own.length > 0) return likely(own.at(-1) as number);
    return methodViaParents(index, decl, callee, depth);
  }
  // In TS, overload signatures come before the implementation, and the last one is the one with the function body.
  if (own.length > 0) return exact(own.at(-1) as number);
  return methodViaParents(index, decl, callee, depth);
}

function methodViaParents(index: RepoIndex, decl: TypeDecl, callee: string, depth: number): Resolution | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  for (const parent of index.parentsOf.get(decl.id) ?? []) {
    const type =
      resolveTypeName(index, decl.fileId, parent.target, false, depth + 1) ??
      (parent.targetId !== null && index.typeById.has(parent.targetId)
        ? { kind: "repo" as const, decl: index.typeById.get(parent.targetId) as TypeDecl }
        : null);
    if (!type || (type.kind === "repo" && type.decl.id === decl.id)) continue;
    const hit = methodOnType(index, type, callee, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Type members: same file takes priority; Go's methods can be written in other files of the same package, Rust's impl can be anywhere in the same crate */
function membersOf(index: RepoIndex, decl: TypeDecl, callee: string): number[] {
  const all = index.membersByKey.get(`${decl.name}.${callee}`);
  if (!all) return [];
  const home = index.scopes.get(decl.fileId);
  const sameFile = all.filter((id) => index.symbolInfo.get(id)?.fileId === decl.fileId);
  if (sameFile.length > 0 || !home) return sameFile;
  return all.filter((id) => {
    const scope = index.scopes.get(index.symbolInfo.get(id)?.fileId ?? -1);
    if (!scope) return false;
    if (home.family === "go") return scope.dir === home.dir;
    return home.family === "rust" && home.packageId !== null && scope.packageId === home.packageId;
  });
}

function downgrade(resolution: Resolution): Resolution {
  return resolution.confidence === "exact" ? { ...resolution, confidence: "likely" } : resolution;
}

/**
 * import points to a specific file: trace to the definition along exports, `export { a } from`, `export * from`.
 * Cannot find, but the target file at the top level happens to have this name (CommonJS `module.exports = { foo }`, 
 * When the extractor doesn't recognize the export form, it gives likely — the file relationship has been proven to be imported, but the symbol relationship has not.
 */
function resolveImported(
  index: RepoIndex,
  targetFileId: number,
  name: string,
  localName?: string,
): Resolution | null {
  const hit = resolveExport(index, targetFileId, name, new Set());
  if (hit !== null) return exact(hit);
  const locals = index.scopes.get(targetFileId)?.locals;
  const fallback = locals?.get(name === "default" ? (localName ?? name) : name);
  if (fallback && fallback.length === 1) return likely(fallback[0] as number);
  return null;
}

function resolveExport(index: RepoIndex, fileId: number, name: string, seen: Set<number>): number | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);

  const direct = name === "default" ? index.defaultExportOf.get(fileId) : index.exportsOf.get(fileId)?.get(name);
  if (direct !== undefined) return direct;

  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  // The barrel file's `export { a as b } from "./x"`, as well as in Python's `__init__.py`
  // `from .impl import foo` all behave as a single import binding in this file
  const binding = scope.bindings.get(name);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = resolveExport(index, binding.targetFileId, binding.imported, seen);
    if (hit !== null) return hit;
  }
  for (const target of scope.stars) {
    const hit = resolveExport(index, target, name, seen);
    if (hit !== null) return hit;
  }
  return null;
}

/** Follow the import/re-export to find the file that defines `owner` and take its members */
function resolveMember(index: RepoIndex, fileId: number, owner: string, member: string, seen: Set<number>): number | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const direct = uniqueOf(scope.members.get(`${owner}.${member}`));
  if (direct !== null) return direct;
  const binding = scope.bindings.get(owner);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = resolveMember(index, binding.targetFileId, binding.imported, member, seen);
    if (hit !== null) return hit;
  }
  for (const target of scope.stars) {
    const hit = resolveMember(index, target, owner, member, seen);
    if (hit !== null) return hit;
  }
  return null;
}

function uniqueOf(ids: number[] | undefined): number | null {
  return ids?.length === 1 ? (ids[0] as number) : null;
}

function fromStars(index: RepoIndex, scope: FileScope, name: string): Resolution {
  const hits = [...new Set(
    scope.stars
      .map((target) => resolveExport(index, target, name, new Set()))
      .filter((id): id is number => id !== null),
  )];
  if (hits.length === 1) return likely(hits[0] as number);
  if (hits.length > 1) {
    return { confidence: "ambiguous", symbolId: hits[0] as number, externalName: null, candidates: hits.slice(0, 16) };
  }
  return UNRESOLVED;
}

/** Candidates within the same package. The Go compiler guarantees that top-level names within a package are unique, and multiple candidates will only come from build tags. */
function byPackage(candidates: number[] | undefined, single: "exact" | "likely"): Resolution | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) {
    return single === "exact" ? exact(candidates[0] as number) : likely(candidates[0] as number);
  }
  return {
    confidence: "ambiguous",
    symbolId: candidates[0] as number,
    externalName: null,
    candidates: candidates.slice(0, 16),
  };
}

/**
 * In methods with the same name, those of the host class are visible in this file.
 *
 * The criterion for 'visible' is that the class name appears in the type declarations or imports of this file. This is not type inference.
 * But enough to keep standard library methods out: no one would import a class called Array.
 */
function visibleMethods(
  index: RepoIndex,
  scope: FileScope | undefined,
  callee: string,
): number[] | undefined {
  const all = index.methodsByName.get(callee);
  if (!all || !scope) return undefined;
  const visible = all.filter((id) => {
    const container = index.containerOf.get(id);
    return container !== undefined && scope.visibleTypes.has(container);
  });
  return visible.length > 0 ? visible : undefined;
}

function exact(symbolId: number): Resolution {
  return { confidence: "exact", symbolId, externalName: null, candidates: null };
}

function likely(symbolId: number): Resolution {
  return { confidence: "likely", symbolId, externalName: null, candidates: null };
}

function external(name: string): Resolution {
  return { confidence: "external", symbolId: null, externalName: name, candidates: null };
}

function byName(candidates: number[] | undefined): Resolution {
  if (!candidates || candidates.length === 0) return UNRESOLVED;
  if (candidates.length === 1) return likely(candidates[0] as number);
  // Keep all the candidates, allowing people to choose on the interface themselves, rather than guessing for them.
  return {
    confidence: "ambiguous",
    symbolId: candidates[0] as number,
    externalName: null,
    candidates: candidates.slice(0, 16),
  };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface RepoIndex {
  scopes: Map<number, FileScope>;
  /** File → Export Name → Symbol ID */
  exportsOf: Map<number, Map<string, number>>;
  /** File → Default exported symbol id */
  defaultExportOf: Map<number, number>;
  /** Exported top-level symbols, by name; only provide a fallback for languages without a module resolver */
  exportedByName: Map<string, number[]>;
  /** Go: Directory → Top-level name → Symbol id (package visibility, case-insensitive) */
  topLevelByDir: Map<string, Map<string, number[]>>;
  /** Symbols with containers (methods/fields), by name */
  methodsByName: Map<string, number[]>;
  /** Symbol id → The name of the container it belongs to */
  containerOf: Map<number, string>;
  /** `container.name` → symbol id, cross-file; in Go/Rust, methods are not necessarily written in the same file as the type */
  membersByKey: Map<string, number[]>;
  /** File → Top-level Type Name → Declaration */
  typesOf: Map<number, Map<string, TypeDecl>>;
  /** Go: Directory → Type Name → Declaration */
  typesByDir: Map<string, Map<string, TypeDecl>>;
  typeById: Map<number, TypeDecl>;
  /** Type → The target it extends/embeds */
  parentsOf: Map<number, Array<{ target: string; targetId: number | null }>>;
  /** Interface / trait → the type that implements it */
  implementersOf: Map<number, number[]>;
  symbolInfo: Map<number, { fileId: number; returnType: string | null; params: string | null; signature: string | null }>;
  paramTypeCache: Map<number, Map<string, string>>;
  /** There are external names imported from files; external names not included are language built-ins (Map, console, len) */
  importedExternals: Set<string>;
}

function addType<K>(table: Map<K, Map<string, TypeDecl>>, key: K, decl: TypeDecl): void {
  let names = table.get(key);
  if (!names) {
    names = new Map();
    table.set(key, names);
  }
  if (!names.has(decl.name)) names.set(decl.name, decl);
}

function buildIndex(db: Db): RepoIndex {
  const scopes = new Map<number, FileScope>();
  const exportsOf = new Map<number, Map<string, number>>();
  const defaultExportOf = new Map<number, number>();
  const exportedByName = new Map<string, number[]>();
  const topLevelByDir = new Map<string, Map<string, number[]>>();
  const methodsByName = new Map<string, number[]>();
  const containerOf = new Map<number, string>();

  const files = db.prepare("SELECT id, language, dir_path AS dir, package_id AS packageId FROM files").all() as Array<{
    id: number;
    language: Language;
    dir: string;
    packageId: number | null;
  }>;
  for (const file of files) {
    scopes.set(file.id, {
      family: resolverFamily(file.language),
      dir: file.dir,
      packageId: file.packageId,
      locals: new Map(),
      members: new Map(),
      bindings: new Map(),
      stars: [],
      visibleTypes: new Set(),
    });
  }
  const scopeOf = (fileId: number): FileScope => scopes.get(fileId) as FileScope;

  const push = (map: Map<string, number[]>, key: string, id: number) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(id);
    else map.set(key, [id]);
  };
  const exportTable = (fileId: number): Map<string, number> => {
    let table = exportsOf.get(fileId);
    if (!table) {
      table = new Map();
      exportsOf.set(fileId, table);
    }
    return table;
  };

  // Only index callable symbols. Putting interfaces/types into the candidate pool will make
  // `parse(x)` is connected to a type alias of the same name. Test cases and test suites are symbols composed according to the title,
  // `describe("startServer")` will have the same name as the startServer being tested, and it has file-level precedence, so if not excluded, it might take over the call.
  const symbols = db
    .prepare(
      `SELECT id, file_id AS fileId, name, container, exported, params, return_type AS returnType, signature
       FROM symbols
       WHERE kind IN ('function', 'method', 'class', 'struct', 'constructor', 'enum') AND test_kind IS NULL`,
    )
    .all() as Array<{
    id: number;
    fileId: number;
    name: string;
    container: string | null;
    exported: number;
    params: string | null;
    returnType: string | null;
    signature: string | null;
  }>;

  const callable = new Set<number>();
  const membersByKey = new Map<string, number[]>();
  const symbolInfo: RepoIndex["symbolInfo"] = new Map();
  for (const sym of symbols) {
    callable.add(sym.id);
    symbolInfo.set(sym.id, {
      fileId: sym.fileId,
      returnType: sym.returnType,
      params: sym.params && sym.params !== "[]" ? sym.params : null,
      signature: sym.signature,
    });
    const scope = scopeOf(sym.fileId);
    if (sym.container === null) {
      push(scope.locals, sym.name, sym.id);
      if (scope.family === "go") {
        let table = topLevelByDir.get(scope.dir);
        if (!table) {
          table = new Map();
          topLevelByDir.set(scope.dir, table);
        }
        push(table, sym.name, sym.id);
      }
      if (sym.exported === 1) {
        const table = exportTable(sym.fileId);
        if (!table.has(sym.name)) table.set(sym.name, sym.id);
        push(exportedByName, sym.name, sym.id);
      }
    } else {
      push(scope.members, `${sym.container}.${sym.name}`, sym.id);
      push(membersByKey, `${sym.container}.${sym.name}`, sym.id);
      push(methodsByName, sym.name, sym.id);
      containerOf.set(sym.id, sym.container);
    }
  }

  // Exports like `export { foo as bar }` and `export default foo` have export names that are inconsistent with their declared names.
  // Or the declaration itself doesn’t have the export keyword, so it can only be added from the export table.
  const exportRows = db
    .prepare("SELECT file_id AS fileId, name, kind, symbol_id AS symbolId FROM exports WHERE symbol_id IS NOT NULL")
    .all() as Array<{ fileId: number; name: string; kind: string; symbolId: number }>;
  for (const row of exportRows) {
    if (!callable.has(row.symbolId)) continue;
    if (row.kind === "default") {
      defaultExportOf.set(row.fileId, row.symbolId);
      continue;
    }
    const table = exportTable(row.fileId);
    if (!table.has(row.name)) table.set(row.name, row.symbolId);
  }

  // Check the type list separately once: As long as the callable symbols exist in the candidate pool above, but determine 'this class in this file'
  // Whether it is visible" needs to be counted together with interface/type, and the method hosts of Go and Rust are also included.
  const typeDecls = db
    .prepare(
      `SELECT id, file_id AS fileId, name, kind, container, signature FROM symbols
       WHERE kind IN ('class', 'interface', 'struct', 'trait', 'type', 'enum')`,
    )
    .all() as Array<TypeDecl & { container: string | null }>;
  const typesOf = new Map<number, Map<string, TypeDecl>>();
  const typesByDir = new Map<string, Map<string, TypeDecl>>();
  const typeById = new Map<number, TypeDecl>();
  for (const { container, ...decl } of typeDecls) {
    const scope = scopeOf(decl.fileId);
    scope.visibleTypes.add(decl.name);
    typeById.set(decl.id, decl);
    if (container !== null) continue;
    addType(typesOf, decl.fileId, decl);
    if (scope.family === "go") addType(typesByDir, scope.dir, decl);
  }

  // In the linking phase, linkTypeRelations was run first, and target_id was filled according to the global type name.
  // When the parent class is searched, the target is first re-parsed according to the import, and the id here is only used as a fallback.
  const parentsOf: RepoIndex["parentsOf"] = new Map();
  const implementersOf = new Map<number, number[]>();
  const relations = db
    .prepare(
      `SELECT subject_id AS subjectId, relation, target, target_id AS targetId, confidence
       FROM type_relations WHERE subject_id IS NOT NULL`,
    )
    .all() as Array<{ subjectId: number; relation: string; target: string; targetId: number | null; confidence: string }>;
  for (const rel of relations) {
    if (!typeById.has(rel.subjectId)) continue;
    const targetId = rel.confidence === "ambiguous" ? null : rel.targetId;
    if (rel.relation === "implements") {
      if (targetId === null) continue;
      const bucket = implementersOf.get(targetId);
      if (bucket) bucket.push(rel.subjectId);
      else implementersOf.set(targetId, [rel.subjectId]);
      continue;
    }
    const bucket = parentsOf.get(rel.subjectId);
    if (bucket) bucket.push({ target: rel.target, targetId });
    else parentsOf.set(rel.subjectId, [{ target: rel.target, targetId }]);
  }

  const specs = db
    .prepare(
      `SELECT i.file_id AS fileId, i.target_file_id AS targetFileId, i.target_dir AS targetDir,
              i.external_name AS externalName, s.imported, s.local,
              s.is_namespace AS isNamespace
       FROM import_specifiers s JOIN imports i ON i.id = s.import_id`,
    )
    .all() as Array<{
    fileId: number;
    targetFileId: number | null;
    targetDir: string | null;
    externalName: string | null;
    imported: string;
    local: string;
    isNamespace: number;
  }>;

  for (const spec of specs) {
    const scope = scopeOf(spec.fileId);
    if (spec.imported === "*" && spec.local === "*") {
      if (spec.targetFileId !== null) scope.stars.push(spec.targetFileId);
      continue;
    }
    scope.bindings.set(spec.local, {
      targetFileId: spec.targetFileId,
      targetDir: spec.targetDir,
      externalName: spec.externalName,
      imported: spec.imported,
      isNamespace: spec.isNamespace === 1,
    });
    scope.visibleTypes.add(spec.local);
  }

  return {
    scopes,
    exportsOf,
    defaultExportOf,
    exportedByName,
    topLevelByDir,
    methodsByName,
    containerOf,
    membersByKey,
    typesOf,
    typesByDir,
    typeById,
    parentsOf,
    implementersOf,
    symbolInfo,
    paramTypeCache: new Map(),
    importedExternals: new Set(
      (db.prepare("SELECT DISTINCT external_name AS name FROM imports WHERE external_name IS NOT NULL").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    ),
  };
}
