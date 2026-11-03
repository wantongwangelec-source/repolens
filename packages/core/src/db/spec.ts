import type { SpecCaseDto, SpecDto, TestCoverageDto, TestRefDto } from "../types.js";
import type { Db } from "./database.js";
import { inBatches, resolveScope, scopeFunctions } from "./scope.js";

/** Consistent with the coverage depth in the linking phase */
const MAX_DEPTH = 4;
/** The reverse diffusion goes through at most this many functions: the callers of hotspot functions can number in the hundreds. */
const MAX_VISITED = 20_000;

/** Test cases that can reach these symbols (propagating backward along definite/possible calls) */
export function casesReaching(db: Db, symbolIds: readonly number[]): Map<number, number> {
  const found = new Map<number, number>();
  if (symbolIds.length === 0) return found;
  const callers = db.prepare(
    `SELECT e.src_id AS id, s.test_kind AS testKind FROM edges e JOIN symbols s ON s.id = e.src_id
     WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol'
       AND e.confidence IN ('exact', 'likely') AND e.dst_id = ?`,
  );
  const seen = new Set(symbolIds);
  let frontier = [...symbolIds];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && seen.size < MAX_VISITED; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const row of callers.all(id) as Array<{ id: number; testKind: string | null }>) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (row.testKind === "case") found.set(row.id, depth);
        else next.push(row.id);
      }
    }
    frontier = next;
  }
  return found;
}

/** Test coverage of a symbol: the number of test cases and the few test cases closest to it */
export function testCoverageOf(db: Db, symbolId: number): TestCoverageDto | null {
  const row = db.prepare("SELECT tests, direct, nearest FROM test_coverage WHERE symbol_id = ?").get(symbolId) as
    | { tests: number; direct: number; nearest: string } | undefined;
  if (!row) return null;
  return { total: row.tests, direct: row.direct, nearest: testRefs(db, parsePairs(row.nearest)) };
}

/** Use case symbol → Use case entry, with the title of the outer use case group */
export function testRefs(db: Db, pairs: ReadonlyArray<[number, number]>): TestRefDto[] {
  if (pairs.length === 0) return [];
  const symbol = db.prepare(
    `SELECT s.id, s.name, s.start_line AS line, s.start_byte AS startByte, s.end_byte AS endByte, s.file_id AS fileId, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );
  return pairs.flatMap(([id, depth]) => {
    const row = symbol.get(id) as { id: number; name: string; line: number; startByte: number; endByte: number; fileId: number; path: string } | undefined;
    if (!row) return [];
    return [{ id: `sym:${row.id}`, name: row.name, suite: suiteOf(db, row.fileId, row.startByte, row.endByte), path: row.path, line: row.line, depth }];
  });
}

/** The test case group that covers this test case is connected from outside to inside with › */
function suiteOf(db: Db, fileId: number, startByte: number, endByte: number): string | null {
  const suites = db.prepare(
    `SELECT name FROM symbols WHERE file_id = ? AND test_kind = 'suite'
       AND start_byte <= ? AND end_byte >= ? ORDER BY start_byte`,
  ).all(fileId, startByte, endByte) as Array<{ name: string }>;
  return suites.length > 0 ? suites.map((s) => s.name).join(" › ") : null;
}

/**
 * A behavioral specification of a piece of code: the test cases closest to the functions inside it, organized by test file and test case group.
 * The title of a use case is what a person writes as 'how it should be,' which is more reliable than an AI summary; glance here before reading a module.
 */
export function getSpec(db: Db, nodeId: string): SpecDto | null {
  const scope = resolveScope(db, nodeId);
  if (!scope) return null;
  const functions = scope.symbolId !== null
    ? [{ id: scope.symbolId }]
    : [...scopeFunctions(db, scope), ...classesIn(db, scope.files)];
  const names = new Map<number, string>();
  const nameOf = db.prepare("SELECT name, container FROM symbols WHERE id = ?");
  const cases = new Map<number, { depth: number; targets: Set<string> }>();
  const coverage = inBatches(functions.map((f) => f.id), (batch) => db.prepare(
    `SELECT symbol_id AS id, nearest FROM test_coverage WHERE symbol_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; nearest: string }>);
  for (const row of coverage) {
    if (!names.has(row.id)) {
      const symbol = nameOf.get(row.id) as { name: string; container: string | null } | undefined;
      names.set(row.id, symbol ? (symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name) : "?");
    }
    for (const [caseId, depth] of parsePairs(row.nearest)) {
      const entry = cases.get(caseId) ?? { depth, targets: new Set<string>() };
      entry.depth = Math.min(entry.depth, depth);
      entry.targets.add(names.get(row.id)!);
      cases.set(caseId, entry);
    }
  }

  const refs = testRefs(db, [...cases].map(([id, entry]) => [id, entry.depth] as [number, number]));
  const files = new Map<string, Map<string | null, SpecCaseDto[]>>();
  const fileIds = new Map<string, string>();
  const fileIdOf = db.prepare("SELECT f.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?");
  for (const ref of refs) {
    const suites = files.get(ref.path) ?? new Map<string | null, SpecCaseDto[]>();
    files.set(ref.path, suites);
    if (!fileIds.has(ref.path)) fileIds.set(ref.path, `file:${(fileIdOf.get(Number(ref.id.slice(4))) as { id: number }).id}`);
    const list = suites.get(ref.suite) ?? [];
    list.push({ id: ref.id, name: ref.name, line: ref.line, depth: ref.depth, targets: [...cases.get(Number(ref.id.slice(4)))!.targets].slice(0, 4) });
    suites.set(ref.suite, list);
  }
  return {
    cases: refs.length,
    files: [...files]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, suites]) => ({
        id: fileIds.get(path)!,
        path,
        suites: [...suites]
          .map(([name, list]) => ({ name, cases: list.sort((a, b) => a.line - b.line) }))
          .sort((a, b) => (a.cases[0]?.line ?? 0) - (b.cases[0]?.line ?? 0)),
      })),
  };
}

function classesIn(db: Db, files: ReadonlySet<number>): Array<{ id: number }> {
  return inBatches([...files], (batch) => db.prepare(
    `SELECT id FROM symbols WHERE kind IN ('class', 'struct') AND file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number }>);
}

function parsePairs(raw: string): Array<[number, number]> {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((pair): pair is [number, number] => Array.isArray(pair) && Number.isInteger(pair[0]) && Number.isInteger(pair[1]))
      : [];
  } catch {
    return [];
  }
}
