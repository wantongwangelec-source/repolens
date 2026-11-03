import type { Db } from "../db/database.js";
import type { FindingRow, IndexWriter } from "../db/writer.js";
import type { ArchitectureLock, ArchitectureRule, ConfirmedLayer } from "../types.js";
import { detectBypass, detectLayering, detectUnapproved } from "./conventions.js";
import { detectCoupling, detectStaleDocs } from "./drift.js";
import { evaluateRules, type RuleViolation } from "./rules.js";

/**
 * Architecture checkup: Identify structurally suspicious areas from the linked diagrams.
 *
 * The entire value of this layer lies in saving people's attention, so the criterion is always 'better to miss a report than to give a false alarm.'
 * A diagnosis that makes random claims is worse than no diagnosis—it consumes exactly the resources it is supposed to save.
 * And once you miss it once, you will never take a serious look at it a second time.
 *
 * Therefore, each criterion is written as 'what remains after excluding all the normal situations I can think of,'
 * Rather than 'matching a certain pattern.' In the comments for each detector below, it records what it excluded,
 * And it cannot be ruled out how many false alarms there might be in a real warehouse.
 *
 * They are all deterministic judgments and do not require LLM.
 */

export interface DiagnoseStats {
  duplicate: number;
  cycle: number;
  violation: number;
  oversized: number;
  unapproved: number;
  layering: number;
  bypass: number;
  coupling: number;
  staleDoc: number;
}

/** Written agreements: dependency rules, dependency lock, confirmed layering. All come from files submitted with the code. */
export interface DiagnosePolicy {
  rules?: readonly ArchitectureRule[];
  lock?: ArchitectureLock | null;
  layers?: readonly ConfirmedLayer[];
  /** Read the original document for reference; if not provided, do not check document citations */
  root?: string;
}

export function diagnose(db: Db, writer: IndexWriter, policy: DiagnosePolicy = {}): DiagnoseStats {
  const findings: FindingRow[] = [];

  const stats: DiagnoseStats = {
    duplicate: detectDuplicates(db, findings),
    cycle: detectCycles(db, findings),
    violation: detectViolations(db, policy.rules ?? [], findings),
    oversized: detectOversized(db, findings),
    unapproved: detectUnapproved(db, policy.lock ?? null, findings),
    layering: detectLayering(db, policy.layers ?? [], findings),
    bypass: detectBypass(db, findings),
    coupling: detectCoupling(db, findings),
    staleDoc: policy.root ? detectStaleDocs(db, policy.root, findings) : 0,
  };

  writer.insertFindings(findings);
  return stats;
}

// ---------------------------------------------------------------------------
// Repeated implementation
// ---------------------------------------------------------------------------

/**
 * Functions that have the same shape fingerprint but are scattered in different files.
 *
 * This is the most common structural problem after AI participates in coding: the same piece of logic is generated differently according to language and scenario.
 * Once, rather than extracting shared parts. Copying and pasting when people write code will also fall into this.
 *
 * Criteria are excluded in sequence:
 * - Groups that only appear in the same file — those are overloads or local helpers and do not constitute cross-file duplication
 * - Functions that are too small—shapes like `return x.length` are meaningless to collide, as tests show when no lower limit is set
 *   A medium-sized warehouse will report a few hundred sets of single-line getters
 * - Files of non-source code roles — it's normal for the setup functions in tests to look the same
 */
const MIN_DUPLICATE_COMPLEXITY = 2;
const MIN_DUPLICATE_LINES = 3;

function detectDuplicates(db: Db, out: FindingRow[]): number {
  const rows = db
    .prepare(
      `SELECT s.shape, s.id, s.name, s.container, s.complexity,
              (s.end_line - s.start_line + 1) AS lines,
              f.path, f.id AS fileId
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.shape IS NOT NULL
         AND f.role = 'source'
         AND s.kind IN ('function', 'method')
         AND s.complexity >= ${MIN_DUPLICATE_COMPLEXITY}
         AND (s.end_line - s.start_line + 1) >= ${MIN_DUPLICATE_LINES}`,
    )
    .all() as Array<{
    shape: string;
    id: number;
    name: string;
    container: string | null;
    complexity: number;
    lines: number;
    path: string;
    fileId: number;
  }>;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = groups.get(row.shape);
    if (bucket) bucket.push(row);
    else groups.set(row.shape, [row]);
  }

  let count = 0;
  for (const [shape, members] of groups) {
    if (members.length < 2) continue;
    // Only cross-file counts as duplication. Shapes that are the same within the same file are mostly overloads or paired small tools.
    const files = new Set(members.map((m) => m.fileId));
    if (files.size < 2) continue;

    const names = [...new Set(members.map((m) => m.name))];
    const key = `dup:${hashShape(shape)}`;
    const related = members.map((m) => `sym:${m.id}`);
    // Duplicates with the same name are more certainly meant to be merged; different names may just happen to be isomorphic.
    const severity = names.length === 1 ? "high" : "low";
    const label = names.length === 1 ? `${names[0]}()` : `${names[0]}() 等 ${names.length} 个名字`;
    const detail = members
      .map((m) => `${m.path}:${m.container ? `${m.container}.` : ""}${m.name}`)
      .join("\n");

    count++;
    // Each member hangs one, so that by clicking any point on the chart, you can see which group it belongs to.
    for (const member of members) {
      out.push({
        kind: "duplicate",
        severity,
        scopeKind: "symbol",
        scopeKey: `sym:${member.id}`,
        path: member.path,
        title: `${label} 在 ${files.size} 个文件里有结构相同的实现`,
        detail,
        related,
        groupKey: key,
      });
    }
  }

  return count;
}

/** The shape string can be very long, the grouping key only needs to be stable and short */
function hashShape(shape: string): string {
  let h = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Circular dependency
// ---------------------------------------------------------------------------

/**
 * Mutually imported same-level scopes.
 *
 * The key is to rule out ancestor/descendant relationships. It is normal for `core/src` and `core/src/db` to have edges between each other.
 * The structure includes (`index.ts` references `db/`, and `db/*` references `../types.ts`), it is not circular.
 * If we don't rule it out, out of the 43 pairs reported by pi, 38 pairs are this kind of false positive, accounting for 88%—so the diagnosis is just
 * Completely lost its meaning.
 *
 * Only make bidirectional direct loops. In real warehouses, long loops with more than three points often have 'one edge that really should be broken'.
 * But pointing out which edge is needed requires judgment far beyond static information, and even if it's reported, people don't know where to fix it.
 */
function detectCycles(db: Db, out: FindingRow[]): number {
  let count = 0;
  const packageDirs = new Map(
    (db.prepare("SELECT name, dir FROM packages").all() as Array<{ name: string; dir: string }>).map(
      (r) => [r.name, r.dir],
    ),
  );

  for (const level of ["package", "directory"] as const) {
    const pairs = db
      .prepare(
        `SELECT a.src AS src, a.dst AS dst, a.count AS forward, b.count AS backward
         FROM rollup_edges a
         JOIN rollup_edges b ON a.src = b.dst AND a.dst = b.src AND b.level = a.level AND b.type = a.type
         WHERE a.level = ? AND a.type = 'imports' AND a.src < a.dst`,
      )
      .all(level) as Array<{ src: string; dst: string; forward: number; backward: number }>;

    for (const pair of pairs) {
      if (level === "directory" && isNested(pair.src, pair.dst)) continue;

      const scopeKind = level === "package" ? "package" : "directory";
      const prefix = level === "package" ? "pkg" : "dir";
      const related = [`${prefix}:${pair.src}`, `${prefix}:${pair.dst}`];
      // The scope_key of the package is the package name, but the upstream needs to follow the directory prefix, so the path is checked separately.
      const dirOfScope = (key: string): string =>
        level === "package" ? (packageDirs.get(key) ?? key) : key;
      const detail =
        `${pair.src} → ${pair.dst}：${pair.forward} 处引用\n` +
        `${pair.dst} → ${pair.src}：${pair.backward} 处引用\n` +
        `引用少的那个方向通常就是该断开的那条边。`;

      count++;
      for (const [i, key] of [pair.src, pair.dst].entries()) {
        out.push({
          kind: "cycle",
          severity: level === "package" ? "high" : "medium",
          scopeKind,
          scopeKey: `${prefix}:${key}`,
          path: dirOfScope(key),
          title: `与 ${i === 0 ? pair.dst : pair.src} 相互依赖`,
          detail,
          related,
          groupKey: `cycle:${level}:${pair.src}\u0000${pair.dst}`,
        });
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Architecture rules
// ---------------------------------------------------------------------------

/**
 * For imports that violate the dependency restrictions in `.repolens.json`, there should be one entry per offending file.
 *
 * Hang by file rather than by import: a single file often contains several out-of-bounds references, and it’s the same when making changes.
 * Modify together; after rolling up, you can see at the package level which part the boundary overrun is concentrated in.
 */
function detectViolations(db: Db, rules: readonly ArchitectureRule[], out: FindingRow[]): number {
  let count = 0;
  for (const report of evaluateRules(db, rules)) {
    const byFile = new Map<number, RuleViolation[]>();
    for (const violation of report.violations) {
      const bucket = byFile.get(violation.fileId);
      if (bucket) bucket.push(violation);
      else byFile.set(violation.fileId, [violation]);
    }

    for (const [fileId, violations] of byFile) {
      const first = violations[0]!;
      const targets = [...new Set(violations.map((v) => v.target))];
      const lines = violations.map((v) => `${v.filePath}:${v.line} → ${v.target}${v.typeOnly ? "（仅类型）" : ""}`);
      const related = [
        `file:${fileId}`,
        ...new Set(violations.flatMap((v) => (v.targetFileId === null ? [] : [`file:${v.targetFileId}`]))),
      ];
      count++;
      out.push({
        kind: "violation",
        severity: report.rule.severity,
        scopeKind: "file",
        scopeKey: `file:${fileId}`,
        path: first.filePath,
        title: targets.length > 1
          ? `违反「${report.label}」：依赖 ${targets[0]} 等 ${targets.length} 个目标`
          : `违反「${report.label}」：依赖 ${targets[0]}`,
        detail: [report.rule.reason, ...lines].filter(Boolean).join("\n"),
        related,
        groupKey: `rule:${report.label}\u0000${first.filePath}`,
      });
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Overly large functions and files
// ---------------------------------------------------------------------------

/**
 * Functions and files that are hard to read: When humans review AI-generated code, these are the first areas to go out of control.
 *
 * Criteria are excluded in sequence:
 * - Functions that only grow and don't branch — purely layout components, a long series of field mappings, many lines but can be read at a glance.
 *   So the length needs to be considered together with the complexity. If you look at the number of lines alone, RepoLens will report an extra batch of form components by itself.
 * - The outer layer stretched by nested functions — complexity only counts the part of the function itself (see excludeNestedComplexity),
 *   Otherwise, a createApi full of inline routes will be reported as huge stones because of the branches in the handler.
 * - Large files like type declarations or dictionaries — the file needs to be long enough, and the total complexity of the functions high enough to count
 *
 * Threshold calibrated according to RepoLens itself (1,153 functions): reports 9 functions, 1 file,
 * These are all places where people naturally have to pause while reading.
 */
const COMPLEX_FUNCTION = 25;
const LONG_FUNCTION_LINES = 200;
const LONG_FUNCTION_MIN_COMPLEXITY = 10;
const LARGE_FILE_LOC = 1000;
const LARGE_FILE_MIN_COMPLEXITY = 100;

function detectOversized(db: Db, out: FindingRow[]): number {
  const functions = db
    .prepare(
      `SELECT s.id, s.name, s.container, s.complexity, s.start_line AS line,
              (s.end_line - s.start_line + 1) AS lines, f.path
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.role = 'source'
         AND s.kind IN ('function', 'method')
         AND (s.complexity >= ${COMPLEX_FUNCTION}
              OR ((s.end_line - s.start_line + 1) >= ${LONG_FUNCTION_LINES}
                  AND s.complexity >= ${LONG_FUNCTION_MIN_COMPLEXITY}))`,
    )
    .all() as Array<{ id: number; name: string; container: string | null; complexity: number; line: number; lines: number; path: string }>;

  for (const fn of functions) {
    const name = `${fn.container ? `${fn.container}.` : ""}${fn.name}`;
    const complex = fn.complexity >= COMPLEX_FUNCTION;
    out.push({
      kind: "oversized",
      severity: fn.complexity >= COMPLEX_FUNCTION * 2 || fn.lines >= LONG_FUNCTION_LINES * 2 ? "medium" : "low",
      scopeKind: "symbol",
      scopeKey: `sym:${fn.id}`,
      path: fn.path,
      title: complex
        ? `${name}() 分支过多：复杂度 ${fn.complexity}，${fn.lines} 行`
        : `${name}() 过长：${fn.lines} 行，复杂度 ${fn.complexity}`,
      detail: `${fn.path}:${fn.line}\n` + (complex
        ? `分支越多越难一眼看懂、也越难测全。按分支把逻辑拆成几个命名清楚的小函数，读的时候只需要看名字。`
        : `一个函数里装了太多步骤。按步骤拆开，每一步的名字就是这段流程的目录。`),
      related: [`sym:${fn.id}`],
      groupKey: `oversized:${fn.path}\u0000${name}`,
    });
  }

  // Only cumulative functions: each type declaration and constant is counted as 1. If totaled by file, a thousand types can reach the threshold.
  const files = db
    .prepare(
      `SELECT f.id, f.path, f.loc, COUNT(s.id) AS functions, SUM(s.complexity) AS complexity
       FROM files f JOIN symbols s ON s.file_id = f.id AND s.kind IN ('function', 'method')
       WHERE f.role = 'source' AND f.loc >= ${LARGE_FILE_LOC}
       GROUP BY f.id
       HAVING SUM(s.complexity) >= ${LARGE_FILE_MIN_COMPLEXITY}`,
    )
    .all() as Array<{ id: number; path: string; loc: number; functions: number; complexity: number }>;
  const largest = db.prepare(
    `SELECT name, container, (end_line - start_line + 1) AS lines FROM symbols
     WHERE file_id = ? AND kind IN ('function', 'method') ORDER BY lines DESC LIMIT 5`,
  );

  for (const file of files) {
    const top = largest.all(file.id) as Array<{ name: string; container: string | null; lines: number }>;
    out.push({
      kind: "oversized",
      severity: "low",
      scopeKind: "file",
      scopeKey: `file:${file.id}`,
      path: file.path,
      title: `文件过大：${file.loc} 行代码，${file.functions} 个函数，总复杂度 ${file.complexity}`,
      detail: `最长的几个函数，通常就是拆分的切口：\n` +
        top.map((s) => `${s.container ? `${s.container}.` : ""}${s.name}（${s.lines} 行）`).join("\n"),
      related: [`file:${file.id}`],
      groupKey: `oversized:${file.path}`,
    });
  }

  return functions.length + files.length;
}

/** whether a is an ancestor directory of b, or vice versa */
function isNested(a: string, b: string): boolean {
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`) || a === "." || b === ".";
}
