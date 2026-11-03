import type { Db } from "../db/database.js";

export interface TestCoverageStats {
  cases: number;
  /** At least one source code function covered by a test case */
  covered: number;
  /** Source code functions involved in statistics */
  functions: number;
}

/** If we go further, 'this use case is testing it' would just be an empty statement. */
const MAX_DEPTH = 4;
/** A test case can record at most this many symbols under test: integration testing can go as far as half a warehouse */
const MAX_REACH = 400;
const NEAREST = 6;

/**
 * Test coverage: Each test case follows the determined/possible calls downward, recording the source code symbols and levels it reaches.
 *
 * This is not runtime coverage; it is static 'who is testing it': when reading a function, first see which test cases directly call it,
 * How to write a test case title, that is a description of human-written behavior, more reliable than an AI summary. Passing through the test files in the middle
 * Helper functions are still counted, only recording the landing points in the source code.
 */
export function analyzeTests(db: Db): TestCoverageStats {
  db.exec("DELETE FROM test_coverage");
  const cases = (db.prepare("SELECT id FROM symbols WHERE test_kind = 'case'").all() as Array<{ id: number }>).map((row) => row.id);
  const functions = (db.prepare(
    `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND s.implemented = 1`,
  ).get() as { n: number }).n;
  if (cases.length === 0) return { cases: 0, covered: 0, functions };

  const adjacency = new Map<number, number[]>();
  for (const edge of db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>) {
    const bucket = adjacency.get(edge.from);
    if (bucket) bucket.push(edge.to); else adjacency.set(edge.from, [edge.to]);
  }
  const source = new Set((db.prepare(
    "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.role = 'source'",
  ).all() as Array<{ id: number }>).map((row) => row.id));

  const coverage = new Map<number, { tests: number; direct: number; nearest: Array<[number, number]> }>();
  for (const testId of cases) {
    const seen = new Set([testId]);
    let frontier = [testId];
    let reached = 0;
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && reached < MAX_REACH; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const target of adjacency.get(id) ?? []) {
          if (seen.has(target)) continue;
          seen.add(target);
          next.push(target);
          if (!source.has(target)) continue;
          reached++;
          let entry = coverage.get(target);
          if (!entry) {
            entry = { tests: 0, direct: 0, nearest: [] };
            coverage.set(target, entry);
          }
          entry.tests++;
          if (depth === 1) entry.direct++;
          if (entry.nearest.length < NEAREST || depth < entry.nearest.at(-1)![1]) {
            entry.nearest.push([testId, depth]);
            entry.nearest.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
            if (entry.nearest.length > NEAREST) entry.nearest.pop();
          }
        }
      }
      frontier = next;
    }
  }

  const insert = db.prepare("INSERT INTO test_coverage (symbol_id, tests, direct, nearest) VALUES (?, ?, ?, ?)");
  for (const [symbolId, entry] of coverage) insert.run(symbolId, entry.tests, entry.direct, JSON.stringify(entry.nearest));

  const covered = (db.prepare(
    `SELECT COUNT(*) AS n FROM test_coverage t JOIN symbols s ON s.id = t.symbol_id
     WHERE s.kind IN ('function', 'method') AND s.implemented = 1`,
  ).get() as { n: number }).n;
  return { cases: cases.length, covered, functions };
}
