import type {
  CallKind, Confidence, ControlBlock, EntryPointDto, IoKind, IoReachDto, Language, SymbolKind, UnresolvedReason, WalkCallDto,
  WalkFrameDto, WalkTargetDto,
} from "../types.js";
import type { Db } from "./database.js";
import { symbolKey } from "./queries.js";
import { getCachedSemantic, semanticLanguage } from "./semantic.js";

/** The name itself indicates it is a bypass call: logging, timing, instrumentation, assertions */
const SIDE_CHANNEL = /^(?:log|logger|debug|trace|info|warn|warning|error|verbose|time|timeEnd|timeLog|mark|measure|track|emit|report|metric|metrics|count|increment|gauge|histogram|span|assert|invariant|print|println|printf)$|^(?:log|trace|debug|track|record|emit)[A-Z_]|[a-z](?:Timings?|Metrics?)$/;
/** Small functions that are called everywhere and whose return values are unused are mostly side processes like timing and logging. */
const TRIVIAL_MAX_COMPLEXITY = 2;
const TRIVIAL_MAX_LINES = 12;
const TRIVIAL_MIN_CALLERS = 8;
/** The function body has only a few lines, and the only place it is called is forwarded as is, which is just a layer of forwarding. */
const FORWARD_MAX_LINES = 6;

interface EntryRow {
  id: number; kind: EntryPointDto["kind"]; framework: string | null; symbolId: number | null; fileId: number;
  filePath: string; fileRole: EntryPointDto["fileRole"]; line: number; label: string; method: string | null;
  route: string | null; confidence: "exact" | "likely"; evidence: string;
  reachSymbols: number; reachFiles: number; reachIo: string;
}

interface SymbolRow {
  id: number; name: string; container: string | null; kind: SymbolKind; fileId: number; filePath: string;
  language: Language; startLine: number; endLine: number; signature: string | null; hash: string;
}

interface CallRow {
  id: number; line: number; column: number; callee: string; receiver: string | null; receiverType: string | null;
  kind: CallKind; arguments: string; resolution: Confidence; targetId: number | null; targetName: string | null;
  candidates: string | null; io: IoKind | null; blocks: string | null; discarded: number;
}

interface TargetFacts {
  complexity: number;
  lines: number;
  callers: number;
}

/** Entrances that you can walk through are placed at the front; within the same type, the further down you go, the closer to the front it is: the deeper the entrance, the more worth examining individually. */
export function getEntryPoints(db: Db): EntryPointDto[] {
  return (db.prepare(
    `SELECT e.id, e.kind, e.framework, e.symbol_id AS symbolId, e.file_id AS fileId, f.path AS filePath,
            f.role AS fileRole, e.line, e.label, e.method, e.route, e.confidence, e.evidence,
            e.reach_symbols AS reachSymbols, e.reach_files AS reachFiles, e.reach_io AS reachIo
     FROM entry_points e JOIN files f ON f.id = e.file_id
     ORDER BY CASE WHEN e.symbol_id IS NOT NULL AND e.reach_symbols > 0 THEN 0 ELSE 1 END,
              CASE e.kind WHEN 'http' THEN 0 WHEN 'cli' THEN 1 WHEN 'main' THEN 2
                   WHEN 'public-api' THEN 3 WHEN 'test' THEN 4 ELSE 5 END,
              e.reach_files DESC, e.reach_symbols DESC, e.label, f.path, e.line`,
  ).all() as EntryRow[]).map((row) => ({
    id: `entry:${row.id}`, kind: row.kind, framework: row.framework,
    symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`, fileId: `file:${row.fileId}`,
    filePath: row.filePath, fileRole: row.fileRole, line: row.line, label: row.label, method: row.method,
    route: row.route, confidence: row.confidence, evidence: row.evidence,
    reachSymbols: row.reachSymbols, reachFiles: row.reachFiles,
    reachIo: row.reachIo === "" ? [] : (row.reachIo.split(",") as IoKind[]),
  }));
}

/**
 * A single-step read of a frame. Call by (starting line of expression, ending byte) row: when crossing lines, it is the reading order of the source code from top to bottom,
 * In the same line, the actual argument finishes before the outer call, so `openDb(indexPath(root))` calls indexPath first.
 * For chained calls across lines, the entire chain is counted as starting from the first line. `a
.b()
.c()` corresponds to b and c in order.
 */
export function getWalkFrame(db: Db, symbolId: number): WalkFrameDto | null {
  const symbol = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.file_id AS fileId, f.path AS filePath, f.language,
            s.start_line AS startLine, s.end_line AS endLine, s.signature, s.hash
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  ).get(symbolId) as SymbolRow | undefined;
  if (!symbol) return null;

  const rows = db.prepare(
    `SELECT id, CASE WHEN name_line > 0 THEN name_line ELSE line END AS line, name_col AS "column",
            callee_name AS callee, receiver, receiver_type AS receiverType, call_kind AS kind,
            argument_texts AS arguments, resolution, target_symbol_id AS targetId, target_name AS targetName,
            candidates, io_kind AS io, blocks, discarded
     FROM call_sites WHERE caller_symbol_id = ? ORDER BY call_sites.line, end_byte, id`,
  ).all(symbolId) as CallRow[];

  const candidateIds = new Map(rows.map((row) => [row.id, parseIds(row.candidates)]));
  const targetIds = [
    ...rows.flatMap((row) => (row.targetId === null ? [] : [row.targetId])),
    ...[...candidateIds.values()].flat(),
  ];
  const targets = loadTargets(db, targetIds);
  const facts = targetFacts(db, targetIds);
  const tables = tablesOf(db, rows.map((row) => row.id));
  const libraries = importedExternals(db, rows);
  const params = paramNames(db, symbolId);

  const calls: WalkCallDto[] = rows.map((row) => {
    const candidates = row.resolution === "ambiguous"
      ? (candidateIds.get(row.id) ?? []).flatMap((id) => targets.get(id) ?? [])
      : null;
    const fact = row.targetId === null ? undefined : facts.get(row.targetId);
    const discarded = row.discarded === 1;
    const trivial = discarded && !row.io && (
      SIDE_CHANNEL.test(row.callee) ||
      (fact !== undefined && fact.complexity <= TRIVIAL_MAX_COMPLEXITY && fact.lines <= TRIVIAL_MAX_LINES && fact.callers >= TRIVIAL_MIN_CALLERS)
    );
    const blocks = parseBlocks(row.blocks);
    return {
      id: `call:${row.id}`, line: row.line, column: row.column, callee: row.callee, receiver: row.receiver,
      kind: row.kind, arguments: parseStrings(row.arguments), resolution: row.resolution,
      target: row.targetId === null ? null : targets.get(row.targetId) ?? null,
      candidates: candidates && candidates.length > 0 ? candidates : null,
      external: row.targetName,
      ...(row.resolution === "external" && row.targetName !== null && !libraries.has(row.targetName)
        ? { builtin: true } : {}),
      unresolved: row.resolution === "unresolved" ? unresolvedReason(row, params) : null,
      io: row.io,
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(discarded ? { discarded } : {}),
      ...(trivial ? { trivial } : {}),
      ...(tables.has(row.id) ? { tables: tables.get(row.id) } : {}),
    };
  });

  return {
    id: `sym:${symbol.id}`, name: qualified(symbol), kind: symbol.kind, fileId: `file:${symbol.fileId}`,
    filePath: symbol.filePath, language: symbol.language, startLine: symbol.startLine, endLine: symbol.endLine,
    signature: symbol.signature, summary: shortSummary(db, symbol),
    reaches: loadReaches(db, [symbol.id]).get(symbol.id) ?? [], calls,
  };
}

/** Among the external names that appear in this frame, those that were imported from files are libraries; the rest are built into the language. */
function importedExternals(db: Db, rows: readonly CallRow[]): Set<string> {
  const names = [...new Set(rows.flatMap((row) => (row.resolution === "external" && row.targetName ? [row.targetName] : [])))];
  if (names.length === 0) return new Set();
  return new Set((db.prepare(
    `SELECT DISTINCT external_name AS name FROM imports WHERE external_name IN (${names.map(() => "?").join(",")})`,
  ).all(...names) as Array<{ name: string }>).map((row) => row.name));
}

/** Parameter name; the destructured parameter `{ onClose }: Props` contains the whole mode, and all the names inside are counted */
function paramNames(db: Db, symbolId: number): Set<string> {
  const row = db.prepare("SELECT params FROM symbols WHERE id = ?").get(symbolId) as { params: string | null } | undefined;
  try {
    const params = JSON.parse(row?.params ?? "[]") as Array<{ name?: string }>;
    return new Set(params.flatMap((param) => param.name?.match(/[A-Za-z_$][\w$]*/g) ?? []));
  } catch { return new Set(); }
}

function unresolvedReason(row: CallRow, params: ReadonlySet<string>): UnresolvedReason {
  const receiver = row.receiver ?? "";
  if (receiver === "") {
    const hint = row.receiverType ?? "";
    // Bare calls with type annotation hints are almost always function parameters like `onDone: () => void`.
    if (params.has(row.callee) || /^[PCT]:/.test(hint)) return { kind: "callback" };
    const source = hint.match(/^[RAD]:(.+)$/)?.[1];
    return {
      kind: "function-value",
      source: source ? `${source}()` : null,
      ...(hint.startsWith("D:") ? { destructured: true } : {}),
    };
  }
  if (receiver === "this" || receiver === "self") return { kind: "inherited" };
  if (receiver.includes("(")) return { kind: "chained" };
  const hint = row.receiverType ?? "";
  const source = hint.match(/^[RAD]:(.+)$/)?.[1];
  if (source) return { kind: "untyped", source: `${source}()` };
  return hint === "P:" ? { kind: "untyped", param: true } : { kind: "untyped" };
}

function loadTargets(db: Db, ids: readonly number[], followForwards = true): Map<number, WalkTargetDto> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  // "'Can still take a few steps' is consistent with the default caliber of the walk-through list: calls that can reach the warehouse, plus I/O access.
  const rows = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.file_id AS fileId, f.path AS filePath, f.language,
            s.start_line AS startLine, s.end_line AS endLine, s.signature, s.hash, s.complexity,
            (SELECT COUNT(*) FROM call_sites c WHERE c.caller_symbol_id = s.id
               AND (c.resolution IN ('exact', 'likely', 'ambiguous') OR c.io_kind IS NOT NULL)) AS steps,
            (SELECT tests FROM test_coverage t WHERE t.symbol_id = s.id) AS tests
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${placeholders})`,
  ).all(...unique) as Array<SymbolRow & { steps: number; complexity: number; tests: number | null }>;
  const reaches = loadReaches(db, unique);
  const forwards = followForwards ? forwardTargets(db, rows) : new Map<number, WalkTargetDto>();
  return new Map(rows.map((row) => [row.id, {
    id: `sym:${row.id}`, name: qualified(row), kind: row.kind, fileId: `file:${row.fileId}`,
    filePath: row.filePath, line: row.startLine, steps: row.steps, summary: shortSummary(db, row),
    reaches: reaches.get(row.id) ?? [], complexity: row.complexity, tests: row.tests ?? 0,
    ...(forwards.has(row.id) ? { forwardsTo: forwards.get(row.id) } : {}),
  }]));
}

/**
 * It's just a forwarding function (a few lines long, no branches, the only callable point is in the repository): stepping into it is equivalent to taking an extra step,
 * Directly tell people who is really doing the work. Only look at one level, don't trace all the way down.
 */
function forwardTargets(
  db: Db, rows: ReadonlyArray<{ id: number; startLine: number; endLine: number; complexity: number; steps: number }>,
): Map<number, WalkTargetDto> {
  const candidates = rows.filter((row) => row.steps === 1 && row.complexity === 1 && row.endLine - row.startLine + 1 <= FORWARD_MAX_LINES);
  if (candidates.length === 0) return new Map();
  const only = db.prepare(
    `SELECT target_symbol_id AS target FROM call_sites
     WHERE caller_symbol_id = ? AND resolution IN ('exact', 'likely') AND target_symbol_id IS NOT NULL LIMIT 2`,
  );
  const next = new Map<number, number>();
  for (const row of candidates) {
    const hits = only.all(row.id) as Array<{ target: number }>;
    if (hits.length === 1 && hits[0]!.target !== row.id) next.set(row.id, hits[0]!.target);
  }
  const resolved = loadTargets(db, [...next.values()], false);
  return new Map([...next].flatMap(([from, to]) => (resolved.has(to) ? [[from, resolved.get(to)!] as const] : [])));
}

function targetFacts(db: Db, ids: readonly number[]): Map<number, TargetFacts> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = db.prepare(
    `SELECT s.id, s.complexity, s.end_line - s.start_line + 1 AS lines,
            (SELECT COUNT(DISTINCT e.src_id) FROM edges e
             WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND e.dst_id = s.id) AS callers
     FROM symbols s WHERE s.id IN (${unique.map(() => "?").join(",")})`,
  ).all(...unique) as Array<{ id: number } & TargetFacts>;
  return new Map(rows.map((row) => [row.id, row]));
}

function tablesOf(db: Db, callIds: readonly number[]): Map<number, Array<{ name: string; write: boolean }>> {
  const out = new Map<number, Array<{ name: string; write: boolean }>>();
  if (callIds.length === 0) return out;
  const rows = db.prepare(
    `SELECT call_site_id AS id, table_name AS name, write FROM data_access
     WHERE call_site_id IN (${callIds.map(() => "?").join(",")}) ORDER BY write DESC, table_name`,
  ).all(...callIds) as Array<{ id: number; name: string; write: number }>;
  for (const row of rows) {
    const bucket = out.get(row.id) ?? [];
    bucket.push({ name: row.name, write: row.write === 1 });
    out.set(row.id, bucket);
  }
  return out;
}

function parseBlocks(raw: string | null): ControlBlock[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as ControlBlock[]) : [];
  } catch {
    return [];
  }
}

function loadReaches(db: Db, ids: readonly number[]): Map<number, IoReachDto[]> {
  const out = new Map<number, IoReachDto[]>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT symbol_id AS symbolId, kind, depth FROM io_reach
     WHERE symbol_id IN (${ids.map(() => "?").join(",")}) ORDER BY depth, kind`,
  ).all(...ids) as Array<{ symbolId: number; kind: IoKind; depth: number }>;
  for (const row of rows) {
    const bucket = out.get(row.symbolId);
    const item = { kind: row.kind, depth: row.depth };
    if (bucket) bucket.push(item); else out.set(row.symbolId, [item]);
  }
  return out;
}

function shortSummary(db: Db, symbol: SymbolRow): string | null {
  const key = symbolKey(symbol.filePath, symbol.container, symbol.name, symbol.startLine);
  return getCachedSemantic(db, "symbol", key, "tooltip-summary", semanticLanguage(db), symbol.hash)?.content ?? null;
}

function qualified(symbol: Pick<SymbolRow, "name" | "container">): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];
  } catch { return []; }
}

function parseStrings(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
