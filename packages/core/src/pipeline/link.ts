import type { Db } from "../db/database.js";
import type { EdgeRow, IndexWriter, RollupEdgeRow, SearchRow } from "../db/writer.js";
import { dirOf } from "../resolve/path-utils.js";
import type { Confidence, HttpLinkStats } from "../types.js";
import { analyzeDataAccess } from "./data-access.js";
import { type DiagnosePolicy, type DiagnoseStats, diagnose } from "./diagnose.js";
import { linkHttpEdges } from "./http-links.js";
import { analyzeEntries, type EntryAnalysisStats } from "./entries.js";
import { linkCallEdges } from "./link-calls.js";
import { analyzeTests, type TestCoverageStats } from "./tests.js";

export interface LinkStats {
  calls: number;
  callsByConfidence: Record<Confidence, number>;
  findings: DiagnoseStats;
  entries: EntryAnalysisStats;
  http: HttpLinkStats;
  tests: TestCoverageStats;
}

/**
 * Linking phase: Turn the raw facts in the database into a graph.
 *
 * Recalculate everything instead of incremental updates, because a change in one import may affect edges arbitrarily far away—
 * Maintaining correctness incrementally is far more expensive than recalculating once. All the input for recalculation is in SQLite.
 * There is no need to re-parse the source code; at a scale of 400,000 lines, it is a second-level operation.
 */
export function linkGraph(db: Db, writer: IndexWriter, policy: DiagnosePolicy = {}): LinkStats {
  writer.clearDerived();

  linkImportEdges(db, writer);
  // Method calls need to follow extends/implements to find the parent class or implementing class, so the type relationship is resolved first.
  linkTypeRelations(db);
  const calls = linkCallEdges(db, (edges) => writer.insertEdges(edges));
  const entries = analyzeEntries(db);
  // The routing table comes from ingress identification, so it is placed after ingress analysis; consequently, I/O reachability will not cross network boundaries.
  const http = linkHttpEdges(db, writer);
  const tests = analyzeTests(db);
  analyzeDataAccess(db);
  buildSearchIndex(db, writer);
  // The physical examination needs to be run after the rollup is built, and the loop check reads that table.
  const findings = diagnose(db, writer, policy);

  return { calls: calls.callSites, callsByConfidence: calls.byConfidence, findings, entries, http, tests };
}

// ---------------------------------------------------------------------------
// import edge
// ---------------------------------------------------------------------------

interface ImportEdgeSource {
  fileId: number;
  filePath: string;
  filePackage: string | null;
  targetFileId: number | null;
  targetPath: string | null;
  targetPackage: string | null;
  targetDir: string | null;
  externalName: string | null;
  confidence: Confidence;
  isTypeOnly: number;
  fileRole: string;
  targetRole: string | null;
}

function linkImportEdges(db: Db, writer: IndexWriter): void {
  const rows = db
    .prepare(
      `SELECT
         i.file_id        AS fileId,
         sf.path          AS filePath,
         sf.role          AS fileRole,
         tf.role          AS targetRole,
         sp.name          AS filePackage,
         i.target_file_id AS targetFileId,
         tf.path          AS targetPath,
         tp.name          AS targetPackage,
         i.target_dir     AS targetDir,
         i.external_name  AS externalName,
         i.confidence     AS confidence,
         i.is_type_only   AS isTypeOnly
       FROM imports i
       JOIN files sf ON sf.id = i.file_id
       LEFT JOIN packages sp ON sp.id = sf.package_id
       LEFT JOIN files tf ON tf.id = i.target_file_id
       LEFT JOIN packages tp ON tp.id = tf.package_id`,
    )
    .all() as ImportEdgeSource[];

  // Multiple imports between the same pair of files are merged into a single edge, with the weight recorded as the number of times
  const fileEdges = new Map<string, EdgeRow>();
  const externalEdges = new Map<string, EdgeRow>();
  const dirRollup = new Map<string, RollupEdgeRow>();
  const pkgRollup = new Map<string, RollupEdgeRow>();

  // `import type` only exists at compile time, recorded as references rather than imports:
  // When the frontend only imports types from the backend, a runtime dependency should not appear in the architecture diagram.
  // Circular detection should not report 'mutually referencing types' as a module cycle.
  const bumpRollup = (
    store: Map<string, RollupEdgeRow>,
    level: "directory" | "package",
    src: string,
    dst: string,
    typeOnly: boolean,
  ) => {
    if (src === dst) return;
    const type = typeOnly ? "references" : "imports";
    const key = `${src}\u0000${dst}\u0000${type}`;
    const existing = store.get(key);
    if (existing) {
      existing.count++;
      existing.weight++;
      return;
    }
    store.set(key, { level, type, src, dst, confidence: "exact", count: 1, weight: 1 });
  };

  for (const row of rows) {
    const typeOnly = row.isTypeOnly === 1;
    if (row.targetFileId !== null && row.targetPath !== null) {
      const key = `${row.fileId}->${row.targetFileId}`;
      const existing = fileEdges.get(key);
      if (existing) {
        existing.weight++;
        if (!typeOnly) existing.type = "imports";
      } else {
        fileEdges.set(key, {
          type: typeOnly ? "references" : "imports",
          srcKind: "file",
          srcId: row.fileId,
          dstKind: "file",
          dstId: row.targetFileId,
          dstName: null,
          confidence: "exact",
          line: null,
          callKind: null,
          candidates: null,
          weight: 1,
        });
      }
      // The edges between directories/packages describe the architecture of the product code: tests and scripts import the module under test,
      // It will cause the architecture diagram to have extra reverse edges and make the cycle detection report non-existent module loops.
      if (row.fileRole === "source" && row.targetRole === "source") {
        bumpRollup(dirRollup, "directory", dirOf(row.filePath), dirOf(row.targetPath), typeOnly);
        if (row.filePackage !== null && row.targetPackage !== null) {
          bumpRollup(pkgRollup, "package", row.filePackage, row.targetPackage, typeOnly);
        }
      }
      continue;
    }

    if (row.targetDir !== null) {
      // Go's import is at the package level, tied to the directory; it does not expand into edges for each individual file.
      // Otherwise, an import would generate as many edges as there are files in the package out of thin air.
      if (row.fileRole === "source") bumpRollup(dirRollup, "directory", dirOf(row.filePath), row.targetDir, typeOnly);
      continue;
    }

    if (row.externalName !== null) {
      const key = `${row.fileId}->ext:${row.externalName}`;
      const existing = externalEdges.get(key);
      if (existing) {
        existing.weight++;
        continue;
      }
      externalEdges.set(key, {
        type: "imports",
        srcKind: "file",
        srcId: row.fileId,
        dstKind: "external",
        dstId: null,
        dstName: row.externalName,
        confidence: "external",
        line: null,
        callKind: null,
        candidates: null,
        weight: 1,
      });
    }
  }

  writer.insertEdges([...fileEdges.values(), ...externalEdges.values()]);
  writer.insertRollupEdges([...dirRollup.values(), ...pkgRollup.values()]);
}

// ---------------------------------------------------------------------------
// Type relationship
// ---------------------------------------------------------------------------

/**
 * Resolve the target names of `extends` / `implements` / `embeds` to concrete symbols.
 *
 * Here, global exported symbol name matching is used, without tracking the import chain: the type name is in a single repository.
 * The probability of name collision is much lower than that of function names, and when the candidate is not unique, it will degrade to ambiguous.
 * Will not produce an edge that looks definite.
 */
function linkTypeRelations(db: Db): void {
  const typeSymbols = db
    .prepare(
      `SELECT id, name FROM symbols
       WHERE kind IN ('class', 'interface', 'struct', 'trait', 'type', 'enum')`,
    )
    .all() as Array<{ id: number; name: string }>;

  const byName = new Map<string, number[]>();
  for (const sym of typeSymbols) {
    const bucket = byName.get(sym.name);
    if (bucket) bucket.push(sym.id);
    else byName.set(sym.name, [sym.id]);
  }

  const update = db.prepare(
    "UPDATE type_relations SET target_id = @targetId, confidence = @confidence WHERE id = @id",
  );
  const relations = db
    .prepare("SELECT id, target FROM type_relations")
    .all() as Array<{ id: number; target: string }>;

  for (const rel of relations) {
    const candidates = byName.get(rel.target);
    if (!candidates || candidates.length === 0) {
      update.run({ id: rel.id, targetId: null, confidence: "external" });
      continue;
    }
    if (candidates.length === 1) {
      update.run({ id: rel.id, targetId: candidates[0], confidence: "likely" });
      continue;
    }
    update.run({ id: rel.id, targetId: candidates[0], confidence: "ambiguous" });
  }
}

// ---------------------------------------------------------------------------
// Search Index
// ---------------------------------------------------------------------------

function buildSearchIndex(db: Db, writer: IndexWriter): void {
  const rows: SearchRow[] = [];

  // Packages and directories do not have 'roles'; they are all treated as source: they are structures, not content.
  // Should not disappear from search just because of the noise switch
  for (const pkg of db.prepare("SELECT name, dir FROM packages").all() as Array<{
    name: string;
    dir: string;
  }>) {
    rows.push({
      label: pkg.name,
      detail: pkg.dir,
      kind: "package",
      ref: `pkg:${pkg.name}`,
      role: "source",
    });
  }

  for (const dir of db
    .prepare("SELECT path, name FROM directories WHERE file_count > 0")
    .all() as Array<{ path: string; name: string }>) {
    rows.push({
      label: dir.name,
      detail: dir.path,
      kind: "directory",
      ref: `dir:${dir.path}`,
      role: "source",
    });
  }

  for (const file of db.prepare("SELECT id, path, name, role FROM files").all() as Array<{
    id: number;
    path: string;
    name: string;
    role: string;
  }>) {
    rows.push({
      label: file.name,
      detail: file.path,
      kind: "file",
      ref: `file:${file.id}`,
      role: file.role,
    });
  }

  for (const sym of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, f.path, f.role
       FROM symbols s JOIN files f ON f.id = s.file_id`,
    )
    .all() as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    path: string;
    role: string;
  }>) {
    const qualified = sym.container !== null ? `${sym.container}.${sym.name}` : sym.name;
    rows.push({
      label: qualified,
      detail: `${sym.kind} · ${sym.path}`,
      kind: "symbol",
      ref: `sym:${sym.id}`,
      role: sym.role,
    });
  }

  writer.insertSearchRows(rows);
}
